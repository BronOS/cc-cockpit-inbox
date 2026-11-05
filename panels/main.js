'use strict'
// The Inbox panel v2 (docs/design-v2.md "The panel"): draws the host's `{ type: 'state', version: 2 }`
// message (dist/host.js `snapshot`) with the app's component stylesheet and posts what the person does
// back by row key; the host finds the item, its source and its actions itself and never takes an id,
// a rev or an action list from this page. Every text from a source goes in through textContent, never
// as markup; a colour is a palette name used as a class. The decisions (rows, groups, chips, source
// lines, keys) live in rowlogic.js, pure and tested; this file only builds elements and handles input.
//
// Built once: the toolbar (the search field must keep its caret and text while state messages
// redraw the rest). Redrawn on every state: the chips, the source lines, the groups or the Done view
// or the search results, the undo toast. The app draws the title bar (updated time, refresh, the gear
// to Inbox's settings page) and the agenda slot; this page draws no settings.
//
// The page tells the host when it comes into sight or its window gets focus (`visible`), so a Done in
// another window shows here at once. A 15 s timer redraws the ages; a 1 s one drops the undo toast
// when its time is up.

let state = null
const ui = {
  filter: 'all',
  sel: null,
  menu: null,
  // A group's open state as the person left it on this page, by group id, over the one the host
  // remembers for every window (state.groupsOpen: a page has an opaque origin, no localStorage).
  // Groups never touched follow their setting.
  open: {},
  searching: false,
  notice: null,
}
let noticeTimer = null
let searchTimer = null
let searchSynced = false
let model = null
// Redraws from a state message or a timer wait while a mouse button is down (rowlogic.js
// createRenderGate: a redraw between press and release loses the click). Redraws a click itself asks
// for call render() directly.
const gate = createRenderGate(() => render())
document.addEventListener('pointerdown', () => gate.down(), true)
document.addEventListener('pointerup', () => gate.up(), true)
document.addEventListener('pointercancel', () => gate.up(), true)

const post = (type, extra) => ccPanel.post({ type, ...extra })
const $ = (id) => document.getElementById(id)

function el(tag, props, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k === 'onclick') n.addEventListener('click', v)
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c)
  return n
}

/** A button whose click does not also reach the row under it. */
function button(label, onclick, title, cls) {
  return el('button', { type: 'button', title, class: cls, onclick: (ev) => { ev.stopPropagation(); onclick() } }, label)
}

// ---- the toolbar (built once) ----

const search = el('input', { type: 'search', id: 'q', placeholder: 'Search', 'aria-label': 'Search every item, Rest and Done included (/)', autocomplete: 'off', spellcheck: 'false' })
const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Show' })

function sendSearch() {
  clearTimeout(searchTimer)
  searchTimer = null
  post('search', { query: search.value })
}

search.addEventListener('input', () => {
  ui.searching = search.value.trim() !== ''
  clearTimeout(searchTimer)
  searchTimer = setTimeout(sendSearch, 200)
})
search.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    ev.preventDefault()
    leaveSearch()
  } else if (ev.key === 'Enter' || ev.key === 'ArrowDown') {
    // From the field into the results: the first row takes the keyboard.
    ev.preventDefault()
    if (searchTimer) sendSearch()
    const keys = model ? selectableKeys(model) : []
    if (keys.length) {
      ui.sel = keys[0]
      render()
      focusSel()
    }
  }
})

function leaveSearch() {
  const had = search.value !== '' || (state && state.search)
  search.value = ''
  ui.searching = false
  if (had) sendSearch()
  search.blur()
  focusSel()
}

// ---- rows ----

function snoozeMenu(key) {
  const box = el('div', { class: 'menu', role: 'menu', 'aria-label': 'Snooze until' }, el('div', { class: 'menu-h cc-muted', text: 'Snooze until…' }))
  for (const c of snoozeChoices(Date.now())) {
    box.append(el('button', { type: 'button', role: 'menuitem', class: 'cc-ghost', onclick: (ev) => { ev.stopPropagation(); snooze(key, c.choice) } }, el('span', { text: c.label }), el('kbd', { class: 'cc-kbd', text: c.key })))
  }
  return box
}

function rowShell(key, m, extraClass) {
  const selected = ui.sel === key
  return el('li', {
    class: ['cc-row', 'inbox-row', extraClass].filter(Boolean).join(' '),
    tabindex: selected ? '0' : '-1',
    'aria-selected': selected ? 'true' : 'false',
    'data-key': key,
  }, el('span', { class: `cc-badge ${m.color}`, text: m.badge, title: m.source }))
}

function onRowClick(li, key, canOpen) {
  li.addEventListener('click', () => {
    // Selecting text in a row is not a click on it.
    if (window.getSelection && String(window.getSelection()).length) return
    ui.sel = key
    ui.menu = null
    if (canOpen) post('open', { key })
    render()
  })
}

function rowEl(r) {
  const m = rowModel(r, Date.now())
  const li = rowShell(m.key, m, m.unread ? 'cc-unread' : '')
  const meta = el('span', { class: 'cc-row-meta' }, m.meta)
  for (const mark of m.marks) meta.append(el('span', { class: 'mark', text: mark }))
  if (m.reason) meta.append(el('span', { class: 'reason', text: m.reason }))
  const main = el('div', { class: 'cc-row-main' }, el('span', { class: 'cc-row-title', text: m.title, title: m.title }), meta)
  if (m.preview) main.append(el('span', { class: 'preview cc-muted', text: m.preview }))
  if (m.labels.length) {
    const labels = el('span', { class: 'labels' })
    for (const l of m.labels) labels.append(el('span', { class: 'cc-chip', text: l }))
    main.append(labels)
  }
  li.append(main)
  if (m.actions.length) {
    const acts = el('span', { class: 'cc-row-actions' })
    for (const a of m.actions) {
      if (a.own && a.id === 'done') acts.append(button('Done', () => done(m.key), 'Done (e): hidden until something new happens in it'))
      else if (a.own && a.id === 'snooze') acts.append(button('Snooze', () => { ui.sel = m.key; ui.menu = ui.menu === m.key ? null : m.key; render() }, 'Snooze (s)'))
      else acts.append(button(a.label, () => post('act', { key: m.key, action: a.id }), `${a.label} in ${m.source}`))
    }
    li.append(acts)
  }
  if (ui.menu === m.key) li.append(snoozeMenu(m.key))
  onRowClick(li, m.key, m.canOpen)
  return li
}

function doneRowEl(e) {
  const m = doneRowModel(e)
  const li = rowShell(m.key, m, 'done-row')
  li.append(
    el('div', { class: 'cc-row-main' }, el('span', { class: 'cc-row-title', text: m.title, title: m.title }), el('span', { class: 'cc-row-meta', text: m.meta })),
    el('span', { class: 'cc-row-actions' }, button('Back to Inbox', () => post('restore', { key: m.key }), 'Show it in the list again: the rules place it'))
  )
  onRowClick(li, m.key, m.canOpen)
  return li
}

function groupEl(g) {
  const d = el('details', { class: 'cc-group', open: g.open, 'data-group': g.id },
    el('summary', { class: 'cc-group-title', 'data-group': g.id }, el('span', { text: g.name }), el('span', { class: 'cc-count', text: String(g.count) })))
  // Setting `open` while building fires a `toggle` too: only a change from what was drawn is the person's.
  d.addEventListener('toggle', () => {
    if (d.open === g.open) return
    // Search shows every group open: a click there does nothing (and is not remembered for the list).
    if (!(model && model.kind === 'search')) {
      ui.open[g.id] = d.open
      post('groupOpen', { id: g.id, open: d.open })
    }
    render()
  })
  const ul = el('ul', { class: 'cc-list', 'aria-label': g.name })
  for (const r of g.rows) ul.append(rowEl(r))
  d.append(ul)
  if (g.more > 0) d.append(el('div', { class: 'more cc-muted', text: `${g.more} more not shown: search or narrow by source` }))
  return d
}

function emptyEl(text) {
  if (text === 'loading') return el('div', { class: 'cc-empty' }, el('span', { class: 'cc-spinner' }), el('p', { text: 'Loading the sources…' }))
  const box = el('div', { class: 'cc-empty' }, el('p', { text }))
  if (model && model.kind === 'search') box.append(button('Clear search', () => leaveSearch(), 'Clear search (Esc)'))
  else if (ui.filter !== 'all') box.append(button('Back to Inbox', () => { ui.filter = 'all'; render() }, 'Show every source'))
  return box
}

// ---- render ----

function renderChips() {
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.chips [data-filter]')
  const was = focused ? focused.getAttribute('data-filter') : null
  chips.textContent = ''
  for (const c of chipsModel(state, ui.filter)) {
    const b = el('button', {
      type: 'button',
      class: 'cc-chip',
      'aria-pressed': c.on ? 'true' : 'false',
      'data-filter': c.filter,
      title: c.problem ? `${c.label}: see the line below` : undefined,
      onclick: () => {
        ui.filter = chipFilter(ui.filter, c.filter)
        ui.menu = null
        render()
      },
    }, c.color ? el('i', { class: `dot ${c.color}` }) : null, c.label, el('span', { class: 'cc-count', text: String(c.count) }), c.problem ? el('span', { class: 'problem', text: '!' }) : null)
    chips.append(b)
  }
  if (was) {
    const n = chips.querySelector(`[data-filter="${CSS.escape(was)}"]`)
    if (n) n.focus({ preventScroll: true })
  }
}

function render() {
  const body = $('body')
  const lines = $('lines')
  const toast = $('toast')
  const notice = $('notice')
  const a = document.activeElement
  const hadFocus = Boolean(a && a.closest && a.closest('.inbox-row'))
  // A group opened or closed from the keyboard keeps focus on its summary through the redraw.
  const sum = a && a.closest && a.closest('summary[data-group]')
  const hadSummary = sum ? sum.getAttribute('data-group') : null
  body.textContent = ''
  lines.textContent = ''
  toast.textContent = ''
  notice.textContent = ''
  if (ui.notice) notice.append(el('div', { class: 'cc-error-line', role: 'alert', text: ui.notice }))
  if (!state) {
    body.append(emptyEl('loading'))
    return
  }
  if (state.fatal) {
    $('toolbar').hidden = true
    body.append(el('div', { class: 'cc-error-line', role: 'alert', text: String(state.fatal) }))
    return
  }
  $('toolbar').hidden = false
  // The host cut the list to fit the app's message limit (host.js fittedSnapshot): said for as long as it lasts.
  if (typeof state.limited === 'string' && state.limited) notice.append(el('div', { class: 'cc-muted', role: 'status', text: state.limited }))
  ui.filter = validFilter(state, ui.filter)
  model = viewModel(state, ui)
  // Keep the selection on a row that is still drawn.
  const keys = selectableKeys(model)
  if (!keys.includes(ui.sel)) ui.sel = keys[0] || null
  if (ui.menu && !keys.includes(ui.menu)) ui.menu = null

  renderChips()
  for (const line of sourceLines(state, ui.filter)) lines.append(el('div', { class: 'cc-error-line', text: line }))

  if (model.kind === 'search') {
    body.append(el('div', { class: 'search-h cc-muted', text: searchHeader(model) }))
  }
  for (const g of model.groups) body.append(groupEl(g))
  if (model.done.length) {
    const ul = el('ul', { class: 'cc-list', 'aria-label': 'Done' })
    for (const e of model.done) ul.append(doneRowEl(e))
    if (model.kind === 'search') body.append(el('div', { class: 'cc-group' }, el('div', { class: 'cc-group-title', text: 'Done, no longer in a source' }), ul))
    else body.append(ul)
    if (model.kind === 'done' && state.done.count > model.done.length) body.append(el('div', { class: 'more cc-muted', text: `${state.done.count - model.done.length} older not shown` }))
  }
  if (model.empty) body.append(emptyEl(model.empty))

  if (state.undo && Date.now() < state.undo.until) {
    toast.append(el('div', { class: 'toast', role: 'status' }, el('span', { class: 'text', text: String(state.undo.label || '') }), button('Undo', () => post('undo'), 'Undo (u)', 'cc-ghost')))
  }
  if (hadFocus) focusSel()
  else if (hadSummary) {
    const n = body.querySelector(`summary[data-group="${CSS.escape(hadSummary)}"]`)
    if (n) n.focus({ preventScroll: true })
  }
}

// ---- actions ----

function rowByKey(key) {
  if (!model) return null
  for (const g of model.groups) for (const r of g.rows) if (r.key === key) return { done: r.done, snoozed: r.snoozed, canOpen: r.canOpen === true }
  for (const e of model.done) if (e.key === key) return { done: true, canOpen: e.live === true }
  return null
}

function leave(key, msg) {
  // Move the selection now, so the next `e` does not land on nothing while the host answers.
  const before = model ? selectableKeys(model) : []
  ui.sel = nextSelection(before, key, before.filter((k) => k !== key))
  ui.menu = null
  post(msg.type, msg)
  render()
}
const done = (key) => leave(key, { type: 'done', key })
const snooze = (key, choice) => leave(key, { type: 'snooze', key, choice })

function focusSel() {
  const n = document.querySelector('.inbox-row[aria-selected="true"]')
  if (n) {
    n.focus({ preventScroll: true })
    n.scrollIntoView({ block: 'nearest' })
  }
}

document.addEventListener('keydown', (ev) => {
  if (!state || state.fatal || !model) return
  if (ev.target && ev.target.closest && ev.target.closest('input, select, textarea')) return
  // A key on a button (Enter, Space) is that button's.
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target && ev.target.closest && ev.target.closest('button, summary')) return
  const act = keyAction(ui, ev.key, selectableKeys(model), rowByKey, { alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey })
  if (!act) return
  ev.preventDefault()
  if (act.type === 'select') {
    ui.sel = act.key
    render()
    focusSel()
  } else if (act.type === 'open') post('open', { key: act.key })
  else if (act.type === 'done') done(act.key)
  else if (act.type === 'menu') {
    ui.menu = act.key
    render()
  } else if (act.type === 'snooze') snooze(act.key, act.choice)
  else if (act.type === 'closeMenu') {
    ui.menu = null
    render()
    focusSel()
  } else if (act.type === 'undo') post('undo')
  else if (act.type === 'search') {
    search.focus()
    search.select()
  } else if (act.type === 'leaveSearch') leaveSearch()
})

// A click anywhere else closes the snooze menu.
document.addEventListener('click', () => {
  if (ui.menu) {
    ui.menu = null
    render()
  }
})

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'state') {
    state = m
    // The query lives in the host and outlives this page: a reloaded page shows it in the field.
    if (!searchSynced) {
      searchSynced = true
      if (m.search && typeof m.search.query === 'string' && search.value === '') {
        search.value = m.search.query
        ui.searching = m.search.query !== ''
      }
    }
    gate.request()
  } else if (m.type === 'notice' && typeof m.text === 'string') {
    ui.notice = m.text
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      ui.notice = null
      gate.request()
    }, 8000)
    gate.request()
  }
})

// Another window may have marked something done: ask for the shared state again when seen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') post('visible')
})
window.addEventListener('focus', () => post('visible'))
// The ages; not while the snooze menu is open.
setInterval(() => {
  if (state && !ui.menu) gate.request()
}, 15000)
setInterval(() => {
  if (state && state.undo && Date.now() >= state.undo.until && $('toast').firstChild) gate.request()
}, 1000)

$('toolbar').append(search, chips)
render()
post('hello')
