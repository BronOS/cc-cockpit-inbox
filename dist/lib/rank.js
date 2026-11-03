'use strict'
// Inbox's own ranking (design "Ranking"): score = level + source weight + boosts − age, highest
// first. The level decides across sources (an urgent Jira "PROD down" beats a Chat action item
// although Chat weighs more) because the levels are 150 apart and the weights are smaller; a weight
// the person sets above that gap makes its source win across levels, which is their choice. Pure:
// the host passes the sources, the rules, the clock and what the done/snooze state says.

const HOUR = 3600000
const DAY = 24 * HOUR

/** The defaults (design table). Weights come per provider; a provider with none set gets its kind's. */
const DEFAULT_RULES = Object.freeze({
  levels: Object.freeze({ urgent: 300, action: 150, fyi: 50 }),
  kindWeights: Object.freeze({ chat: 30, mail: 15, issues: 0, other: 0 }),
  weights: Object.freeze({}),
  unread: 10,
  direct: 20,
  due: 25,
  dueDays: 2,
  agePerHour: 5,
  ageCap: 40,
  dedupeJira: true,
  // A snooze that ended brings its item back at the top for the rest of the day (state.js says when).
  snoozeBack: 500,
})

const LEVEL_NAMES = { urgent: 'urgent', action: 'action', fyi: 'fyi' }

/** The weight of a source: the person's per-provider value, else its kind's default. */
function weightOf(source, rules) {
  const w = Object.hasOwn(rules.weights, source.pluginId) ? rules.weights[source.pluginId] : undefined
  if (Number.isFinite(w)) return w
  const k = rules.kindWeights[source.kind]
  return Number.isFinite(k) ? k : 0
}

/** Whole hours since `at`, for the age penalty (an item without a time has no age). */
function hoursOld(at, now) {
  return at === null || at === undefined || at > now ? 0 : Math.floor((now - at) / HOUR)
}

const fmtAge = (h) => (h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`)

/**
 * The score of one item and the "why" line the panel shows ("urgent 300 · chat +30 · unread +10 ·
 * 2 h −10 = 330"). `extra` is a bonus the state gives (a snooze that just ended).
 */
function score(item, source, rules, now, extra = 0) {
  const parts = []
  let total = rules.levels[item.level]
  parts.push(`${LEVEL_NAMES[item.level]} ${total}`)
  const w = weightOf(source, rules)
  total += w
  parts.push(`${source.label.toLowerCase()} ${w >= 0 ? '+' : '−'}${Math.abs(w)}`)
  if (item.unread && rules.unread) {
    total += rules.unread
    parts.push(`unread +${rules.unread}`)
  }
  if ((item.direct || item.mentionsMe) && rules.direct) {
    total += rules.direct
    parts.push(`${item.direct ? 'direct' : 'mention'} +${rules.direct}`)
  }
  if (item.dueAt !== undefined && rules.due && item.dueAt - now <= rules.dueDays * DAY) {
    total += rules.due
    parts.push(item.dueAt < now ? `overdue +${rules.due}` : `due soon +${rules.due}`)
  }
  const h = hoursOld(item.at, now)
  const age = Math.min(h * rules.agePerHour, rules.ageCap)
  if (age > 0) {
    total -= age
    parts.push(`${fmtAge(h)} −${age}`)
  }
  if (extra) {
    total += extra
    parts.push(`snooze ended +${extra}`)
  }
  return { score: total, why: `${parts.join(' · ')} = ${total}` }
}

/** The state key of an item: one app-storage key per item (state.js encodes it). */
const keyOf = (pluginId, id) => `${pluginId}\u0000${id}`

/**
 * The list the panel shows.
 * - `sources`: `[{ pluginId, label, badge, color, kind, items }]` (items checked by feed.js, already
 *   cut to the source's own item count by the host), only sources that are on.
 * - `state`: `{ hidden(key, item) -> boolean, extra(key, item) -> number, back(key, item) -> boolean }`
 *   from state.js (done or snoozed, a snooze that ended, a done item back with something new).
 * - `cal`: `{ position, pinMinutes, events }` for the calendar pin (position "inline").
 * Returns `{ rows, hiddenByDedupe }`: rows best first; noise never shows.
 */
function rank(sources, rules, now, state = NO_STATE, cal = null) {
  const r = { ...DEFAULT_RULES, ...rules }
  const rows = []
  for (const s of sources) {
    for (const it of s.items) {
      if (it.level === 'noise' || !Object.hasOwn(r.levels, it.level)) continue
      const key = keyOf(s.pluginId, it.id)
      if (state.hidden(key, it)) continue
      const extra = state.extra(key, it) || 0
      const { score: sc, why } = score(it, s, r, now, extra)
      rows.push({
        key,
        pluginId: s.pluginId,
        id: it.id,
        rev: it.rev,
        badge: s.badge,
        color: s.color,
        label: s.label,
        kind: s.kind,
        title: it.title,
        from: it.from,
        where: it.where,
        at: it.at,
        level: it.level,
        unread: it.unread,
        ...(it.jiraKey ? { jiraKey: it.jiraKey } : {}),
        ...(state.back(key, it) ? { back: true } : {}),
        score: sc,
        why,
      })
    }
  }
  // Dedupe: a mail or chat item about an issue that an issues source lists is the same work twice.
  // The issue stays and counts the others ("+1 mail").
  let hiddenByDedupe = 0
  let out = rows
  if (r.dedupeJira) {
    const issues = new Map()
    for (const row of rows) if (row.kind === 'issues') issues.set(row.id, row)
    out = []
    for (const row of rows) {
      const issue = row.kind !== 'issues' && row.jiraKey ? issues.get(row.jiraKey) : undefined
      if (issue) {
        issue.also = (issue.also || 0) + 1
        hiddenByDedupe++
      } else out.push(row)
    }
  }
  out.sort((a, b) => b.score - a.score || (b.at ?? -Infinity) - (a.at ?? -Infinity) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const pin = cal && cal.position === 'inline' ? pinnedEvent(cal.events, now, cal.pinMinutes) : null
  if (pin) {
    // Under the urgent items: a meeting about to start matters more than any action item, less than
    // a fire.
    const at = out.findIndex((row) => row.level !== 'urgent')
    out.splice(at < 0 ? out.length : at, 0, pin)
  }
  return { rows: out, hiddenByDedupe }
}

/** The next event as a CAL row, from `pinMinutes` before its start until its end; declined or all-day events never. */
function pinnedEvent(events, now, pinMinutes) {
  const next = (events || []).find((e) => !e.allDay && e.response !== 'declined' && e.end > now && e.start - now <= pinMinutes * 60000)
  if (!next) return null
  const mins = Math.round((next.start - now) / 60000)
  return {
    key: `cal\u0000${next.id}`,
    pluginId: null,
    id: next.id,
    calendar: true,
    badge: 'CAL',
    color: 'amber',
    label: 'Calendar',
    kind: 'calendar',
    title: mins > 0 ? `${next.title} starts in ${mins} min` : `${next.title} is on now`,
    from: 'Calendar',
    where: next.meetUrl ? 'Meet' : '',
    at: next.start,
    level: 'action',
    unread: false,
    ...(next.meetUrl ? { meetUrl: next.meetUrl } : {}),
    score: null,
    why: `starts within ${pinMinutes} min: pinned under the urgent items`,
  }
}

const NO_STATE = Object.freeze({ hidden: () => false, extra: () => 0, back: () => false })

module.exports = { DEFAULT_RULES, rank, score, weightOf, keyOf, pinnedEvent, NO_STATE }
