'use strict'
// The Inbox settings page's decisions, free of the DOM so node:test can check them
// (test/settings-page.test.js requires this file; the page loads it as a classic script before
// index.js, where these become globals). index.js only turns them into elements, every string through
// textContent.
//
// The page edits a draft of the settings (design-v2 "Rules" › "Format") and sends it whole on Save;
// the host checks it (dist/lib/settings.js `checkSettings`) and refuses one that does not fit with the
// reason, so this file makes no promise of validity: it only keeps the draft's shape (Rest last, every
// rule pointing at a group that exists, `in` ops holding a list) and offers the choices the field
// table allows. The table comes from the host with the settings (`table`: fields, kinds, to, caps):
// one table, no copy here to drift.
//
// Every edit returns a new draft; the input is never changed.

const REST_ID = 'rest'
const OP_LABELS = Object.freeze({
  is: 'is',
  isNot: 'is not',
  in: 'is one of',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  has: 'has',
  hasNot: 'has not',
  hasPrefix: 'has one starting with',
  newerThan: 'newer than (minutes)',
  olderThan: 'older than (minutes)',
})
const AGENDA_CHOICES = Object.freeze([
  { value: 'top', label: 'Above the list' },
  { value: 'bottom', label: 'Below the list' },
  { value: 'off', label: 'Off' },
])
const DEFAULT_MIN = 0.8
const SOURCE_NOTE = 'To keep a source out of the list, add a rule "source is <its id>" to Rest, or turn its feed off in that plugin’s own settings.'

const copy = (v) => JSON.parse(JSON.stringify(v))
const str = (v) => (typeof v === 'string' ? v : '')

/** The draft a page starts from: a copy of what the host sent (the page never edits the host's object). */
function draftOf(settings) {
  return copy(settings)
}

/** Whether the draft differs from what is stored. */
function isDirty(draft, saved) {
  return canonical(draft) !== canonical(saved)
}

/** JSON text with object keys sorted: toggling a field off and on moves its key, which is no change. */
function canonical(v) {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x)
}

/** The smallest `<prefix><n>` not in `used` (ids the host accepts: a letter first, then letters and digits). */
function mintId(prefix, used) {
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`
}

const groupIds = (d) => new Set(d.groups.map((g) => g.id))
const ruleIds = (d) => new Set(d.rules.map((r) => r.id))
const findRule = (d, id) => d.rules.find((r) => r.id === id)

/** The group's name, or its id when it has none (a rule's group in a summary). */
function groupName(d, id) {
  const g = d.groups.find((x) => x.id === id)
  return g ? g.name : id
}

// ---- groups ----

/** A new group just before Rest, named `name` (or "New group"); resolves `{ draft, id }`. */
function addGroup(d, name) {
  const next = copy(d)
  const id = mintId('g', groupIds(next))
  const at = next.groups.findIndex((g) => g.id === REST_ID)
  const g = { id, name: str(name).trim() || 'New group', collapsed: false, badge: false }
  next.groups.splice(at < 0 ? next.groups.length : at, 0, g)
  return { draft: next, id }
}

function renameGroup(d, id, name) {
  const next = copy(d)
  const g = next.groups.find((x) => x.id === id)
  if (g) g.name = str(name)
  return next
}

/** `collapsed` or `badge` on or off. */
function setGroupFlag(d, id, flag, on) {
  if (flag !== 'collapsed' && flag !== 'badge') return d
  const next = copy(d)
  const g = next.groups.find((x) => x.id === id)
  if (g) g[flag] = on === true
  return next
}

/** Can the group move by `delta` (-1 up, +1 down)? Rest stays last and nothing moves below it. */
function canMoveGroup(d, id, delta) {
  const i = d.groups.findIndex((g) => g.id === id)
  const j = i + delta
  if (i < 0 || id === REST_ID || j < 0 || j >= d.groups.length) return false
  return d.groups[j].id !== REST_ID
}

function moveGroup(d, id, delta) {
  if (!canMoveGroup(d, id, delta)) return d
  const next = copy(d)
  const i = next.groups.findIndex((g) => g.id === id)
  const [g] = next.groups.splice(i, 1)
  next.groups.splice(i + delta, 0, g)
  return next
}

/** A group deleted: its rules go to Rest (design-v2 "Settings page"). Rest itself cannot go. */
function deleteGroup(d, id) {
  if (id === REST_ID || !d.groups.some((g) => g.id === id)) return d
  const next = copy(d)
  next.groups = next.groups.filter((g) => g.id !== id)
  for (const r of next.rules) if (r.group === id) r.group = REST_ID
  return next
}

/** How many rules go to the group (the delete button says what it moves). */
function rulesIn(d, id) {
  return d.rules.filter((r) => r.group === id).length
}

// ---- rules ----

/** The value a field's kind starts with in the editor. */
function defaultValue(kind) {
  switch (kind) {
    case 'kind':
      return 'chat'
    case 'to':
      return 'direct'
    case 'bool':
    case 'read':
      return true
    case 'minutes':
      return 60
    default:
      return ''
  }
}

/** A new condition: the table's first field with its first op. */
function defaultCondition(table) {
  const fields = Object.keys(table.fields)
  const field = fields.includes('sourceKind') ? 'sourceKind' : fields[0]
  const spec = table.fields[field]
  return { field, op: spec.ops[0], value: defaultValue(spec.value) }
}

/** A new rule at the top (rules the person adds go above the defaults), to the first group. */
function addRule(d, table) {
  const next = copy(d)
  const id = mintId('r', ruleIds(next))
  next.rules.unshift({ id, enabled: true, group: next.groups[0] ? next.groups[0].id : REST_ID, when: [defaultCondition(table)] })
  return { draft: next, id }
}

function moveRule(d, id, delta) {
  const i = d.rules.findIndex((r) => r.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= d.rules.length) return d
  const next = copy(d)
  const [r] = next.rules.splice(i, 1)
  next.rules.splice(j, 0, r)
  return next
}

/** A copy right below the rule, with a new id. */
function duplicateRule(d, id) {
  const i = d.rules.findIndex((r) => r.id === id)
  if (i < 0) return { draft: d, id: null }
  const next = copy(d)
  const dup = copy(next.rules[i])
  dup.id = mintId('r', ruleIds(next))
  next.rules.splice(i + 1, 0, dup)
  return { draft: next, id: dup.id }
}

function deleteRule(d, id) {
  return { ...copy(d), rules: d.rules.filter((r) => r.id !== id).map(copy) }
}

/** `enabled`, `group` or `name` of a rule (an empty name is no name). */
function setRule(d, id, patch) {
  const next = copy(d)
  const r = findRule(next, id)
  if (!r) return d
  if ('enabled' in patch) r.enabled = patch.enabled === true
  if ('group' in patch && groupIds(next).has(patch.group)) r.group = patch.group
  if ('name' in patch) {
    const name = str(patch.name)
    if (name.trim() === '') delete r.name
    else r.name = name
  }
  return next
}

/**
 * Conditions and the Jev question on or off. A rule keeps at least one of the two (decided question
 * 4): turning off the last one does nothing.
 */
function setRuleParts(d, id, parts, table) {
  const next = copy(d)
  const r = findRule(next, id)
  if (!r) return d
  const when = 'when' in parts ? parts.when === true : Array.isArray(r.when) && r.when.length > 0
  const jev = 'jev' in parts ? parts.jev === true : Boolean(r.jev)
  if (!when && !jev) return d
  if (when && !(Array.isArray(r.when) && r.when.length)) r.when = [defaultCondition(table)]
  if (!when) delete r.when
  if (jev && !r.jev) r.jev = { question: '', min: DEFAULT_MIN }
  if (!jev) delete r.jev
  return next
}

function addCondition(d, id, table) {
  const next = copy(d)
  const r = findRule(next, id)
  if (!r) return d
  r.when = [...(Array.isArray(r.when) ? r.when : []), defaultCondition(table)]
  return next
}

/** A condition removed; the last one goes only when the rule has a Jev question to stand on. */
function removeCondition(d, id, index) {
  const r = findRule(d, id)
  if (!r || !Array.isArray(r.when) || !r.when[index]) return d
  if (r.when.length === 1 && !r.jev) return d
  const next = copy(d)
  const nr = findRule(next, id)
  nr.when.splice(index, 1)
  if (!nr.when.length) delete nr.when
  return next
}

/** A value fitted to the op: `in` takes a list, every other op one value. */
function fitValue(value, op, kind) {
  if (op === 'in') {
    if (Array.isArray(value)) return value
    return value === '' || value === undefined || value === null ? [] : [value]
  }
  if (Array.isArray(value)) return value.length ? value[0] : defaultValue(kind)
  return value
}

/**
 * One condition changed: `field`, `op` or `value`. A new field keeps the op when the field takes it
 * (else its first op) and the value when its kind is the same (else the kind's default).
 */
function setCondition(d, id, index, patch, table) {
  const r = findRule(d, id)
  if (!r || !Array.isArray(r.when) || !r.when[index]) return d
  const next = copy(d)
  const c = findRule(next, id).when[index]
  const before = table.fields[c.field]
  if ('field' in patch && Object.hasOwn(table.fields, patch.field)) {
    const spec = table.fields[patch.field]
    c.field = patch.field
    if (!spec.ops.includes(c.op)) c.op = spec.ops[0]
    if (!before || before.value !== spec.value) c.value = defaultValue(spec.value)
  }
  const spec = table.fields[c.field]
  if ('op' in patch && spec && spec.ops.includes(patch.op)) c.op = patch.op
  if ('value' in patch) c.value = patch.value
  if (spec) c.value = fitValue(c.value, c.op, spec.value)
  return next
}

/** The Jev question's text or threshold. */
function setJev(d, id, patch) {
  const next = copy(d)
  const r = findRule(next, id)
  if (!r || !r.jev) return d
  if ('question' in patch) r.jev.question = str(patch.question)
  if ('min' in patch) r.jev.min = patch.min
  return next
}

function setAgenda(d, agenda) {
  return AGENDA_CHOICES.some((c) => c.value === agenda) ? { ...copy(d), agenda } : d
}

// ---- inputs ----

/** A condition's value as its input shows it: a list one per line, a boolean or null as its word. */
function valueText(value) {
  if (Array.isArray(value)) return value.map(String).join('\n')
  if (value === null) return 'null'
  return String(value)
}

/**
 * An input's text as a condition's value of `kind`: a list (`in`) one value per line, blank lines
 * dropped; `minutes` a whole number when it is one (anything else stays text, and the host refuses it
 * with the reason); `bool` / `read` from their words.
 */
function parseValue(text, kind, op) {
  const one = (s) => {
    if (kind === 'minutes') return /^\s*\d+\s*$/.test(s) ? Number(s) : s
    if (kind === 'bool') return s === 'true'
    if (kind === 'read') return s === 'null' ? null : s === 'true'
    return s
  }
  if (op === 'in') {
    return str(text)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(one)
  }
  return one(str(text))
}

/** The threshold input's text as a number (anything not a number stays text: the host refuses it). */
function parseMin(text) {
  const s = str(text).trim()
  return /^(0(\.\d+)?|1(\.0+)?|\.\d+)$/.test(s) ? Number(s) : s
}

/**
 * What a condition's value control is: `select` (one of `options`), `checks` (several of `options`,
 * an `in` over a fixed list), `lines` (an `in` list of text, one per line), `number` or `text`.
 */
function valueControl(cond, table) {
  const spec = table.fields[cond.field]
  const kind = spec ? spec.value : 'text'
  const fixed = kind === 'kind' ? table.kinds : kind === 'to' ? table.to : null
  if (fixed) return cond.op === 'in' ? { type: 'checks', options: fixed } : { type: 'select', options: fixed }
  if (kind === 'bool') return { type: 'select', options: ['true', 'false'] }
  if (kind === 'read') return { type: 'select', options: ['true', 'false', 'null'] }
  if (kind === 'minutes') return { type: 'number', min: 1, max: table.caps.minutes }
  if (cond.op === 'in') return { type: 'lines', max: table.caps.value }
  return { type: 'text', max: table.caps.value }
}

/** The op choices of a field, with their words. */
function opChoices(field, table) {
  const spec = table.fields[field]
  return (spec ? spec.ops : []).map((op) => ({ value: op, label: OP_LABELS[op] || op }))
}

// ---- what the page says ----

/** A condition in words: `sourceKind is chat`, `from.address is one of a@example.com, b@example.com`. */
function conditionText(c) {
  const v = Array.isArray(c.value) ? c.value.map(String).join(', ') : String(c.value)
  return `${c.field} ${OP_LABELS[c.op] || c.op} ${v}`
}

/** One line for a rule in the list: what it checks, then where it puts what holds. */
function ruleSummary(rule, d) {
  const parts = []
  if (Array.isArray(rule.when) && rule.when.length) parts.push(rule.when.map(conditionText).join(' and '))
  if (rule.jev) parts.push(`Jev: “${str(rule.jev.question) || '…'}” at least ${rule.jev.min}`)
  return `${parts.join(' and ') || 'nothing'} → ${groupName(d, rule.group)}`
}

/** Why a rule does nothing now, or null: disabled, or a Jev rule with no `jev` provider. */
function ruleNote(rule, jevOn) {
  if (!rule.enabled) return 'disabled'
  if (rule.jev && !jevOn) return 'inactive: no Jev provider is enabled'
  return null
}

/** The "Test" result in words. */
function testText(result) {
  if (!result || result.ok !== true) return `Cannot test: ${str(result && result.reason) || 'no answer'}`
  if (!result.total) return 'No items in the Inbox to test against.'
  const taken = result.holds - result.placed
  let s = `Would place ${result.placed} of ${result.total} items`
  if (taken > 0) s += ` (holds for ${result.holds}; ${taken} placed by an earlier rule)`
  s += '.'
  if (result.pending > 0) s += ` ${result.pending} have no Jev answer yet (Test never asks).`
  return s
}

/** A source line, read-only: label, then kind, scope, state, count. */
function sourceRow(s) {
  const state = str(s.state) || 'unknown'
  const meta = [str(s.kind), str(s.scope), s.message ? `${state}: ${str(s.message)}` : state, `${Number.isFinite(s.count) ? s.count : 0} items`].filter(Boolean)
  return { label: str(s.label) || str(s.pluginId), id: str(s.pluginId), badge: str(s.badge), meta: meta.join(' · '), problem: state !== 'ok' }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REST_ID,
    OP_LABELS,
    AGENDA_CHOICES,
    DEFAULT_MIN,
    SOURCE_NOTE,
    draftOf,
    isDirty,
    mintId,
    groupName,
    addGroup,
    renameGroup,
    setGroupFlag,
    canMoveGroup,
    moveGroup,
    deleteGroup,
    rulesIn,
    defaultValue,
    defaultCondition,
    addRule,
    moveRule,
    duplicateRule,
    deleteRule,
    setRule,
    setRuleParts,
    addCondition,
    removeCondition,
    fitValue,
    setCondition,
    setJev,
    setAgenda,
    valueText,
    parseValue,
    parseMin,
    valueControl,
    opChoices,
    conditionText,
    ruleSummary,
    ruleNote,
    testText,
    sourceRow,
  }
}
