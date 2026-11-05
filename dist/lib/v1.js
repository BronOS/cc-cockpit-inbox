'use strict'
// Inbox 0.1.0's ranking and settings, kept only while the v1 host (dist/host.js) and its settings view
// still run on them; task 29 of the redesign plan (host v2) deletes this file. New code uses
// lib/rules.js and lib/settings.js.

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

// The item key (one rule with state.js and rules.js).
const { keyOf } = require('./rules')

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

// Inbox's settings (design "Ranking", "Done and snooze", "Panel"; the mock-up's settings view).
// They live in ctx.appStorage under one key, not in a manifest settings schema: the source rows are
// per provider (keyed by plugin id, providers come and go), which a fixed schema cannot list, and
// one inbox means one set of rules in every window. Read through `readSettings` every time: a value
// of the wrong type or out of range is replaced by its default, unknown keys are dropped, so a bad
// write (an older or newer Inbox, a hand edit) never breaks the panel. A provider that left keeps
// its row, so uninstalling and reinstalling Chat brings its count and weight back.

const KEY = 'settings'
const MAX_SOURCES = 50
// A plugin id as the app allows it, without `_`, so `__proto__` and friends never become keys.
const PLUGIN_ID = /^[a-z0-9][a-z0-9.-]{0,127}$/i

/** Items per source by `kind` (decision 4: 10 / 10 / 8). */
const KIND_ITEMS = Object.freeze({ chat: 10, mail: 10, issues: 8, other: 10 })
/** Weights by `kind` (DEFAULT_RULES.kindWeights; repeated for the settings view). */
const KIND_WEIGHTS = Object.freeze({ chat: 30, mail: 15, issues: 0, other: 0 })

const POSITIONS = ['top', 'bottom', 'inline', 'beside', 'off']
const BADGES = ['urgent', 'action', 'all', 'off']
const TIMELINES = ['auto', 'work']
const AFTERNOONS = ['12:00', '13:00', '14:00', '15:00', '16:00']
const MORNINGS = ['07:00', '08:00', '09:00', '10:00']

const DEFAULTS = Object.freeze({
  sources: Object.freeze({}),
  levels: Object.freeze({ urgent: 300, action: 150, fyi: 50 }),
  unread: 10,
  direct: 20,
  due: 25,
  agePerHour: 5,
  ageCap: 40,
  dedupeJira: true,
  doneMarksRead: true,
  doneReturns: true,
  afternoon: '14:00',
  morning: '09:00',
  notifySnooze: true,
  // The Read chip: how many read messages to ask each source for, and to list in all.
  readItems: 20,
  badge: 'urgent',
  calendar: Object.freeze({ position: 'top', upcoming: 3, pinMinutes: 30, timeline: 'auto' }),
})

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined)
const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d)
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const oneOf = (v, list, d) => (list.includes(v) ? v : d)

/** One source row: `{ on, items?, weight? }`; items and weight absent mean "the kind's default". */
function sourceRow(raw) {
  const out = { on: bool(own(raw, 'on'), true) }
  const items = int(own(raw, 'items'), 1, 50, undefined)
  if (items !== undefined) out.items = items
  const weight = int(own(raw, 'weight'), -1000, 1000, undefined)
  if (weight !== undefined) out.weight = weight
  return out
}

/** The settings, whole and valid, from whatever was stored (undefined: all defaults). */
function readSettings(raw) {
  const sources = {}
  const rawSources = own(raw, 'sources')
  if (isObj(rawSources)) {
    for (const id of Object.keys(rawSources).slice(0, MAX_SOURCES)) {
      if (PLUGIN_ID.test(id)) sources[id] = sourceRow(rawSources[id])
    }
  }
  const lv = own(raw, 'levels')
  const cal = own(raw, 'calendar')
  const D = DEFAULTS
  return {
    sources,
    levels: {
      urgent: int(own(lv, 'urgent'), -1000, 1000, D.levels.urgent),
      action: int(own(lv, 'action'), -1000, 1000, D.levels.action),
      fyi: int(own(lv, 'fyi'), -1000, 1000, D.levels.fyi),
    },
    unread: int(own(raw, 'unread'), -500, 500, D.unread),
    direct: int(own(raw, 'direct'), -500, 500, D.direct),
    due: int(own(raw, 'due'), -500, 500, D.due),
    agePerHour: int(own(raw, 'agePerHour'), 0, 100, D.agePerHour),
    ageCap: int(own(raw, 'ageCap'), 0, 1000, D.ageCap),
    dedupeJira: bool(own(raw, 'dedupeJira'), D.dedupeJira),
    doneMarksRead: bool(own(raw, 'doneMarksRead'), D.doneMarksRead),
    doneReturns: bool(own(raw, 'doneReturns'), D.doneReturns),
    afternoon: oneOf(own(raw, 'afternoon'), AFTERNOONS, D.afternoon),
    morning: oneOf(own(raw, 'morning'), MORNINGS, D.morning),
    notifySnooze: bool(own(raw, 'notifySnooze'), D.notifySnooze),
    readItems: int(own(raw, 'readItems'), 1, 50, D.readItems),
    badge: oneOf(own(raw, 'badge'), BADGES, D.badge),
    calendar: {
      position: oneOf(own(cal, 'position'), POSITIONS, D.calendar.position),
      upcoming: int(own(cal, 'upcoming'), 0, 10, D.calendar.upcoming),
      pinMinutes: int(own(cal, 'pinMinutes'), 5, 240, D.calendar.pinMinutes),
      timeline: oneOf(own(cal, 'timeline'), TIMELINES, D.calendar.timeline),
    },
  }
}

async function loadSettings(store) {
  return readSettings(await store.get(KEY))
}

/** Validate and store; resolves what was stored. */
async function saveSettings(store, raw) {
  const s = readSettings(raw)
  await store.set(KEY, s)
  return s
}

/** The effective row of one source: on, items and weight with its kind's defaults filled in. */
function sourceOf(settings, pluginId, kind) {
  const row = Object.hasOwn(settings.sources, pluginId) ? settings.sources[pluginId] : { on: true }
  const k = Object.hasOwn(KIND_ITEMS, kind) ? kind : 'other'
  return {
    on: row.on,
    items: row.items ?? KIND_ITEMS[k],
    weight: row.weight ?? KIND_WEIGHTS[k],
    weightSet: row.weight !== undefined,
  }
}

/** The ranking rules from the settings (only weights the person set; the rest come from the kind). */
function rulesOf(settings) {
  const weights = {}
  for (const [id, row] of Object.entries(settings.sources)) if (row.weight !== undefined) weights[id] = row.weight
  return {
    levels: { ...settings.levels },
    weights,
    unread: settings.unread,
    direct: settings.direct,
    due: settings.due,
    agePerHour: settings.agePerHour,
    ageCap: settings.ageCap,
    dedupeJira: settings.dedupeJira,
  }
}

module.exports = {
  // ranking
  DEFAULT_RULES,
  rank,
  score,
  weightOf,
  pinnedEvent,
  NO_STATE,
  // settings
  KEY,
  DEFAULTS,
  KIND_ITEMS,
  KIND_WEIGHTS,
  POSITIONS,
  BADGES,
  TIMELINES,
  AFTERNOONS,
  MORNINGS,
  readSettings,
  loadSettings,
  saveSettings,
  sourceOf,
  rulesOf,
}
