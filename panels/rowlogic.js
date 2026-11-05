'use strict'
// The Inbox panel's decisions, free of the DOM so node:test can check them (test/panel.test.js
// requires this file; the page loads it as a classic script before main.js, where these become
// globals). main.js only turns these models into elements, every provider string through
// textContent. The input is the host's `{ type: 'state', version: 2 }` message (dist/host.js
// `snapshot`): groups of rows already placed by the rules, the source lines, the Done view, the
// search results (the host searches; the page only sends the query), the undo.
//
// A view filter (the chips) is the page's own: `all`, a source's plugin id, or `done`. It narrows
// what is drawn and never changes a placement.

const COLORS = ['green', 'red', 'blue', 'amber', 'violet', 'grey']
const LABELS_SHOWN = 3
// v1's snooze times: the host fixes them (v2's settings hold groups, rules and the agenda only).
const SNOOZE_TIMES = { afternoon: '14:00', morning: '09:00' }

/** A palette name for a `.cc-badge` class; anything else is grey (the host checked it already). */
function colorName(c) {
  return COLORS.includes(c) ? c : 'grey'
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

const str = (v) => (typeof v === 'string' ? v : '')
const arr = (v) => (Array.isArray(v) ? v : [])
const count = (v) => (Number.isFinite(v) && v > 0 ? v : 0)

/** The first line of a preview (the host cut it to 200; sources already made it one line). */
function firstLine(s) {
  return str(s).split(/\r?\n/, 1)[0].trim()
}

/** `Ann Example`, else the address; '' when the item has no sender. */
function fromText(from) {
  if (!from || typeof from !== 'object') return ''
  return str(from.name) || str(from.address)
}

/** `PROJ · In review`, `general`, ''. */
function placeText(place) {
  if (!place || typeof place !== 'object') return ''
  const name = str(place.name)
  const status = str(place.status)
  return name && status ? `${name} · ${status}` : name || status
}

/**
 * What one row draws: the source badge, the title, the meta line (from · place · time), the
 * preview's first line, at most 3 labels, the rule's reason and the marks (back, done, snoozed in a
 * search). `actions` are the source's (the host left `open` out: it is the row click), then Done and
 * Snooze, which are Inbox's own (`own: true`); a done or snoozed search hit has neither.
 */
function rowModel(r, now) {
  const marks = []
  if (r.back) marks.push('back: new activity')
  if (r.done) marks.push('done')
  if (r.snoozed) marks.push('snoozed')
  const own = r.done || r.snoozed ? [] : [{ id: 'done', label: 'Done', own: true }, { id: 'snooze', label: 'Snooze', own: true }]
  const sourceActions = arr(r.actions)
    .filter((a) => a && typeof a.id === 'string' && a.id !== 'open')
    .map((a) => ({ id: a.id, label: str(a.label) || a.id, own: false }))
  return {
    key: r.key,
    badge: str(r.badge) || 'FEED',
    color: colorName(r.color),
    source: str(r.label) || str(r.source),
    title: str(r.title),
    meta: [fromText(r.from), placeText(r.place), ageText(r.time, now)].filter(Boolean).join(' · '),
    preview: firstLine(r.preview),
    labels: arr(r.labels).filter((l) => typeof l === 'string' && l).slice(0, LABELS_SHOWN),
    reason: str(r.reason),
    marks,
    unread: r.read === false,
    canOpen: r.canOpen === true,
    actions: [...sourceActions, ...own],
  }
}

/** A Done view row (or a Done search hit no source still has): done when, still in the source or not. */
function doneRowModel(e) {
  const when = typeof e.at === 'number' ? `done ${clockText(e.at)}` : 'done'
  return {
    key: e.key,
    badge: str(e.badge) || 'FEED',
    color: colorName(e.color),
    source: str(e.label) || str(e.source),
    title: str(e.title) || '(no title)',
    meta: [when, e.live ? '' : 'no longer in the source'].filter(Boolean).join(' · '),
    canOpen: e.live === true,
  }
}

/**
 * One source's `.cc-error-line`, or null when it has nothing to say: not ok (signed out, an error),
 * a failed snapshot, refused items, items over the 1000 cap. A stale list says since when it is shown.
 */
function sourceLine(s) {
  const label = str(s.label) || str(s.pluginId)
  const parts = []
  if (s.state && s.state !== 'ok') parts.push(str(s.message) || (s.state === 'signedOut' ? 'signed out' : 'not available'))
  // The error already names the source (lib/sources.js): the label is not said twice.
  const err = str(s.error)
  if (err) parts.push(err.startsWith(`${label}: `) ? err.slice(label.length + 2) : err)
  if (!parts.length && !count(s.refused) && !count(s.overCap)) return null
  let text = `${label}: ${parts.join('; ') || 'some items were left out'}`
  if (s.stale && typeof s.asOf === 'number') text += `, showing items from ${clockText(s.asOf)}`
  const counts = []
  if (count(s.refused)) counts.push(`${count(s.refused)} ${count(s.refused) === 1 ? 'item' : 'items'} refused`)
  if (count(s.overCap)) counts.push(`${count(s.overCap)} older ${count(s.overCap) === 1 ? 'item' : 'items'} left out (over 1000)`)
  if (counts.length) text += ` · ${counts.join(' · ')}`
  return text
}

/** The lines above the groups, one per source with something to say (with a source filter, its own only). */
function sourceLines(state, filter) {
  return arr(state && state.sources)
    .filter((s) => filter === 'all' || filter === 'done' || s.pluginId === filter)
    .map(sourceLine)
    .filter((l) => l !== null)
}

/** The chips: All, one per source (its shown count, its colour, a mark on a problem), Done. */
function chipsModel(state, filter) {
  const sources = arr(state && state.sources)
  const total = arr(state && state.groups).reduce((n, g) => n + (Number.isFinite(g.count) ? g.count : arr(g.rows).length), 0)
  return [
    { filter: 'all', label: 'All', count: total, on: filter === 'all' },
    ...sources.map((s) => ({
      filter: s.pluginId,
      label: str(s.label) || s.pluginId,
      count: count(s.shown),
      color: colorName(s.color),
      problem: sourceLine(s) !== null,
      on: filter === s.pluginId,
    })),
    { filter: 'done', label: 'Done', count: count(state && state.done && state.done.count), on: filter === 'done' },
  ]
}

/** The filter after a chip click: a click on the chip already on goes back to All. */
function chipFilter(current, clicked) {
  return clicked !== 'all' && clicked === current ? 'all' : clicked
}

/** A filter that names a source no longer there goes back to All. */
function validFilter(state, filter) {
  if (filter === 'all' || filter === 'done') return filter
  return arr(state && state.sources).some((s) => s.pluginId === filter) ? filter : 'all'
}

/** Is a group open: what the person last did with it (this page, else the host's memory), else its setting (Rest collapsed). */
function groupOpen(g, remembered) {
  return remembered && Object.prototype.hasOwnProperty.call(remembered, g.id) ? Boolean(remembered[g.id]) : !g.collapsed
}

/**
 * What the body shows: `{ kind, groups, done, empty }`.
 * - `groups`: `{ id, name, count, more, open, rows }`, only those with rows after the filter; `more`
 *   is how many the host did not send (it sends 200 rows a group).
 * - `kind: 'search'`: the host's results grouped as the list is (every group open), then the Done
 *   entries no source still has (`done`); the Done chip keeps the Done hits only.
 * - `kind: 'done'`: the Done view, newest first.
 * - `empty`: why nothing is drawn, `'loading'` while a source has not answered yet, or null.
 */
function viewModel(state, ui) {
  const filter = validFilter(state, ui.filter)
  const bySource = (r) => filter === 'all' || filter === 'done' || r.source === filter
  const sources = arr(state && state.sources)
  if (state && state.search) {
    const q = state.search
    const groups = arr(q.groups)
      .map((g) => {
        const rows = arr(g.rows).filter((r) => bySource(r) && (filter !== 'done' || r.done))
        return { id: g.id, name: str(g.name), count: rows.length, more: 0, open: true, rows }
      })
      .filter((g) => g.rows.length)
    // The host sends a hit with no live item bare (no badge, colour, label): the source's own are used.
    const done = arr(q.done)
      .filter(bySource)
      .map((e) => {
        const s = sources.find((x) => x.pluginId === e.source)
        return s ? { badge: s.badge, color: s.color, label: s.label, ...e } : e
      })
    // What is drawn (a chip narrows it) against what the host found: it sends at most 200 rows.
    const drawn = groups.reduce((n, g) => n + g.rows.length, 0) + done.length
    const sent = arr(q.groups).reduce((n, g) => n + arr(g.rows).length, 0) + arr(q.done).length
    const found = Number.isFinite(q.count) ? q.count : sent
    return { kind: 'search', query: str(q.query), groups, done, drawn, cut: Math.max(0, found - sent), empty: groups.length || done.length ? null : `No match for “${str(q.query)}”.` }
  }
  if (filter === 'done') {
    const done = arr(state && state.done && state.done.rows)
    return { kind: 'done', groups: [], done, empty: done.length ? null : 'Nothing marked done. Done hides an item until something new happens in it.' }
  }
  // The host's memory (every window, the last start) under this page's own clicks since it loaded.
  const host = state && state.groupsOpen && typeof state.groupsOpen === 'object' && !Array.isArray(state.groupsOpen) ? state.groupsOpen : {}
  const remembered = { ...host, ...(ui.open || {}) }
  const groups = arr(state && state.groups)
    .map((g) => {
      const rows = arr(g.rows).filter(bySource)
      const n = filter === 'all' && Number.isFinite(g.count) ? g.count : rows.length
      return { id: g.id, name: str(g.name), count: n, more: Math.max(0, n - rows.length), open: groupOpen(g, remembered), rows }
    })
    .filter((g) => g.count > 0)
  let empty = null
  if (!groups.length) {
    if (!sources.length) empty = 'No source yet: install or enable a plugin that offers an inbox feed (Chat, Gmail, Jira).'
    else if (sources.some((s) => !s.loaded)) empty = 'loading'
    else if (filter !== 'all') empty = `Nothing from ${str((sources.find((s) => s.pluginId === filter) || {}).label) || filter}.`
    else empty = 'Inbox zero: nothing needs you.'
  }
  return { kind: 'groups', groups, done: [], empty }
}

/** The line above search results: the rows drawn, and how many the host found but did not send. */
function searchHeader(model) {
  const cut = model.cut > 0 ? `, ${model.cut} more not shown: narrow the search` : ''
  return `${model.drawn} found for “${model.query}”${cut}`
}

/** The row keys the keyboard moves over, in drawn order: rows of open groups, then the Done rows. */
function selectableKeys(model) {
  const keys = []
  for (const g of model.groups) if (g.open) for (const r of g.rows) keys.push(r.key)
  for (const e of model.done) keys.push(e.key)
  return keys
}

/** The snooze menu: the four choices (the afternoon one says "tomorrow" once it passed). */
function snoozeChoices(now, times = SNOOZE_TIMES) {
  const [h, m] = times.afternoon.split(':').map(Number)
  const d = new Date(now)
  const passed = d.getHours() * 60 + d.getMinutes() >= h * 60 + m
  return [
    { choice: '1h', label: '1 hour', key: '1' },
    { choice: 'afternoon', label: passed ? `Tomorrow afternoon, ${times.afternoon}` : `This afternoon, ${times.afternoon}`, key: '2' },
    { choice: 'tomorrow', label: `Tomorrow ${times.morning.replace(/^0/, '')}`, key: '3' },
    { choice: 'changes', label: 'Until it changes', key: '4' },
  ]
}

/**
 * A key press outside a field: `ui` is `{ sel, menu, searching }`, `keys` the selectable keys in
 * order, `rowOf(key)` the row as drawn (`done` / `snoozed` on a Done entry or such a search hit,
 * `canOpen`). Returns null or `{ type }`: `select` (with `key`), `open`, `done`, `menu`, `snooze`
 * (with `choice`), `closeMenu`, `undo`, `search` (focus the field), `leaveSearch`.
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
  // Done and snooze are for an item in the list: not for a Done entry or a done or snoozed search hit.
  const inList = Boolean(row && !row.done && !row.snoozed)
  switch (key) {
    case 'j':
    case 'ArrowDown':
      return keys.length ? { type: 'select', key: keys[Math.min(keys.length - 1, at + 1)] } : null
    case 'k':
    case 'ArrowUp':
      return keys.length ? { type: 'select', key: keys[Math.max(0, at - 1)] } : null
    case 'Enter':
      return row && row.canOpen ? { type: 'open', key: sel } : null
    case 'e':
      return inList ? { type: 'done', key: sel } : null
    case 's':
      return inList ? { type: 'menu', key: sel } : null
    case 'u':
      return { type: 'undo' }
    case '/':
      return { type: 'search' }
    case 'Escape':
      return ui.searching ? { type: 'leaveSearch' } : null
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
  module.exports = {
    searchHeader,
    COLORS,
    SNOOZE_TIMES,
    colorName,
    ageText,
    clockText,
    firstLine,
    fromText,
    placeText,
    rowModel,
    doneRowModel,
    sourceLine,
    sourceLines,
    chipsModel,
    chipFilter,
    validFilter,
    groupOpen,
    viewModel,
    selectableKeys,
    snoozeChoices,
    keyAction,
    nextSelection,
    createRenderGate,
  }
}
