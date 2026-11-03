'use strict'
// The settings view (mock-up settings()). renderSettings(state, { post, close }) returns an element;
// the fields live in the DOM, Save collects them, formToSettings (settingslogic.js) merges them into
// the stored settings and the host validates the whole object with readSettings. Every string goes
// through textContent, never as markup.

function renderSettings(state, { post, close }) {
  const h = (tag, props, ...kids) => {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v
      else if (k === 'text') n.textContent = v
      else if (k === 'onclick') n.addEventListener('click', v)
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v))
    }
    for (const c of kids) if (c !== null && c !== undefined && c !== false) n.append(c)
    return n
  }
  const s = state.settings
  const rows = sourceRows(s, state.providers)
  const fields = {}
  const num = (value, extra) => h('input', { type: 'text', inputmode: 'numeric', value: value ?? '', ...extra })
  const check = (on) => h('input', { type: 'checkbox', checked: on })
  const select = (opts, value) => {
    const n = h('select', {}, ...opts.map(([v, t]) => h('option', { value: v, text: t, selected: v === value })))
    n.value = value
    return n
  }
  const label = (text, small) => h('label', {}, text, small ? h('small', { text: small }) : null)

  const srcTable = h('table', { class: 'src' }, h('tr', {}, ...['Source', 'Items', 'Weight', 'On'].map((t) => h('th', { text: t }))))
  const src = {}
  for (const r of rows) {
    const name = h('span', { class: `c-${r.color}`, text: r.label })
    name.style.color = 'var(--src)'
    name.style.fontWeight = '600'
    const f = { items: num(r.items), weight: num(r.weight, { placeholder: r.weightDefault === undefined ? '' : String(r.weightDefault) }), on: check(r.on) }
    if (r.live) src[r.pluginId] = f
    else for (const i of Object.values(f)) i.disabled = true
    srcTable.append(h('tr', { class: r.live ? '' : 'gone' }, h('td', {}, name, r.note ? h('small', { class: 'muted', text: ` ${r.note}` }) : null), h('td', {}, f.items), h('td', {}, f.weight), h('td', {}, f.on)))
  }
  fields.sources = src

  const levels = { urgent: num(s.levels.urgent), action: num(s.levels.action), fyi: num(s.levels.fyi) }
  fields.levels = levels
  const unread = num(s.unread), direct = num(s.direct), due = num(s.due), age = num(s.agePerHour)
  const dedupe = check(s.dedupeJira), marks = check(s.doneMarksRead), returns = check(s.doneReturns), notify = check(s.notifySnooze)
  const aft = select(SELECTS.afternoon, s.afternoon), mor = select(SELECTS.morning, s.morning), badge = select(SELECTS.badge, s.badge)
  const pos = select(SELECTS.position, s.calendar.position), tl = select(SELECTS.timeline, s.calendar.timeline)
  const upcoming = num(s.calendar.upcoming), pin = num(s.calendar.pinMinutes)

  const collect = () => ({
    sources: Object.fromEntries(Object.entries(src).map(([id, f]) => [id, { on: f.on.checked, items: f.items.value, weight: f.weight.value }])),
    levels: { urgent: levels.urgent.value, action: levels.action.value, fyi: levels.fyi.value },
    unread: unread.value, direct: direct.value, due: due.value, agePerHour: age.value,
    dedupeJira: dedupe.checked, doneMarksRead: marks.checked, doneReturns: returns.checked, notifySnooze: notify.checked,
    afternoon: aft.value, morning: mor.value, badge: badge.value,
    calendar: { position: pos.value, upcoming: upcoming.value, pinMinutes: pin.value, timeline: tl.value },
  })
  const save = () => {
    post('saveSettings', { settings: formToSettings(s, state.providers, collect()) })
    close()
  }

  const rules = (...kids) => h('div', { class: 'rules' }, ...kids)
  return h('div', { class: 'set' },
    h('button', { type: 'button', class: 'back', text: '← Inbox', onclick: close }),
    h('h3', { text: 'Sources' }),
    h('div', { class: 'hint', text: "Read through each plugin's service, never its data. The weight orders items of the same level: keep it below the gap between levels (150) and an urgent Jira ticket still beats a Chat action. An empty weight means the kind's default." }),
    srcTable,
    h('h3', { text: 'Priority' }),
    h('div', { class: 'hint', text: 'Score = source weight + triage level + boosts − age. Highest first.' }),
    rules(
      label('Urgent'), levels.urgent, label('Action'), levels.action, label('FYI'), levels.fyi,
      label('Unread', 'read items sink'), unread, label('Direct message / mentions me'), direct,
      label('Jira: due within 2 days'), due, label('Age', 'points lost per hour'), age,
      label('Hide a Jira mail when its issue is listed'), dedupe),
    h('h3', { text: 'Done and snooze' }),
    rules(
      label('Done also marks read at the source', 'Chat and Gmail; Jira items are only hidden here'), marks,
      label('A done item comes back when it changes', 'a new message, comment or status'), returns,
      label('Notify when a snooze ends'), notify,
      label('"This afternoon" means'), aft, label('"Tomorrow" means'), mor),
    h('h3', { text: 'Calendar' }),
    rules(
      label('Position'), pos, label('Upcoming events listed'), upcoming,
      label('Pin an event to the top of the list', 'minutes before it starts'), pin,
      label('Timeline hours'), tl),
    h('h3', { text: 'Badge' }),
    rules(label('Count on the app badge', 'which items are counted'), badge),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', text: 'Save', onclick: save }), h('button', { type: 'button', text: 'Cancel', onclick: close })))
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderSettings }
