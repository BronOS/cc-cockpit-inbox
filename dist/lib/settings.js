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
//
// A save from the settings page goes through `checkSettings` first: where `readSettings` quietly
// drops what does not fit (right for a stored value), a save is refused with the reason, so the
// person sees why ("rule 3, condition 2: time newerThan needs a whole number of minutes") instead
// of a rule that silently vanished.

const { REST, conditionOf, FIELDS, KINDS, TO, MAX_IN, MAX_VALUE, MAX_MINUTES } = require('./rules')

const KEY = 'settings'
const VERSION = 2
const AGENDA = ['top', 'bottom', 'off']
const CAPS = Object.freeze({ groups: 20, rules: 200, conditions: 20, groupName: 40, ruleName: 60, question: 300 })
// Ids are minted by the settings page. Starting with a letter or digit keeps `__proto__` and friends
// out (ids become Map keys and DOM data attributes, never object keys, but it costs nothing).
// A group's or rule's id: at most this long (the host cuts a page's rule id to it too).
const MAX_ID_LENGTH = 40
const ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${MAX_ID_LENGTH - 1}}$`)

const { isObj } = require('./util')
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
  // Only Inbox 0.1.0's data (no version, or 1) takes the migration path. Any other version (a newer
  // one after a downgrade) is read as v2, keeping what is valid in it, so a save does not replace the
  // person's rules with the defaults.
  const version = own(raw, 'version')
  if (version === undefined || version === 1) return { ...defaults(), agenda: agendaOfV1(raw) }
  const agenda = AGENDA.includes(own(raw, 'agenda')) ? own(raw, 'agenda') : 'top'
  const groups = own(raw, 'groups')
  const rules = own(raw, 'rules')
  if (!Array.isArray(groups) || !Array.isArray(rules)) return { ...defaults(), agenda }
  const g = groupsOf(groups)
  return { version: VERSION, groups: g, rules: rulesOf(rules, new Set(g.map((x) => x.id))), agenda }
}

/** What a value of each kind of the field table must be, for a refusal's reason. */
const NEEDS = Object.freeze({
  text: `text of 1 to ${MAX_VALUE} characters`,
  kind: `one of ${KINDS.join(', ')}`,
  to: `one of ${TO.join(', ')}`,
  bool: 'true or false',
  read: 'true, false or null',
  minutes: `a whole number of minutes from 1 to ${MAX_MINUTES}`,
})

/** A short, quoted form of an untrusted value for a reason (it is shown as text, never markup). */
const shown = (v) => {
  const s = typeof v === 'string' ? v : String(v)
  return JSON.stringify(s.length > 40 ? `${s.slice(0, 39)}…` : s)
}

/** Why a condition does not fit the field table, or null when it does (rules.js `conditionOf` decides). */
function conditionProblem(raw) {
  if (!isObj(raw)) return 'is not a condition'
  const field = own(raw, 'field')
  if (typeof field !== 'string' || !Object.hasOwn(FIELDS, field)) return `has no known field (${shown(field)})`
  const spec = FIELDS[field]
  const op = own(raw, 'op')
  if (!spec.ops.includes(op)) return `${field} takes ${spec.ops.join(', ')}, not ${shown(op)}`
  if (conditionOf(raw)) return null
  if (op === 'in') return `${field} in needs a list of 1 to ${MAX_IN} values, each ${NEEDS[spec.value]}`
  return `${field} ${op} needs ${NEEDS[spec.value]}`
}

/**
 * A save from the settings page, checked: `{ ok: true, settings }` (clean, what `readSettings` keeps:
 * Rest moved last) or `{ ok: false, reason }` naming the first thing that does not fit, by position
 * ("group 2", "rule 3, condition 1"). Nothing a check refuses would have survived `readSettings`
 * unchanged.
 */
function checkSettings(raw) {
  const no = (reason) => ({ ok: false, reason })
  if (!isObj(raw)) return no('the settings are not an object')
  if (own(raw, 'version') !== VERSION) return no('these are not Inbox v2 settings (version 2)')
  if (!AGENDA.includes(own(raw, 'agenda'))) return no('the agenda must be top, bottom or off')
  const groups = own(raw, 'groups')
  const rules = own(raw, 'rules')
  if (!Array.isArray(groups)) return no('the groups are not a list')
  if (!Array.isArray(rules)) return no('the rules are not a list')
  if (groups.length > CAPS.groups) return no(`at most ${CAPS.groups} groups, Rest included`)
  const ids = new Set()
  for (const [i, g] of groups.entries()) {
    const n = i + 1
    const id = own(g, 'id')
    if (typeof id !== 'string' || !ID.test(id)) return no(`group ${n} has a bad id`)
    if (ids.has(id)) return no(`group ${n}: the id ${shown(id)} is used twice`)
    ids.add(id)
    if (line(own(g, 'name'), CAPS.groupName) === undefined) return no(`group ${n} needs a name of 1 to ${CAPS.groupName} characters`)
  }
  if (!ids.has(REST)) return no('the Rest group is missing')
  if (rules.length > CAPS.rules) return no(`at most ${CAPS.rules} rules`)
  const ruleIds = new Set()
  for (const [i, r] of rules.entries()) {
    const n = i + 1
    if (!isObj(r)) return no(`rule ${n} is not a rule`)
    const id = own(r, 'id')
    if (typeof id !== 'string' || !ID.test(id)) return no(`rule ${n} has a bad id`)
    if (ruleIds.has(id)) return no(`rule ${n}: the id ${shown(id)} is used twice`)
    ruleIds.add(id)
    const name = own(r, 'name')
    if (name !== undefined && name !== null && name !== '' && line(name, CAPS.ruleName) === undefined) {
      return no(`rule ${n}: the name must be 1 to ${CAPS.ruleName} characters on one line`)
    }
    const enabled = own(r, 'enabled')
    if (enabled !== undefined && typeof enabled !== 'boolean') return no(`rule ${n}: enabled must be true or false`)
    const group = own(r, 'group')
    if (typeof group !== 'string' || !ids.has(group)) return no(`rule ${n} goes to a group that is not there (${shown(group)})`)
    const when = own(r, 'when')
    if (when !== undefined) {
      if (!Array.isArray(when)) return no(`rule ${n}: the conditions are not a list`)
      if (when.length > CAPS.conditions) return no(`rule ${n} has more than ${CAPS.conditions} conditions`)
      for (const [j, c] of when.entries()) {
        const p = conditionProblem(c)
        if (p) return no(`rule ${n}, condition ${j + 1}: ${p}`)
      }
    }
    const jev = own(r, 'jev')
    if (jev !== undefined) {
      if (!isObj(jev)) return no(`rule ${n}: the Jev question is not an object`)
      if (line(own(jev, 'question'), CAPS.question) === undefined) return no(`rule ${n}: the Jev question needs 1 to ${CAPS.question} characters`)
      const min = own(jev, 'min')
      if (typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > 1) return no(`rule ${n}: the Jev threshold must be a number from 0 to 1`)
    }
    if (!(Array.isArray(when) && when.length) && jev === undefined) return no(`rule ${n} needs a condition or a Jev question`)
  }
  return { ok: true, settings: readSettings(raw) }
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

module.exports = { KEY, VERSION, AGENDA, CAPS, ID, MAX_ID_LENGTH, defaults, readSettings, checkSettings, conditionProblem, loadSettings, saveSettings, resetSettings }
