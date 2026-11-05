'use strict'
// The Inbox settings page (docs/design-v2.md "Settings page"): edits a draft of the groups, the rules
// and the agenda, and sends it whole on Save; dist/host.js checks it (lib/settings.js
// `checkSettings`), stores it and answers with what it stored, or refuses it with the reason, shown
// in the error line. "Test" asks the host how a rule of the draft would place the items Inbox holds
// now (cached Jev answers only). The sources are read-only. The decisions live in logic.js, pure and
// tested; this file only builds elements and handles input. Every string, from a source or from the
// settings, goes in through textContent or a value, never as markup.
//
// Redraws rebuild the page; the focused control is found again by its `data-f` key, so the keyboard
// stays where it was. A typed character only updates the draft (and the Save bar): the whole page is
// redrawn after the field's `change`, and after the event, so a Tab out of the field lands where it
// was going.
//
// Host messages: `settings { settings, saved, table, defaults, sources, jev }`, `refused { reason }`,
// `test { ruleId, result }`, `fatal { reason }`. Page messages: `ready`, `save { settings }`,
// `test { settings, ruleId }`.

const page = {
  saved: null,
  draft: null,
  table: null,
  defaults: null,
  sources: [],
  jevOn: false,
  open: null,
  error: null,
  status: '',
  tests: {},
  fatal: null,
}
const PALETTE = ['green', 'red', 'blue', 'amber', 'violet', 'grey']
const $ = (id) => document.getElementById(id)

function el(tag, props, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k === 'value') n.value = v
    else if (k === 'checked') n.checked = v === true
    else if (k === 'disabled') n.disabled = v === true
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c)
  return n
}

const btn = (label, onclick, o = {}) => el('button', { type: 'button', class: o.cls, title: o.title, 'data-f': o.f, disabled: o.disabled, onclick }, label)
const option = (value, label, selected) => {
  const o = el('option', { value, text: label })
  o.selected = selected
  return o
}
const select = (f, label, options, value, onchange) => {
  const s = el('select', { 'data-f': f, 'aria-label': label, onchange: () => onchange(s.value) })
  for (const o of options) s.append(option(o.value, o.label, o.value === value))
  return s
}
const checkbox = (f, label, checked, onchange, disabled) => {
  const box = el('input', { type: 'checkbox', 'data-f': f, checked, disabled, onchange: () => onchange(box.checked) })
  return el('label', { class: 'check' }, box, label)
}
const badge = (text, color) => el('span', { class: `cc-badge ${PALETTE.includes(color) ? color : 'grey'}`, text })

/** A new draft: kept, the stale Test results dropped, the bar redrawn. `redraw` also rebuilds the page after this event. */
function edit(next, redraw = true) {
  if (next === page.draft) return
  page.draft = next
  page.tests = {}
  page.status = ''
  if (redraw) later()
  else renderBar()
}

let laterQueued = false
/** Redraw after the current event (a `change` fires before focus moves on). */
function later() {
  if (laterQueued) return
  laterQueued = true
  setTimeout(() => {
    laterQueued = false
    render()
  }, 0)
}

// ---- the bar ----

function renderBar() {
  const bar = $('bar')
  bar.textContent = ''
  if (!page.draft) return
  const dirty = isDirty(page.draft, page.saved)
  bar.append(
    el('span', { class: 'status cc-muted', role: 'status', text: page.status === 'Saving…' || !dirty ? page.status : 'Unsaved changes' }),
    btn('Reset to defaults', () => {
      page.error = null
      edit(draftOf(page.defaults))
    }, { title: 'Put the default groups and rules in the draft (nothing changes until Save)', f: 'reset', disabled: !page.defaults }),
    btn('Discard changes', () => {
      page.error = null
      edit(draftOf(page.saved))
    }, { cls: 'cc-ghost', f: 'discard', disabled: !dirty }),
    btn('Save', () => {
      page.status = 'Saving…'
      renderBar()
      ccPanel.post({ type: 'save', settings: page.draft })
    }, { cls: 'cc-primary', f: 'save', disabled: !dirty })
  )
}

// ---- groups ----

function groupsCard() {
  const d = page.draft
  const list = el('ul', { class: 'cc-list cc-compact', 'aria-label': 'Groups' })
  d.groups.forEach((g, i) => {
    const rest = g.id === REST_ID
    const f = `g:${g.id}`
    const name = el('input', {
      type: 'text',
      class: 'name',
      value: g.name,
      maxlength: String(page.table.caps.groupName),
      'aria-label': `Name of group ${i + 1}`,
      'data-f': `${f}:name`,
      oninput: () => edit(renameGroup(page.draft, g.id, name.value), false),
      onchange: () => later(),
    })
    const moved = rulesIn(d, g.id)
    const row = el('li', { class: 'cc-row group-row' },
      name,
      checkbox(`${f}:collapsed`, 'Collapsed', g.collapsed === true, (on) => edit(setGroupFlag(page.draft, g.id, 'collapsed', on))),
      checkbox(`${f}:badge`, 'Badge', g.badge === true, (on) => edit(setGroupFlag(page.draft, g.id, 'badge', on))))
    if (rest) row.append(el('span', { class: 'fixed cc-muted', text: 'built in, always last' }))
    else {
      row.append(el('span', { class: 'cc-row-actions' },
        btn('↑', () => edit(moveGroup(page.draft, g.id, -1)), { cls: 'cc-icon', title: `Move ${g.name} up`, f: `${f}:up`, disabled: !canMoveGroup(d, g.id, -1) }),
        btn('↓', () => edit(moveGroup(page.draft, g.id, 1)), { cls: 'cc-icon', title: `Move ${g.name} down`, f: `${f}:down`, disabled: !canMoveGroup(d, g.id, 1) }),
        btn('Delete', () => edit(deleteGroup(page.draft, g.id)), {
          cls: 'cc-danger',
          title: moved ? `Delete ${g.name}; its ${moved} rule${moved === 1 ? '' : 's'} move to ${groupName(d, REST_ID)} (Discard changes undoes it)` : `Delete ${g.name} (Discard changes undoes it)`,
          f: `${f}:delete`,
        })))
    }
    list.append(row)
  })
  const newName = el('input', { type: 'text', placeholder: 'New group name', maxlength: String(page.table.caps.groupName), 'aria-label': 'New group name', 'data-f': 'g-new' })
  const add = () => {
    const { draft } = addGroup(page.draft, newName.value)
    newName.value = ''
    edit(draft)
  }
  newName.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      add()
    }
  })
  const full = d.groups.length >= page.table.caps.groups
  return el('section', { class: 'cc-card' },
    el('h3', { class: 'cc-card-title', text: 'Groups' }),
    el('span', { class: 'cc-help', text: 'The order the panel shows them in. Collapsed groups start folded; badge groups count their unread items on the panel icon. Deleting a group moves its rules to Rest.' }),
    list,
    el('div', { class: 'line add' }, newName, btn('Add group', add, { f: 'g-add', disabled: full, title: full ? `At most ${page.table.caps.groups} groups` : undefined })))
}

// ---- rules ----

function conditionEl(rule, c, j) {
  const f = `r:${rule.id}:c${j}`
  const t = page.table
  const fields = Object.keys(t.fields).map((x) => ({ value: x, label: x }))
  const set = (patch) => setCondition(page.draft, rule.id, j, patch, t)
  const box = el('div', { class: 'cond', role: 'group', 'aria-label': `Condition ${j + 1}` },
    select(`${f}:field`, `Condition ${j + 1} field`, fields, c.field, (v) => edit(set({ field: v }))),
    select(`${f}:op`, `Condition ${j + 1} test`, opChoices(c.field, t), c.op, (v) => edit(set({ op: v }))))
  const ctl = valueControl(c, t)
  const kind = t.fields[c.field] ? t.fields[c.field].value : 'text'
  const label = `Condition ${j + 1} value`
  if (ctl.type === 'select') {
    box.append(select(`${f}:value`, label, ctl.options.map((o) => ({ value: o, label: o })), valueText(c.value), (v) => edit(set({ value: parseValue(v, kind, c.op) }))))
  } else if (ctl.type === 'checks') {
    const have = Array.isArray(c.value) ? c.value : []
    const checks = el('span', { class: 'checks', role: 'group', 'aria-label': label })
    for (const o of ctl.options) {
      checks.append(checkbox(`${f}:v:${o}`, o, have.includes(o), (on) => {
        const now = Array.isArray(findRuleIn(rule.id).when[j].value) ? findRuleIn(rule.id).when[j].value : []
        edit(set({ value: on ? [...now.filter((x) => x !== o), o] : now.filter((x) => x !== o) }))
      }))
    }
    box.append(checks)
  } else if (ctl.type === 'lines') {
    const ta = el('textarea', { rows: '2', 'aria-label': `${label}, one per line`, placeholder: 'one per line', 'data-f': `${f}:value`, value: valueText(c.value) })
    ta.addEventListener('input', () => edit(set({ value: parseValue(ta.value, kind, c.op) }), false))
    ta.addEventListener('change', () => later())
    box.append(ta)
  } else {
    const input = el('input', {
      type: ctl.type === 'number' ? 'number' : 'text',
      'aria-label': label,
      'data-f': `${f}:value`,
      value: valueText(c.value),
      ...(ctl.type === 'number' ? { min: String(ctl.min), max: String(ctl.max), step: '1' } : { maxlength: String(ctl.max) }),
    })
    input.addEventListener('input', () => edit(set({ value: parseValue(input.value, kind, c.op) }), false))
    input.addEventListener('change', () => later())
    box.append(input)
  }
  const last = rule.when.length === 1 && !rule.jev
  box.append(btn('Remove', () => edit(removeCondition(page.draft, rule.id, j)), { cls: 'cc-ghost', f: `${f}:remove`, disabled: last, title: last ? 'A rule needs a condition or a Jev question' : `Remove condition ${j + 1}` }))
  return box
}

const findRuleIn = (id) => page.draft.rules.find((r) => r.id === id)

function testEl(rule) {
  const box = el('div', { class: 'test' },
    btn('Test', () => {
      page.tests[rule.id] = { asking: true }
      later()
      ccPanel.post({ type: 'test', settings: page.draft, ruleId: rule.id })
    }, { f: `r:${rule.id}:test`, title: 'How many of the items in the Inbox now this rule would place, with five examples (Jev: cached answers only, never a new question)' }))
  const res = page.tests[rule.id]
  if (res && res.asking) box.append(el('span', { class: 'cc-muted', text: ' Testing…' }))
  else if (res) {
    box.append(el('p', { class: res.ok ? 'cc-muted' : 'cc-error', role: 'status', text: testText(res) }))
    if (res.ok && Array.isArray(res.examples) && res.examples.length) {
      const ul = el('ul', { class: 'cc-list', 'aria-label': 'Examples' })
      for (const x of res.examples) {
        ul.append(el('li', { class: 'cc-row' }, badge(String(x.badge || ''), x.color),
          el('div', { class: 'cc-row-main' }, el('span', { class: 'cc-row-title', text: String(x.title || ''), title: String(x.title || '') }), el('span', { class: 'cc-row-meta', text: `${x.label || ''} · ${x.reason || ''}` }))))
      }
      box.append(ul)
    }
  }
  return box
}

function editorEl(rule, n) {
  const t = page.table
  const f = `r:${rule.id}`
  const name = el('input', { type: 'text', id: `${f}:name`, 'data-f': `${f}:name`, value: rule.name || '', maxlength: String(t.caps.ruleName), placeholder: 'Shown as the reason instead of the conditions' })
  name.addEventListener('input', () => edit(setRule(page.draft, rule.id, { name: name.value }), false))
  name.addEventListener('change', () => later())
  const groups = page.draft.groups.map((g) => ({ value: g.id, label: g.name }))
  const hasWhen = Array.isArray(rule.when) && rule.when.length > 0
  const ed = el('div', { class: 'editor', role: 'group', 'aria-label': `Edit rule ${n}` },
    el('div', { class: 'cc-field' }, el('label', { for: `${f}:name`, text: 'Name (optional)' }), name),
    el('div', { class: 'line' }, el('span', { text: 'Put it in' }), select(`${f}:group`, `Rule ${n} group`, groups, rule.group, (v) => edit(setRule(page.draft, rule.id, { group: v })))),
    el('div', { class: 'line' },
      checkbox(`${f}:has-when`, 'Conditions (all must hold)', hasWhen, (on) => edit(setRuleParts(page.draft, rule.id, { when: on }, t)), hasWhen && !rule.jev),
      checkbox(`${f}:has-jev`, 'Jev question', Boolean(rule.jev), (on) => edit(setRuleParts(page.draft, rule.id, { jev: on }, t)), Boolean(rule.jev) && !hasWhen)))
  if (hasWhen) {
    rule.when.forEach((c, j) => ed.append(conditionEl(rule, c, j)))
    const full = rule.when.length >= t.caps.conditions
    ed.append(el('div', {}, btn('Add condition', () => edit(addCondition(page.draft, rule.id, t)), { f: `${f}:add-cond`, disabled: full, title: full ? `At most ${t.caps.conditions} conditions` : undefined })))
  }
  if (rule.jev) {
    const q = el('textarea', { id: `${f}:q`, rows: '2', 'data-f': `${f}:q`, maxlength: String(t.caps.question), value: rule.jev.question, placeholder: 'Is this urgent?' })
    q.addEventListener('input', () => edit(setJev(page.draft, rule.id, { question: q.value }), false))
    q.addEventListener('change', () => later())
    const min = el('input', { type: 'number', id: `${f}:min`, 'data-f': `${f}:min`, min: '0', max: '1', step: '0.05', value: String(rule.jev.min) })
    min.addEventListener('input', () => edit(setJev(page.draft, rule.id, { min: parseMin(min.value) }), false))
    min.addEventListener('change', () => later())
    ed.append(el('div', { class: 'jev' },
      el('div', { class: 'cc-field' }, el('label', { for: `${f}:q`, text: hasWhen ? 'Jev question (asked only for items that pass the conditions)' : 'Jev question' }), q,
        el('span', { class: 'cc-help', text: 'Jev reads the title and the preview and scores 0 to 1; the rule holds at the threshold or above.' })),
      el('div', { class: 'line' }, el('label', { for: `${f}:min`, text: 'Threshold' }), min)))
    if (!page.jevOn) ed.append(el('span', { class: 'cc-error', text: 'No Jev provider is enabled: this rule does nothing until one is.' }))
  }
  ed.append(testEl(rule))
  return ed
}

function rulesCard() {
  const d = page.draft
  const list = el('ol', { class: 'cc-list', 'aria-label': 'Rules' })
  d.rules.forEach((rule, i) => {
    const n = i + 1
    const f = `r:${rule.id}`
    const open = page.open === rule.id
    const note = ruleNote(rule, page.jevOn)
    const main = el('div', { class: 'cc-row-main' }, el('span', { class: 'cc-row-title', text: rule.name ? `${rule.name}: ${ruleSummary(rule, d)}` : ruleSummary(rule, d) }))
    if (note) main.append(el('span', { class: 'cc-row-meta', text: note }))
    list.append(el('li', { class: `cc-row rule-row${rule.enabled ? '' : ' off'}` },
      el('span', { class: 'num', text: String(n) }),
      el('input', { type: 'checkbox', checked: rule.enabled, 'data-f': `${f}:on`, 'aria-label': `Rule ${n} enabled`, title: 'Enabled', onchange: (ev) => edit(setRule(page.draft, rule.id, { enabled: ev.target.checked })) }),
      main,
      el('span', { class: 'cc-row-actions' },
        btn(open ? 'Close' : 'Edit', () => {
          page.open = open ? null : rule.id
          later()
        }, { f: `${f}:edit`, title: open ? `Close rule ${n}` : `Edit rule ${n}`, cls: open ? 'cc-ghost' : undefined }),
        btn('↑', () => edit(moveRule(page.draft, rule.id, -1)), { cls: 'cc-icon', title: `Move rule ${n} up`, f: `${f}:up`, disabled: i === 0 }),
        btn('↓', () => edit(moveRule(page.draft, rule.id, 1)), { cls: 'cc-icon', title: `Move rule ${n} down`, f: `${f}:down`, disabled: i === d.rules.length - 1 }),
        btn('Duplicate', () => {
          const r = duplicateRule(page.draft, rule.id)
          if (r.id) page.open = r.id
          edit(r.draft)
        }, { f: `${f}:dup`, title: `Duplicate rule ${n}`, disabled: d.rules.length >= page.table.caps.rules }),
        btn('Delete', () => {
          if (page.open === rule.id) page.open = null
          edit(deleteRule(page.draft, rule.id))
        }, { cls: 'cc-danger', f: `${f}:delete`, title: `Delete rule ${n} (Discard changes undoes it)` }))))
    if (open) list.append(el('li', {}, editorEl(rule, n)))
  })
  const body = d.rules.length ? list : el('div', { class: 'cc-empty' }, el('p', { text: 'No rules: every item goes to Rest. Add one, or reset to the defaults.' }))
  const full = d.rules.length >= page.table.caps.rules
  return el('section', { class: 'cc-card' },
    el('h3', { class: 'cc-card-title', text: 'Rules' }),
    el('span', { class: 'cc-help', text: 'Checked in order; the first enabled rule that holds puts the item in its group. An item no rule takes goes to Rest.' }),
    el('div', { class: 'line' }, btn('Add rule', () => {
      const r = addRule(page.draft, page.table)
      page.open = r.id
      edit(r.draft)
    }, { f: 'r-add', disabled: full, title: full ? `At most ${page.table.caps.rules} rules` : 'A new rule at the top' })),
    body)
}

// ---- sources, agenda ----

function sourcesCard() {
  const body = page.sources.length ? el('ul', { class: 'cc-list cc-compact', 'aria-label': 'Sources' }) : el('div', { class: 'cc-empty' }, el('p', { text: 'No source yet: enable a plugin that offers an inbox feed (Chat, Mail, Jira) in this project.' }))
  for (const s of page.sources) {
    const m = sourceRow(s)
    body.append(el('li', { class: 'cc-row source-row' }, badge(m.badge || '?', s.color),
      el('div', { class: 'cc-row-main' }, el('span', { class: 'cc-row-title', text: m.label, title: m.id }), el('span', { class: m.problem ? 'cc-row-meta cc-error' : 'cc-row-meta', text: m.meta }))))
  }
  return el('section', { class: 'cc-card' }, el('h3', { class: 'cc-card-title', text: 'Sources' }), body, el('p', { class: 'cc-help', text: SOURCE_NOTE }))
}

function agendaCard() {
  const box = el('div', { class: 'agenda', role: 'radiogroup', 'aria-label': 'Agenda' })
  for (const c of AGENDA_CHOICES) {
    const r = el('input', { type: 'radio', name: 'agenda', value: c.value, checked: page.draft.agenda === c.value, 'data-f': `agenda:${c.value}`, onchange: () => edit(setAgenda(page.draft, c.value)) })
    box.append(el('label', { class: 'check' }, r, c.label))
  }
  return el('section', { class: 'cc-card' },
    el('h3', { class: 'cc-card-title', text: 'Agenda' }),
    el('span', { class: 'cc-help', text: "Today's events from the calendar plugin, in a strip of the Inbox panel." }),
    box)
}

// ---- render ----

function render() {
  const a = document.activeElement
  const focus = a && a.getAttribute ? a.getAttribute('data-f') : null
  const main = $('main')
  const error = $('error')
  main.textContent = ''
  error.textContent = ''
  if (page.fatal) {
    $('bar').hidden = true
    error.append(el('div', { class: 'cc-error-line', role: 'alert', text: page.fatal }))
    return
  }
  if (!page.draft) {
    main.append(el('div', { class: 'cc-empty' }, el('span', { class: 'cc-spinner' }), el('p', { text: 'Loading the settings…' })))
    return
  }
  if (page.open && !page.draft.rules.some((r) => r.id === page.open)) page.open = null
  renderBar()
  if (page.error) error.append(el('div', { class: 'cc-error-line', role: 'alert', text: page.error }))
  main.append(groupsCard(), rulesCard(), sourcesCard(), agendaCard())
  if (focus) {
    const n = document.querySelector(`[data-f="${CSS.escape(focus)}"]`)
    if (n && !n.disabled) n.focus({ preventScroll: true })
  }
}

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'settings' && m.settings && m.table) {
    const wasClean = !page.draft || !isDirty(page.draft, page.saved)
    page.saved = m.settings
    page.table = m.table
    page.defaults = m.defaults || null
    page.sources = Array.isArray(m.sources) ? m.sources : []
    page.jevOn = m.jev === true
    // A save's answer, or nothing edited yet: the draft is what is stored now. Edits in progress are
    // kept over a later read (the sources arriving).
    if (m.saved === true || wasClean) page.draft = draftOf(m.settings)
    if (m.saved === true) {
      page.status = 'Saved'
      page.error = null
    }
    render()
  } else if (m.type === 'refused') {
    page.status = ''
    page.error = `Not saved: ${String(m.reason || 'refused')}`
    render()
  } else if (m.type === 'test' && typeof m.ruleId === 'string') {
    page.tests[m.ruleId] = m.result && typeof m.result === 'object' ? m.result : { ok: false, reason: 'no answer' }
    render()
  } else if (m.type === 'fatal') {
    page.fatal = String(m.reason || 'Inbox settings are not available here.')
    render()
  }
})

render()
// Posts queue until the page's port arrives.
ccPanel.post({ type: 'ready' })
