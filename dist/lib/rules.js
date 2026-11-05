'use strict'
// Inbox v2's rules (design-v2 "Rules"): an ordered list, the first enabled rule that holds puts the
// item in its group, none holds → Rest ("no rule"). Within a group: newest `time` first, then source,
// then id, so the same items and rules always give the same list (the whole point of v2: v1's scores
// moved items around for reasons nobody could see).
//
// - A rule has field conditions (`when`, all must hold), one Jev question (`jev`), or both (decided
//   question 4): with both, the conditions are a pre-filter checked first and Jev is asked only for
//   items that pass, so "Jev: is this urgent?" can be limited to mail without paying for every chat.
// - Comparisons are case-insensitive over NFKC lower case, plain equality, substring and prefix. No
//   regular expressions: the values come from a settings page and run over every item (the app's
//   ReDoS rule for plugin settings).
// - Jev answers come from an injected `jevAnswer(rule, item)` (lib/jev.js keeps the cache and the
//   batching): `{ score }`, `'pending'` or `'unavailable'`; anything else is treated as unavailable.
//   A pending or unavailable Jev rule does not hold and evaluation goes on past it; the placement
//   says so ("Jev…", "rule 3 skipped: Jev unavailable").
// - Pure: the clock comes in as `now`, the source's kind through `kindOf(pluginId)`. Done and snooze
//   are the host's (it leaves hidden items out before calling).

const REST = 'rest'
const KINDS = ['chat', 'mail', 'issues', 'other']
const TO = ['direct', 'group', 'cc', 'none']
const MAX_MINUTES = 525600
const MAX_VALUE = 200
const MAX_IN = 50
const MINUTE = 60000

/**
 * The field table: which ops each field takes and what its value is.
 * `value`: `text` (a string, 1-200), `kind` / `to` (one of a fixed list), `bool`, `read` (true, false
 * or null), `minutes` (whole number 1..525600). An `in` op takes a list (1-50) of the field's value.
 */
const FIELDS = Object.freeze({
  source: { ops: ['is', 'isNot', 'in'], value: 'text' },
  sourceKind: { ops: ['is', 'isNot', 'in'], value: 'kind' },
  title: { ops: ['contains', 'notContains', 'startsWith', 'is'], value: 'text' },
  preview: { ops: ['contains', 'notContains', 'startsWith', 'is'], value: 'text' },
  'from.name': { ops: ['is', 'contains', 'endsWith', 'in'], value: 'text' },
  'from.address': { ops: ['is', 'contains', 'endsWith', 'in'], value: 'text' },
  to: { ops: ['is', 'in'], value: 'to' },
  mentionsMe: { ops: ['is'], value: 'bool' },
  read: { ops: ['is'], value: 'read' },
  'place.kind': { ops: ['is', 'contains', 'in'], value: 'text' },
  'place.name': { ops: ['is', 'contains', 'in'], value: 'text' },
  'place.status': { ops: ['is', 'contains', 'in'], value: 'text' },
  labels: { ops: ['has', 'hasNot', 'hasPrefix'], value: 'text' },
  time: { ops: ['newerThan', 'olderThan'], value: 'minutes' },
})

// The item key: one rule for the sort, the traces, the host and state.js (lib/util.js).
const { keyOf } = require('./util')

/** Case-insensitive form of a string: NFKC then lower case (a full-width "ＡＢＣ" matches "abc"). */
const norm = (s) => String(s).normalize('NFKC').toLowerCase()

/** One value of a condition, checked against its kind; undefined when it does not fit. */
function oneValue(kind, v) {
  switch (kind) {
    case 'text': {
      if (typeof v !== 'string') return undefined
      const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
      return s.length >= 1 && s.length <= MAX_VALUE ? s : undefined
    }
    case 'kind':
      return KINDS.includes(v) ? v : undefined
    case 'to':
      return TO.includes(v) ? v : undefined
    case 'bool':
      return typeof v === 'boolean' ? v : undefined
    case 'read':
      return v === true || v === false || v === null ? v : undefined
    case 'minutes':
      return Number.isInteger(v) && v >= 1 && v <= MAX_MINUTES ? v : undefined
    default:
      return undefined
  }
}

/**
 * A condition as stored, clean (`{ field, op, value }`), or null when any part does not fit the
 * table. The caller drops the whole rule then: dropping only the bad condition would make the rule
 * hold for more items than the person wrote it for.
 */
function conditionOf(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const field = Object.hasOwn(raw, 'field') ? raw.field : undefined
  const op = Object.hasOwn(raw, 'op') ? raw.op : undefined
  if (typeof field !== 'string' || !Object.hasOwn(FIELDS, field)) return null
  const spec = FIELDS[field]
  if (!spec.ops.includes(op)) return null
  const v = Object.hasOwn(raw, 'value') ? raw.value : undefined
  if (op === 'in') {
    if (!Array.isArray(v) || v.length < 1 || v.length > MAX_IN) return null
    const list = []
    for (const x of v) {
      const one = oneValue(spec.value, x)
      if (one === undefined) return null
      if (!list.some((y) => norm(y) === norm(one))) list.push(one)
    }
    return { field, op, value: list }
  }
  const one = oneValue(spec.value, v)
  return one === undefined ? null : { field, op, value: one }
}

/** The item's value for a field (the source's kind from `kind`); undefined when the item has none. */
function fieldOf(item, field, kind) {
  switch (field) {
    case 'source':
      return item.source
    case 'sourceKind':
      return kind
    case 'title':
    case 'preview':
      return item[field]
    case 'from.name':
    case 'from.address':
      return item.from ? item.from[field.slice(5)] : undefined
    case 'to':
      return item.to || 'none'
    case 'mentionsMe':
      return item.mentionsMe === true
    case 'read':
      return item.read === true || item.read === false ? item.read : null
    case 'place.kind':
    case 'place.name':
    case 'place.status':
      return item.place ? item.place[field.slice(6)] : undefined
    case 'labels':
      return Array.isArray(item.labels) ? item.labels : []
    case 'time':
      return item.time
    default:
      return undefined
  }
}

// A condition's value, normalised once (NFKC + lower case): `holds` runs per item per condition, and an
// `in` list can hold 50 values, so normalising there costs millions of calls per refresh at the caps.
const wants = new WeakMap()
function wantOf(cond) {
  let w = wants.get(cond)
  if (w === undefined) {
    w = Array.isArray(cond.value) ? cond.value.map(norm) : norm(cond.value)
    wants.set(cond, w)
  }
  return w
}

/** Whether one condition holds for an item at `now`. */
function holds(cond, item, kind, now) {
  const actual = fieldOf(item, cond.field, kind)
  const { op, value } = cond
  if (cond.field === 'time') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return false
    const age = now - actual
    return op === 'newerThan' ? age < value * MINUTE : age > value * MINUTE
  }
  if (cond.field === 'labels') {
    const want = wantOf(cond)
    if (op === 'hasPrefix') return actual.some((l) => norm(l).startsWith(want))
    const has = actual.some((l) => norm(l) === want)
    return op === 'has' ? has : !has
  }
  if (typeof value === 'boolean' || value === null) return actual === value
  // Text (and the enum fields, compared the same way). An absent field contains nothing, so it
  // holds only for the negative ops.
  const a = typeof actual === 'string' ? norm(actual) : null
  const w = wantOf(cond)
  switch (op) {
    case 'is':
      return a !== null && a === w
    case 'isNot':
      return a === null || a !== w
    case 'in':
      return a !== null && w.includes(a)
    case 'contains':
      return a !== null && a.includes(w)
    case 'notContains':
      return a === null || !a.includes(w)
    case 'startsWith':
      return a !== null && a.startsWith(w)
    case 'endsWith':
      return a !== null && a.endsWith(w)
    default:
      return false
  }
}

/** A condition as the row's reason says it: `from.address is lead@example.com`, `to in direct, group`. */
function conditionText(cond) {
  const v = Array.isArray(cond.value) ? cond.value.map(String).join(', ') : String(cond.value)
  return `${cond.field} ${cond.op} ${v}`
}

/** What the item has for the condition's field, short, for the trace ("was: false"). */
function actualText(cond, item, kind, now) {
  const a = fieldOf(item, cond.field, kind)
  if (a === undefined) return 'none'
  if (Array.isArray(a)) return a.length ? a.join(', ').slice(0, 80) : 'none'
  if (cond.field === 'time') return `${Math.max(0, Math.round((now - a) / MINUTE))} min ago`
  return String(a).slice(0, 80)
}

/** A Jev answer as rules take it: `{ score }` with a number 0..1, `'pending'`, else `'unavailable'`. */
function answerOf(raw) {
  if (raw === 'pending') return 'pending'
  if (raw && typeof raw === 'object' && typeof raw.score === 'number' && Number.isFinite(raw.score) && raw.score >= 0 && raw.score <= 1) return { score: raw.score }
  return 'unavailable'
}

/**
 * One rule against one item: `{ result, detail, score? }` where `result` is `held`, `failed` (a
 * condition or the Jev threshold did not hold), `pending` or `unavailable` (Jev). `detail` says which
 * part decided.
 */
function checkRule(rule, item, o) {
  const conds = rule.when || []
  for (const c of conds) {
    if (!holds(c, item, o.kind, o.now)) return { result: 'failed', detail: `${conditionText(c)} (was: ${actualText(c, item, o.kind, o.now)})` }
  }
  if (!rule.jev) return { result: 'held', detail: conds.map(conditionText).join(' and ') }
  let raw
  try {
    raw = typeof o.jevAnswer === 'function' ? o.jevAnswer(rule, item) : 'unavailable'
  } catch {
    raw = 'unavailable'
  }
  const ans = answerOf(raw)
  if (ans === 'pending') return { result: 'pending', detail: 'Jev…' }
  if (ans === 'unavailable') return { result: 'unavailable', detail: 'Jev unavailable' }
  const jevText = `Jev ${ans.score.toFixed(2)}`
  const pre = conds.length ? `${conds.map(conditionText).join(' and ')} and ` : ''
  if (ans.score >= rule.jev.min) return { result: 'held', detail: `${pre}${jevText}`, score: ans.score }
  return { result: 'failed', detail: `${jevText} below ${rule.jev.min}`, score: ans.score }
}

/** The options every evaluation takes: `now`, `kindOf(pluginId)`, `jevAnswer(rule, item)`. */
function optsFor(item, o) {
  let kind = 'other'
  try {
    const k = typeof o.kindOf === 'function' ? o.kindOf(item.source) : item.sourceKind
    if (KINDS.includes(k)) kind = k
  } catch {}
  return { kind, now: Number.isFinite(o.now) ? o.now : Date.now(), jevAnswer: o.jevAnswer }
}

/**
 * Where one item goes: `{ group, rule, ruleId, reason, jev }`.
 * - `rule`: the placing rule's position (1-based, counting disabled rules: the number the settings
 *   page shows), null for Rest by no rule.
 * - `reason`: `rule 3: Jev 0.86`, `rule 1: from.address is lead@example.com` (the rule's name instead
 *   when it has one), `no rule`; a Jev rule skipped on the way is added ("· rule 2 skipped: Jev
 *   unavailable").
 * - `jev`: `'pending'` when a Jev rule before the placing one is waiting for its answer (the row
 *   shows "Jev…"; the item moves once when it comes), else null.
 */
function placeItem(settings, item, opts = {}) {
  return walk(settings, item, optsFor(item, opts)).placement
}

/**
 * One pass over the rules: the placement and one step per rule. Both come from the same checks, so
 * the trace never disagrees with the row (a Jev answer can change between two separate passes).
 */
function walk(settings, item, o) {
  const groups = new Set(settings.groups.map((g) => g.id))
  const notes = []
  const steps = []
  let jev = null
  let placement = null
  settings.rules.forEach((rule, i) => {
    const step = { rule: i + 1, id: rule.id, name: rule.name || null, group: rule.group }
    if (placement) return void steps.push({ ...step, result: 'not checked', detail: '' })
    if (!rule.enabled) return void steps.push({ ...step, result: 'disabled', detail: '' })
    const r = checkRule(rule, item, o)
    steps.push({ ...step, result: r.result, detail: r.detail })
    if (r.result === 'pending') {
      jev = 'pending'
      notes.push(`rule ${i + 1}: Jev…`)
    } else if (r.result === 'unavailable') notes.push(`rule ${i + 1} skipped: Jev unavailable`)
    if (r.result !== 'held') return
    const what = rule.name ? rule.name : r.detail
    placement = {
      group: groups.has(rule.group) ? rule.group : REST,
      rule: i + 1,
      ruleId: rule.id,
      reason: [`rule ${i + 1}: ${what}`, ...notes].join(' · '),
      jev,
      ...(r.score !== undefined ? { score: r.score } : {}),
    }
  })
  if (!placement) placement = { group: REST, rule: null, ruleId: null, reason: ['no rule', ...notes].join(' · '), jev }
  return { placement, steps }
}

/**
 * The full trace for `ccc inbox why`: one line per rule, in order, with what happened:
 * `held`, `failed` (and why), `disabled`, `pending`, `unavailable`, `not checked` (after the placing
 * rule). Same pass as `placeItem` (`walk`), so the trace never disagrees with the row.
 */
function traceItem(settings, item, opts = {}) {
  const { placement, steps } = walk(settings, item, optsFor(item, opts))
  return { placement, steps, text: traceText(steps, placement, settings) }
}

function traceText(steps, placement, settings) {
  const nameOf = (id) => (settings.groups.find((g) => g.id === id) || { name: id }).name
  const lines = steps.map((s) => {
    const label = s.name ? ` (${s.name})` : ''
    const detail = s.detail ? `: ${s.detail}` : ''
    return `rule ${s.rule}${label} → ${nameOf(s.group)}: ${s.result}${detail}`
  })
  lines.push(`placed in ${nameOf(placement.group)}: ${placement.reason}`)
  return lines.join('\n')
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** The order within a group: newest `time` first, then source, then id. */
function byTime(a, b) {
  return b.item.time - a.item.time || cmp(String(a.item.source), String(b.item.source)) || cmp(String(a.item.id), String(b.item.id))
}

/**
 * Every item placed: `{ groups: [{ id, name, collapsed, badge, rows: [{ key, item, placement }] }],
 * byKey: Map }`. Groups in the settings' order (Rest last), each group's rows ordered by `byTime`.
 * `items` are feed items with `source` set (the store's); hidden ones (Done, snoozed) are left out by
 * the caller.
 */
function placeAll(settings, items, opts = {}) {
  const groups = settings.groups.map((g) => ({ ...g, rows: [] }))
  // settings.js always ends the list with Rest; a hand-built list without it still places everything.
  if (!groups.some((g) => g.id === REST)) groups.push({ id: REST, name: 'Rest', collapsed: true, badge: false, rows: [] })
  const at = new Map(groups.map((g) => [g.id, g]))
  const byKey = new Map()
  for (const item of items) {
    const placement = placeItem(settings, item, opts)
    const row = { key: keyOf(item.source, item.id), item, placement }
    byKey.set(row.key, row)
    ;(at.get(placement.group) || at.get(REST)).rows.push(row)
  }
  for (const g of groups) g.rows.sort(byTime)
  return { groups, byKey }
}

module.exports = {
  REST,
  KINDS,
  TO,
  FIELDS,
  MAX_IN,
  MAX_VALUE,
  MAX_MINUTES,
  keyOf,
  norm,
  conditionOf,
  conditionText,
  holds,
  answerOf,
  checkRule,
  placeItem,
  traceItem,
  placeAll,
  byTime,
}
