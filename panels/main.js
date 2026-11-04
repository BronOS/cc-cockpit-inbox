'use strict'
// The Inbox panel: renders the host's `{ type: 'state' }` message (chips, error lines, the calendar
// block where its setting puts it, the ranked list, the undo toast) and posts actions back by row
// key; the host finds the row, the id and any URL itself. Every text from a provider goes in through
// textContent, never as markup. The models come from rowlogic.js and timeline.js (pure, tested);
// this file only builds elements and handles input.
//
// The page tells the host when it comes into sight or its window gets focus (`visible`), so a done
// in another window shows here at once. Between state messages a 15 s timer redraws the ages,
// countdowns and the now marker; a 1 s one hides the toast when its undo time is up.

let state = null
const ui = { filter: 'all', sel: null, menu: null, showAll: false, notice: null, view: 'list' }
let noticeTimer = null
// Redraws from a state message or a timer wait while a mouse button is down (rowlogic.js
// createRenderGate: a redraw between press and release loses the click). Redraws a click itself
// asks for call render() directly.
const gate = createRenderGate(() => render())
document.addEventListener('pointerdown', () => gate.down(), true)
document.addEventListener('pointerup', () => gate.up(), true)
document.addEventListener('pointercancel', () => gate.up(), true)

const root = () => document.getElementById('root')
const post = (type, extra) => ccPanel.post({ type, ...extra })

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

function button(label, onclick, title, cls) {
  return el('button', { type: 'button', title, class: cls, onclick: (ev) => { ev.stopPropagation(); onclick() } }, label)
}

const wide = () => window.innerWidth >= 700

// ---- calendar ----

function calendarBlock(where) {
  const m = calendarModel(state.calendar, Date.now())
  const box = el('div', { class: `cal ${where}` })
  box.append(el('div', { class: 'cal-h' }, el('span', { class: 't', text: m.title }), el('span', { class: 'more', text: m.more })))
  const strip = el('div', { class: 'strip', role: 'img', 'aria-label': 'Today in half hours: blue busy, striped not answered, grey free' })
  m.cells.forEach((c, i) => strip.append(el('i', { class: c === 'busy' ? 'b' : c === 'unanswered' ? 'u' : '', title: m.cellTitles[i] })))
  const wrap = el('div', { class: 'stripbox' }, strip)
  if (m.now !== null) wrap.append(el('div', { class: 'now', style: `left:${m.now.toFixed(2)}%` }))
  const scale = el('div', { class: 'scale' })
  for (const s of m.scale) scale.append(el('span', { style: `left:${s.pct.toFixed(2)}%`, text: s.text }))
  box.append(wrap, scale)
  if (m.next) {
    box.append(
      el('div', { class: 'next' },
        el('span', { class: 'when', text: m.next.when }),
        el('span', { class: 'what', text: m.next.what, title: 'Open the event', onclick: () => post('calOpen', { eventId: m.next.id }) }),
        m.next.join ? button('Join', () => post('join', { eventId: m.next.id }), 'Join the meeting', 'primary') : null)
    )
  }
  if (m.upcoming.length) {
    const ul = el('ul', { class: 'up' })
    for (const u of m.upcoming) {
      ul.append(
        el('li', {},
          el('span', { class: 'tm', text: u.when }),
          el('span', { class: 'nm', text: u.title, onclick: () => post('calOpen', { eventId: u.id }) }),
          u.unanswered ? el('span', { class: 'q', text: '? not answered' }) : null,
          u.unanswered ? button('Accept', () => post('respond', { eventId: u.id, answer: 'accepted' }), 'Accept the invitation') : null)
      )
    }
    box.append(ul)
  }
  return box
}

// ---- the list ----

function snoozeMenu(key) {
  const box = el('div', { class: 'menu', role: 'menu' }, el('div', { class: 'h', text: 'Snooze until…' }))
  for (const c of snoozeChoices(state.settings, Date.now())) {
    box.append(el('button', { type: 'button', role: 'menuitem', onclick: (ev) => { ev.stopPropagation(); snooze(key, c.choice) } }, el('span', { text: c.label }), el('kbd', { text: c.key })))
  }
  return box
}

function rowEl(r) {
  const m = rowModel(r, Date.now())
  const cls = ['row', m.unread && 'unread', m.back && 'back', ui.sel === r.key && 'sel'].filter(Boolean).join(' ')
  const li = el('li', { class: cls, tabindex: ui.sel === r.key ? '0' : '-1', 'data-key': r.key })
  li.append(
    el('span', { class: `badge ${colorClass(r.color)}`, text: r.badge }),
    el('div', { class: 'body' },
      el('div', { class: 'l1' }, el('span', { class: 'title', text: m.title, title: m.title }), el('span', { class: 'age', text: m.age })),
      el('div', { class: 'l2' }, el('span', { class: `tri ${m.triClass}`, text: m.tri }), m.meta),
      m.why ? el('div', { class: 'why', text: m.why }) : null)
  )
  const acts = el('span', { class: 'acts' })
  if (m.calendar) {
    if (m.join) acts.append(button('Join', () => post('join', { eventId: r.id }), 'Join the meeting', 'primary'))
  } else {
    const chip = (state.chips || []).find((c) => c.pluginId === r.pluginId)
    const reads = state.settings && state.settings.doneMarksRead && (state.providers || []).some((p) => p.pluginId === r.pluginId && p.markRead)
    acts.append(
      button('✓', () => done(r.key), `Done (e): hidden until it changes${reads ? `; also marked read in ${chip ? chip.label : 'its source'}` : ''}`),
      button('⏱', () => { ui.menu = ui.menu === r.key ? null : r.key; render() }, 'Snooze (s)')
    )
  }
  li.append(acts)
  if (ui.menu === r.key) li.append(snoozeMenu(r.key))
  li.addEventListener('click', () => {
    if (window.getSelection && String(window.getSelection()).length) return
    ui.sel = r.key
    ui.menu = null
    open(r)
  })
  return li
}

function offList() {
  const today = state.today || []
  if (!today.length) return el('div', { class: 'empty', text: 'Nothing done or snoozed today.' })
  const ul = el('ul', { class: 'list' })
  for (const e of today) {
    const m = offModel(e, Date.now())
    const chip = (state.chips || []).find((c) => c.pluginId === e.pluginId)
    ul.append(
      el('li', { class: 'row' },
        el('span', { class: `badge ${colorClass(chip && chip.color)}`, text: m.badge }),
        el('div', { class: 'body' },
          el('div', { class: 'l1' }, el('span', { class: 'title', text: m.title }), el('span', { class: 'age', text: m.when })),
          el('div', { class: 'l2', text: m.note })),
        el('span', { class: 'acts' }, button('Back to inbox', () => post('restore', { pluginId: e.pluginId, id: e.id }), 'Show it in the list again')))
    )
  }
  return ul
}

function listEl() {
  if (ui.filter === 'off') return offList()
  const m = listModel(state.rows, ui.filter, ui.showAll)
  if (!m.items.length) {
    const loading = (state.chips || []).some((c) => !c.loaded && !c.problem)
    const none = !(state.chips || []).length
    return el('div', { class: 'empty', text: none ? 'No source yet: install or enable a plugin that offers an inbox feed (Chat, Gmail, Jira).' : loading ? 'Loading…' : 'Inbox zero. ☕' })
  }
  const ul = el('ul', { class: 'list', role: 'listbox' })
  for (const { row, divider } of m.items) {
    if (divider) ul.append(el('div', { class: 'sep' }, el('span', { text: 'FYI' })))
    ul.append(rowEl(row))
  }
  const frag = document.createDocumentFragment()
  frag.append(ul)
  if (m.rest > 0) frag.append(el('div', { class: 'fold' }, el('span', { text: `${m.rest} lower in the list` }), button('Show all', () => { ui.showAll = true; render() })))
  return frag
}

function chipsEl() {
  const box = el('div', { class: 'chips' })
  for (const c of chipsModel(state)) {
    const cls = ['chip', ui.filter === c.filter && 'on', c.done && 'done', c.problem && 'problem', c.color && colorClass(c.color)].filter(Boolean).join(' ')
    box.append(
      el('button', { type: 'button', class: cls, onclick: () => { ui.filter = c.filter; ui.showAll = false; ui.menu = null; render() } },
        c.color ? el('i', {}) : null, c.label, el('span', { class: 'n', text: String(c.count) }))
    )
  }
  return box
}

// ---- render ----

function selectableKeys() {
  if (ui.filter === 'off') return []
  return listModel(state.rows, ui.filter, ui.showAll).items.map((x) => x.row.key)
}

function render() {
  const r = root()
  // A redraw replaces every element: keep the keyboard on the selected row if it was in the list.
  const a = document.activeElement
  const hadFocus = Boolean(a && a.closest && a.closest('.row'))
  r.textContent = ''
  if (!state) {
    r.append(el('div', { class: 'empty', text: 'Loading…' }))
    return
  }
  if (state.fatal) {
    r.append(el('div', { class: 'notice error', text: state.fatal }))
    return
  }
  if (ui.view === 'settings' && typeof renderSettings === 'function') {
    r.append(renderSettings(state, { post, close: () => { ui.view = 'list'; render() } }))
    return
  }
  if (ui.filter !== 'all' && ui.filter !== 'off' && !(state.chips || []).some((c) => c.pluginId === ui.filter)) ui.filter = 'all'
  // Keep the selection on a row that is still there.
  const keys = selectableKeys()
  if (!keys.includes(ui.sel)) ui.sel = keys[0] || null
  if (ui.menu && !keys.includes(ui.menu)) ui.menu = null

  if (ui.notice) r.append(el('div', { class: 'notice error', text: ui.notice }))
  r.append(chipsEl())
  for (const line of problemLines(state)) r.append(el('div', { class: 'src-err', text: line }))
  const place = calendarPlacement(state, wide())
  if (place === 'side') {
    r.append(el('div', { class: 'wide-body' }, el('div', { class: 'col' }, listEl()), el('div', { class: 'side' }, calendarBlock(''))))
  } else {
    if (place === 'top') r.append(calendarBlock(''))
    r.append(listEl())
    if (place === 'bottom') r.append(calendarBlock('bottom'))
  }
  if (state.undo && Date.now() < state.undo.until) {
    r.append(el('div', { class: 'toast' }, el('span', { class: 'text', text: state.undo.label }), button('Undo', () => post('undo'), 'Undo (u)')))
  }
  r.append(el('div', { class: 'keys' }, el('kbd', { text: 'j' }), el('kbd', { text: 'k' }), ' move ', el('kbd', { text: 'Enter' }), ' open ', el('kbd', { text: 'e' }), ' done ', el('kbd', { text: 's' }), ' snooze ', el('kbd', { text: 'u' }), ' undo'))
  if (hadFocus) {
    const n = r.querySelector('.row.sel')
    if (n) n.focus({ preventScroll: true })
  }
}

// ---- actions ----

function open(r) {
  if (!r) return
  if (r.calendar) post(r.meetUrl ? 'join' : 'calOpen', { eventId: r.id })
  else post('open', { key: r.key })
}

function leave(key, msg) {
  // Move the selection now, so the next `e` does not land on nothing while the host answers.
  const before = selectableKeys()
  ui.sel = nextSelection(before, key, before.filter((k) => k !== key))
  ui.menu = null
  post(msg.type, msg)
  render()
}
const done = (key) => leave(key, { type: 'done', key })
const snooze = (key, choice) => leave(key, { type: 'snooze', key, choice })

function focusSel() {
  const n = root().querySelector('.row.sel')
  if (n) {
    n.focus({ preventScroll: true })
    n.scrollIntoView({ block: 'nearest' })
  }
}

document.addEventListener('keydown', (ev) => {
  if (!state || state.fatal || ui.view !== 'list') return
  if (ev.target && ev.target.closest && ev.target.closest('input, select, textarea')) return
  const rows = new Map((state.rows || []).map((r) => [r.key, r]))
  const a = keyAction(ui, ev.key, selectableKeys(), (k) => rows.get(k), { alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey })
  if (!a) return
  ev.preventDefault()
  if (a.type === 'select') {
    ui.sel = a.key
    render()
    focusSel()
  } else if (a.type === 'open') open(rows.get(a.key))
  else if (a.type === 'done') done(a.key)
  else if (a.type === 'menu') {
    ui.menu = a.key
    render()
  } else if (a.type === 'snooze') snooze(a.key, a.choice)
  else if (a.type === 'closeMenu') {
    ui.menu = null
    render()
  } else if (a.type === 'undo') post('undo')
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
    // The settings form is not redrawn under the person's typing: it reads the new state when it
    // opens again (Save and Cancel go back to the list, which draws then).
    if (ui.view !== 'settings') gate.request()
  } else if (m.type === 'notice' && typeof m.text === 'string') {
    ui.notice = m.text
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      ui.notice = null
      gate.request()
    }, 8000)
    gate.request()
  } else if (m.type === 'view' && (m.view === 'settings' || m.view === 'list')) {
    // The title bar's settings button: a second press goes back to the list.
    ui.view = ui.view === m.view ? 'list' : m.view
    gate.request()
  }
})

// Another window may have marked something done: ask for the shared state again when seen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') post('visible')
})
window.addEventListener('focus', () => post('visible'))
window.addEventListener('resize', () => {
  if (state && state.calendar && state.calendar.position === 'beside') gate.request()
})
// Ages, countdowns, the now marker; not while the menu is open or the focus is in a field.
setInterval(() => {
  if (state && ui.view === 'list' && !ui.menu) gate.request()
}, 15000)
setInterval(() => {
  if (state && state.undo && Date.now() >= state.undo.until && root().querySelector('.toast')) gate.request()
}, 1000)

post('hello')
