'use strict'
// What the providers answer, checked and capped (design "The feed contract" and "The calendar
// contract"). Every provider is another plugin, so its answers are untrusted input: a value of the
// wrong type is dropped (or the whole answer turns into a source error), strings are cut, arrays
// capped, unknown fields left out, and nothing here ever throws on a hostile answer. The panel
// renders every string as text; colours are names from a fixed palette, never CSS.

const CAPS = { items: 50, title: 300, from: 120, where: 120, label: 24, badge: 6, id: 300, rev: 300, message: 300, events: 100, upcoming: 20 }
const LEVELS = new Set(['urgent', 'action', 'fyi', 'noise'])
const COLORS = new Set(['green', 'red', 'blue', 'amber', 'violet', 'grey'])
const KINDS = new Set(['chat', 'mail', 'issues', 'other'])
const STATES = new Set(['ok', 'signedOut', 'error'])
const RESPONSES = new Set(['accepted', 'tentative', 'declined', 'needsAction'])
// An issue key as Jira writes it (Gmail and Chat pass it through as `jiraKey`): it is matched
// against Jira items for the dedupe, so anything else is dropped.
const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9}$/

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A one-line string cut to `max` (control characters and newlines become spaces), or null. */
function text(v, max) {
  if (typeof v !== 'string') return null
  const one = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
/** A finite number in a sane ms range (after 2000, before 2200), or null. */
function ms(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 946684800000 && v < 7258118400000 ? v : null
}
/** An own property only (a hostile answer can't reach `__proto__` or a getter on the prototype). */
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined)

/** `describe()`'s answer, or a fallback built from the plugin id (a provider that answers junk still shows). */
function describeOf(raw, pluginId) {
  const fallback = { label: text(String(pluginId).split('.').pop() || 'Source', CAPS.label), badge: 'FEED', color: 'grey', kind: 'other' }
  if (!isObj(raw)) return fallback
  const label = text(own(raw, 'label'), CAPS.label)
  const badge = text(own(raw, 'badge'), CAPS.badge)
  const color = own(raw, 'color')
  const kind = own(raw, 'kind')
  return {
    label: label || fallback.label,
    badge: (badge || fallback.badge).toUpperCase(),
    color: COLORS.has(color) ? color : 'grey',
    kind: KINDS.has(kind) ? kind : 'other',
  }
}

/** One FeedItem, or null when its required fields are missing or of the wrong type. */
function itemOf(raw) {
  if (!isObj(raw)) return null
  const id = text(own(raw, 'id'), CAPS.id)
  const title = text(own(raw, 'title'), CAPS.title)
  const level = own(raw, 'level')
  if (!id || title === null || !LEVELS.has(level)) return null
  const out = {
    id,
    rev: text(own(raw, 'rev'), CAPS.rev) || '',
    title,
    from: text(own(raw, 'from'), CAPS.from) || '',
    where: text(own(raw, 'where'), CAPS.where) || '',
    at: ms(own(raw, 'at')),
    level,
    unread: own(raw, 'unread') === true,
    direct: own(raw, 'direct') === true,
    mentionsMe: own(raw, 'mentionsMe') === true,
  }
  const due = ms(own(raw, 'dueAt'))
  if (due !== null) out.dueAt = due
  const key = own(raw, 'jiraKey')
  if (typeof key === 'string' && JIRA_KEY.test(key)) out.jiraKey = key
  return out
}

/**
 * `items()`'s answer: `{ items, asOf, state, message }`. A malformed answer is a source error with
 * no items (the host then keeps the last good items, marked stale). Duplicate ids keep the first.
 */
function itemsOf(raw) {
  if (!isObj(raw) || !Array.isArray(own(raw, 'items'))) return { items: [], asOf: null, state: 'error', message: 'the source answered something Inbox cannot read' }
  const seen = new Set()
  const items = []
  for (const r of own(raw, 'items').slice(0, CAPS.items)) {
    const it = itemOf(r)
    if (!it || seen.has(it.id)) continue
    seen.add(it.id)
    items.push(it)
  }
  const state = own(raw, 'state')
  const message = text(own(raw, 'message'), CAPS.message)
  return { items, asOf: ms(own(raw, 'asOf')), state: STATES.has(state) ? state : 'ok', ...(message ? { message } : {}) }
}

/** One CalEvent, or null. `meetUrl` only when it is an https URL. */
function eventOf(raw) {
  if (!isObj(raw)) return null
  const id = text(own(raw, 'id'), CAPS.id)
  const start = ms(own(raw, 'start'))
  const end = ms(own(raw, 'end'))
  if (!id || start === null || end === null || end < start) return null
  const response = own(raw, 'response')
  const out = {
    id,
    title: text(own(raw, 'title'), CAPS.title) || '(busy)',
    start,
    end,
    allDay: own(raw, 'allDay') === true,
    response: RESPONSES.has(response) ? response : null,
  }
  const meet = httpsUrl(own(raw, 'meetUrl'))
  if (meet) out.meetUrl = meet
  return out
}

/** An https URL of at most 2048 characters with no credentials, as `ctx.openExternal` takes it, or null. */
function httpsUrl(v) {
  if (typeof v !== 'string' || v.length > 2048) return null
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null
  } catch {
    return null
  }
}

/** `day()`'s answer: `{ date, events, tomorrow: { count, first? }, state, message? }`, events sorted by start. */
function calDayOf(raw) {
  if (!isObj(raw) || !Array.isArray(own(raw, 'events'))) return { date: null, events: [], tomorrow: { count: 0 }, state: 'error', message: 'the calendar answered something Inbox cannot read' }
  const events = own(raw, 'events').slice(0, CAPS.events).map(eventOf).filter(Boolean).sort((a, b) => a.start - b.start)
  const t = own(raw, 'tomorrow')
  const count = isObj(t) && Number.isInteger(own(t, 'count')) && own(t, 'count') >= 0 ? Math.min(own(t, 'count'), 999) : 0
  const first = isObj(t) ? eventOf(own(t, 'first')) : null
  const date = text(own(raw, 'date'), 10)
  const state = own(raw, 'state')
  const message = text(own(raw, 'message'), CAPS.message)
  return {
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    events,
    tomorrow: first ? { count, first } : { count },
    state: STATES.has(state) ? state : 'ok',
    ...(message ? { message } : {}),
  }
}

/** `upcoming()`'s answer: at most 20 events, sorted by start; junk is an empty list. */
function calUpcomingOf(raw) {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, CAPS.upcoming).map(eventOf).filter(Boolean).sort((a, b) => a.start - b.start)
}

/** `features()`'s answer as a set of known names. */
function featuresOf(raw) {
  return new Set(Array.isArray(raw) ? raw.filter((f) => f === 'markRead' || f === 'recent' || f === 'markUnread') : [])
}

module.exports = { CAPS, describeOf, itemOf, itemsOf, eventOf, calDayOf, calUpcomingOf, featuresOf, httpsUrl }
