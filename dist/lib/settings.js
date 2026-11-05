'use strict'
// Inbox v2's settings (design-v2 "Rules" › "Format"): groups, rules and where the agenda goes. They
// live in ctx.appStorage under one key, not in a manifest settings schema (the rules editor is an
// html settings page, and one Inbox means one set of rules in every window). Read through
// `readSettings` every time: a bad write (an older or newer Inbox, a hand edit) never breaks the
// panel.
//
// - A stored value without `version: 2` is Inbox 0.1.0's: its sources, weights, levels, boosts and
//   counts have no meaning in v2 and are dropped; only the calendar position carries over to
//   `agenda` ("in the list" and "beside" become `top`). Anything that is not an object: the defaults.
// - A v2 value whose `groups` or `rules` is not a list is replaced by the defaults (its agenda kept).
//   Inside the lists, a bad entry is dropped on its own: a group with a bad id or name, a rule with a
//   bad id, a duplicate id, a rule with any bad condition (dropping only the condition would widen
//   the rule), a rule with neither conditions nor a Jev question. A rule pointing at a group that is
//   not there goes to Rest (the settings page moves a deleted group's rules there too).
// - Rest (`rest`) is built in: always there, always last; it can be renamed and its collapsed and
//   badge flags set like any group.

const { REST, conditionOf } = require('./rules')

const KEY = 'settings'
const VERSION = 2
const AGENDA = ['top', 'bottom', 'off']
const CAPS = Object.freeze({ groups: 20, rules: 200, conditions: 20, groupName: 40, ruleName: 60, question: 300 })
// Ids are minted by the settings page. Starting with a letter or digit keeps `__proto__` and friends
// out (ids become Map keys and DOM data attributes, never object keys, but it costs nothing).
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined)
/** A one-line string, trimmed, 1..max characters, or undefined. */
function line(v, max) {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length >= 1 && s.length <= max ? s : undefined
}

const cond = (field, op, value) => ({ field, op, value })

/**
 * The defaults (also the reset). The person's workflow (feedback "Problem", decision 2): Chat first, then
 * Mail, then Jira, each source in its group, newest first. Above them a Now group takes what asks for
 * the person in Chat (an @mention, a direct message): the lane that needs an answer at once. Read
 * items go to Rest first, else the read history (Chat's and Mail's recent days, seen Jira issues)
 * would fill the source groups (decided question 3). The rules use the facts the sources emit (Chat:
 * `to: direct` for a DM, `mentionsMe` for an @mention). Jira's mentions and Gmail's `to: direct`
 * stay in their source groups: in Jira every assigned issue is `to: direct` and in Gmail most mail
 * is, so a source-wide "direct → Now" would empty the Mail and Jira groups into Now and lose the
 * Chat-then-Mail-then-Jira order.
 */
function defaults() {
  return {
    version: VERSION,
    groups: [
      { id: 'now', name: 'Now', collapsed: false, badge: true },
      { id: 'chat', name: 'Chat', collapsed: false, badge: true },
      { id: 'mail', name: 'Mail', collapsed: false, badge: true },
      { id: 'jira', name: 'Jira', collapsed: false, badge: true },
      { id: REST, name: 'Rest', collapsed: true, badge: false },
    ],
    rules: [
      { id: 'read', enabled: true, group: REST, when: [cond('read', 'is', true)] },
      { id: 'chat-mention', enabled: true, group: 'now', when: [cond('sourceKind', 'is', 'chat'), cond('mentionsMe', 'is', true)] },
      { id: 'chat-direct', enabled: true, group: 'now', when: [cond('sourceKind', 'is', 'chat'), cond('to', 'is', 'direct')] },
      { id: 'chat', enabled: true, group: 'chat', when: [cond('sourceKind', 'is', 'chat')] },
      { id: 'mail', enabled: true, group: 'mail', when: [cond('sourceKind', 'is', 'mail')] },
      { id: 'jira', enabled: true, group: 'jira', when: [cond('sourceKind', 'is', 'issues')] },
    ],
    agenda: 'top',
  }
}

function groupOf(raw) {
  const id = own(raw, 'id')
  const name = line(own(raw, 'name'), CAPS.groupName)
  if (typeof id !== 'string' || !ID.test(id) || name === undefined) return null
  return { id, name, collapsed: own(raw, 'collapsed') === true, badge: own(raw, 'badge') === true }
}

/** The groups in order, at most 20 with Rest, Rest last (its stored name and flags kept). */
function groupsOf(list) {
  const out = []
  const seen = new Set()
  let rest = null
  for (const raw of list) {
    const g = groupOf(raw)
    if (!g || seen.has(g.id)) continue
    seen.add(g.id)
    if (g.id === REST) rest = g
    else if (out.length < CAPS.groups - 1) out.push(g)
  }
  out.push(rest || { id: REST, name: 'Rest', collapsed: true, badge: false })
  return out
}

/** One rule, clean, or null (see the header for what drops a rule). */
function ruleOf(raw, groupIds) {
  const id = own(raw, 'id')
  if (typeof id !== 'string' || !ID.test(id)) return null
  const rule = { id }
  const rawName = own(raw, 'name')
  if (rawName !== undefined && rawName !== null && rawName !== '') {
    const name = line(rawName, CAPS.ruleName)
    if (name === undefined) return null
    rule.name = name
  }
  rule.enabled = own(raw, 'enabled') !== false
  const group = own(raw, 'group')
  rule.group = typeof group === 'string' && groupIds.has(group) ? group : REST
  const when = own(raw, 'when')
  if (when !== undefined) {
    if (!Array.isArray(when) || when.length > CAPS.conditions) return null
    const conds = []
    for (const c of when) {
      const clean = conditionOf(c)
      if (!clean) return null
      conds.push(clean)
    }
    if (conds.length) rule.when = conds
  }
  const jev = own(raw, 'jev')
  if (jev !== undefined) {
    const question = line(own(jev, 'question'), CAPS.question)
    const min = own(jev, 'min')
    if (question === undefined || typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > 1) return null
    rule.jev = { question, min }
  }
  // At least one of the two (decided question 4): a rule with neither would hold for everything.
  return rule.when || rule.jev ? rule : null
}

function rulesOf(list, groupIds) {
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (out.length >= CAPS.rules) break
    const r = ruleOf(raw, groupIds)
    if (!r || seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}

/** Inbox 0.1.0's calendar position as the v2 agenda ("inline" and "beside" have no slot: top). */
function agendaOfV1(raw) {
  const pos = own(own(raw, 'calendar'), 'position')
  return pos === 'bottom' || pos === 'off' ? pos : 'top'
}

/** The settings, whole and valid, from whatever was stored (undefined: the defaults). */
function readSettings(raw) {
  if (!isObj(raw)) return defaults()
  if (own(raw, 'version') !== VERSION) return { ...defaults(), agenda: agendaOfV1(raw) }
  const agenda = AGENDA.includes(own(raw, 'agenda')) ? own(raw, 'agenda') : 'top'
  const groups = own(raw, 'groups')
  const rules = own(raw, 'rules')
  if (!Array.isArray(groups) || !Array.isArray(rules)) return { ...defaults(), agenda }
  const g = groupsOf(groups)
  return { version: VERSION, groups: g, rules: rulesOf(rules, new Set(g.map((x) => x.id))), agenda }
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

/** Back to the defaults; resolves them. */
async function resetSettings(store) {
  return saveSettings(store, defaults())
}

module.exports = { KEY, VERSION, AGENDA, CAPS, ID, defaults, readSettings, loadSettings, saveSettings, resetSettings }
