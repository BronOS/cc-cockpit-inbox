'use strict'
// The Inbox panel's decisions, free of the DOM so node:test can check them (test/panel.test.js
// requires this file; the page loads it as a classic script before main.js, where these become
// globals). main.js only turns these models into elements, every provider string through
// textContent. (As bronos.calendar's rowlogic.js.)

const FYI_LIMIT = 9 // rows shown before "Show all" (design "Ranking")
const COLORS = ['green', 'red', 'blue', 'amber', 'violet', 'grey']
const TRI = { urgent: 'URGENT', action: 'ACT', fyi: 'FYI' }

/** A palette name as a class (`c-green`); anything else is grey (the host checked it already). */
function colorClass(c) {
  return `c-${COLORS.includes(c) ? c : 'grey'}`
}

/** "now", "4m", "2h", "3d" since `at`; "" without a time. */
function ageText(at, now) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  const m = Math.floor((now - at) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 24 * 60) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / (24 * 60))}d`
}

/** `14:05` local. */
function clockText(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The rows a filter shows: all (with the calendar pin), or one source's. */
function filterRows(rows, filter) {
  if (!Array.isArray(rows)) return []
  return filter === 'all' || !filter ? rows : rows.filter((r) => r.pluginId === filter)
}

/**
 * The list as drawn: `{ items: [{ row, divider }], rest }`. The first 9 unless `showAll`; the FYI
 * divider above the first fyi item shown; `rest` is how many "Show all" would add.
 */
function listModel(rows, filter, showAll, limit = FYI_LIMIT) {
  const all = filterRows(rows, filter)
  const shown = showAll ? all : all.slice(0, limit)
  const fyiAt = shown.findIndex((r) => r.level === 'fyi')
  return { items: shown.map((row, i) => ({ row, divider: i === fyiAt })), rest: all.length - shown.length, total: all.length }
}

/** The chips: All, one per source (its count, its colour, a mark when it has a problem), Done & snoozed. */
function chipsModel(state) {
  const chips = (state && state.chips) || []
  const rows = (state && state.rows) || []
  return [
    { filter: 'all', label: 'All', count: rows.filter((r) => !r.calendar).length },
    ...chips.map((c) => ({ filter: c.pluginId, label: c.label, count: c.count, color: c.color, problem: Boolean(c.problem) })),
    { filter: 'off', label: 'Done & snoozed', count: ((state && state.today) || []).length, done: true },
  ]
}

/** The error lines above the list: one per source with a problem, then the calendar's. */
function problemLines(state) {
  const out = []
  for (const c of (state && state.chips) || []) {
    if (!c.problem) continue
    out.push(c.stale && c.asOf ? `${c.problem} (showing the items from ${clockText(c.asOf)})` : c.problem)
  }
  if (state && state.calendar && state.calendar.problem) out.push(state.calendar.problem)
  return out
}

/** What the second line of a row says: triage label, from · where, "+1 mail", "back: new reply". */
function rowModel(r, now) {
  if (r.calendar) {
    return { tri: 'ACT', triClass: 'action', title: r.title, meta: r.where ? `Calendar · ${r.where}` : 'Calendar', age: clockText(r.at), calendar: true, join: Boolean(r.meetUrl) }
  }
  const meta = [r.from, r.where].filter(Boolean).join(' · ')
  const extra = []
  if (r.also) extra.push(`+${r.also} related`)
  if (r.back) extra.push('back: new reply')
  return {
    tri: TRI[r.level] || '',
    triClass: r.level,
    title: r.title,
    meta: extra.length ? `${meta}${meta ? ' · ' : ''}${extra.join(' · ')}` : meta,
    age: ageText(r.at, now),
    unread: Boolean(r.unread),
    back: Boolean(r.back),
    why: r.why || '',
  }
}

/** A Done & snoozed row: its age line and what happens next. */
function offModel(e, now) {
  if (e.kind === 'done') return { title: e.title, badge: e.badge, when: `done ${clockText(e.at)}`, note: 'comes back when it changes' }
  const until = e.until === null || e.until === undefined ? 'until it changes' : `until ${dayClock(e.until, now)}`
  return { title: e.title, badge: e.badge, when: `snoozed ${until}`, note: e.until ? 'comes back at the top when the time is up' : 'comes back when it changes' }
}

/** `14:00` today, `tomorrow 9:00`, `Thu 9:00` later. */
function dayClock(ms, now) {
  const d = new Date(ms)
  const n = new Date(now)
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const t = clockText(ms)
  if (sameDay(d, n)) return t
  const tm = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1)
  if (sameDay(d, tm)) return `tomorrow ${t}`
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${t}`
}

/** The snooze menu: the four choices with their labels (the afternoon one says "tomorrow" once it passed). */
function snoozeChoices(settings, now) {
  const aft = (settings && settings.afternoon) || '14:00'
  const morn = (settings && settings.morning) || '09:00'
  const [h, m] = aft.split(':').map(Number)
  const d = new Date(now)
  const passed = d.getHours() * 60 + d.getMinutes() >= h * 60 + m
  return [
    { choice: '1h', label: '1 hour', key: '1' },
    { choice: 'afternoon', label: passed ? `Tomorrow afternoon, ${aft}` : `This afternoon, ${aft}`, key: '2' },
    { choice: 'tomorrow', label: `Tomorrow ${morn.replace(/^0/, '')}`, key: '3' },
    { choice: 'changes', label: 'Until it changes', key: '4' },
  ]
}

/**
 * Where the calendar block goes: 'top', 'bottom', 'side' (only when the panel is wide; else top),
 * or null (off, in the list: the pin row is the calendar then, or no calendar at all).
 */
function calendarPlacement(state, wide) {
  const c = state && state.calendar
  if (!c) return null
  if (c.position === 'top' || c.position === 'bottom') return c.position
  if (c.position === 'beside') return wide ? 'side' : 'top'
  return null
}

/**
 * A key press in the list: `ui` is `{ sel, menu }`, `keys` the selectable row keys in order,
 * `rows` by key (to know a calendar row). Returns an action or null:
 * `{ type: 'select', key }`, `open`, `done`, `menu`, `snooze` (with `choice`), `closeMenu`, `undo`.
 */
function keyAction(ui, key, keys, rowOf, mods) {
  if (mods && (mods.alt || mods.ctrl || mods.meta)) return null
  if (ui.menu) {
    const choice = { 1: '1h', 2: 'afternoon', 3: 'tomorrow', 4: 'changes' }[key]
    if (choice) return { type: 'snooze', key: ui.menu, choice }
    if (key === 'Escape') return { type: 'closeMenu' }
    return null
  }
  const at = keys.indexOf(ui.sel)
  const sel = at >= 0 ? ui.sel : null
  const row = sel ? rowOf(sel) : null
  switch (key) {
    case 'j':
    case 'ArrowDown':
      return keys.length ? { type: 'select', key: keys[Math.min(keys.length - 1, at + 1)] } : null
    case 'k':
    case 'ArrowUp':
      return keys.length ? { type: 'select', key: keys[Math.max(0, at - 1)] } : null
    case 'Enter':
      return sel ? { type: 'open', key: sel } : null
    case 'e':
      return sel && row && !row.calendar ? { type: 'done', key: sel } : null
    case 's':
      return sel && row && !row.calendar ? { type: 'menu', key: sel } : null
    case 'u':
      return { type: 'undo' }
    default:
      return null
  }
}

/** After a row left (done or snoozed): the row now at its place, or the one before at the end. */
function nextSelection(keysBefore, gone, keysAfter) {
  const at = keysBefore.indexOf(gone)
  if (!keysAfter.length) return null
  if (keysAfter.includes(gone)) return gone
  return keysAfter[Math.min(Math.max(0, at), keysAfter.length - 1)]
}

/**
 * Holds redraws while a mouse button is down. A click fires only when the press and the release land
 * on the same element, and a redraw replaces every element: the first click into an unfocused panel
 * focuses its window, the page posts `visible`, and the host's answer used to rebuild the list
 * between press and release, so that click did nothing (the second one worked). `request()` draws at
 * once when no button is down; else once, after the release and the click it makes (`defer` runs
 * after the click's own handlers).
 */
function createRenderGate(draw, defer = (fn) => setTimeout(fn, 0)) {
  let down = false
  let pending = false
  return {
    down() {
      down = true
    },
    up() {
      defer(() => {
        down = false
        if (pending) {
          pending = false
          draw()
        }
      })
    },
    request() {
      if (down) pending = true
      else draw()
    },
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FYI_LIMIT, colorClass, ageText, clockText, filterRows, listModel, chipsModel, problemLines, rowModel, offModel, dayClock, snoozeChoices, calendarPlacement, keyAction, nextSelection, createRenderGate }
}
