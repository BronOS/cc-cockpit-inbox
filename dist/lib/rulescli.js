'use strict'
// `ccc inbox rules ...` and `ccc inbox groups ...` (design-v2 "CLI" › "Rules and groups"): argument
// parsing, the edits and the printed text, so a Claude tab can read and change the rules the settings
// page edits. Pure: the host picks the set (scope), checks every result with lib/settings.js
// `checkSettings` and stores it through the same save paths as a page save. Nothing here validates a
// rule: an edit only builds the next whole set, and the one validator decides (no second copy to
// drift). The group and id helpers are the settings page's own (settings/logic.js: `mintId`,
// `addGroup`, `deleteGroup`), so an id minted here or a group deleted here is what the page would do.
//
// - Numbers are 1-based positions as `ccc inbox rules` prints them (rules counting disabled ones, as
//   the page and `why` do; groups counting Rest, always last). A group is also named by its id; a
//   word of digits only is a position.
// - `rules add` without `--at` puts the rule after the leading rules that go to Rest and before the
//   first rule that goes elsewhere (at the end when every rule goes to Rest). The leading Rest rules
//   are filters such as the default `read is true` → Rest, which should keep winning (decided question
//   3: else the read history fills the groups); after them the list runs from specific to general
//   (the default per-source catch-alls last), and a rule someone adds is nearly always more specific
//   than those, so the end would be wrong: `sourceKind is mail` → Mail would take every mail first.
// - Untrusted text: the set may hold anything a person or Claude typed, so every printed line goes
//   through `oneLine` and is cut; the export is JSON (escaped by JSON.stringify) and bounded.

const { conditionText, REST } = require('./rules')
const { isObj } = require('./util')
const { oneLine } = require('./cli')
const L = require('../../settings/logic')

const MAX_LINE = 400
const MAX_NAME = 80
// The app cuts each output at 256 KiB once JSON-encoded: an export over this is refused, never cut
// (a cut JSON text would import as an error at best).
const MAX_EXPORT = 250 * 1024
// How many items `rules test` lists (the page shows 5; a terminal has room for more).
const TEST_LIST = 20

const SCOPES = Object.freeze({ '--global': 'global', '--project': 'project' })
const USAGE_RULES = 'ccc inbox rules [list|export|import|add <json|->|set <n> <json|->|rm <n>|move <n> <to>|enable <n>|disable <n>|test <json|-|n>] [--global|--project] [--at <n>]'
const USAGE_GROUPS = 'ccc inbox groups [list|add <name> [--badge] [--collapsed] [--at <n>]|rename <id|n> <name>|rm <id|n>|move <id|n> <to>] [--global|--project]'

// What each subcommand takes: its positional words (`n`: a position, `ref`: a group id or position,
// `json`: JSON text or `-`, `name`: the rest of the words) and the flags beyond the scope.
const SUBS = Object.freeze({
  rules: {
    list: { args: [], flags: [] },
    export: { args: [], flags: [] },
    import: { args: [], optional: ['-'], flags: [] },
    add: { args: ['json'], flags: ['--at'] },
    set: { args: ['n', 'json'], flags: [] },
    rm: { args: ['n'], flags: [] },
    move: { args: ['n', 'n'], flags: [] },
    enable: { args: ['n'], flags: [] },
    disable: { args: ['n'], flags: [] },
    test: { args: ['json'], flags: ['--at'] },
  },
  groups: {
    list: { args: [], flags: [] },
    add: { args: ['name'], flags: ['--at', '--badge', '--collapsed'] },
    rename: { args: ['ref', 'name'], flags: [] },
    rm: { args: ['ref'], flags: [] },
    move: { args: ['ref', 'n'], flags: [] },
  },
})

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const isNum = (w) => /^\d{1,4}$/.test(w) && Number(w) >= 1

/**
 * `argv` from `rules` or `groups` on: `{ cmd: 'rules'|'groups', sub, scope, at, badge, collapsed,
 * args }` or `{ error }` (a usage error, exit 2). `scope` is null (the set in effect), `global` or
 * `project`.
 */
function parse(argv) {
  const [cmd, ...words] = argv
  const usage = (m) => ({ error: `${m}\nUsage: ${cmd === 'groups' ? USAGE_GROUPS : USAGE_RULES}\n(ccc inbox help for details)` })
  const p = { cmd, sub: null, scope: null, at: null, badge: false, collapsed: false, args: [] }
  const flags = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (Object.hasOwn(SCOPES, w)) {
      if (p.scope && p.scope !== SCOPES[w]) return usage('use --global or --project, not both')
      p.scope = SCOPES[w]
    } else if (w === '--at') {
      const n = words[++i]
      if (n === undefined || !isNum(n)) return usage('--at needs a position (1, 2, ...)')
      p.at = Number(n)
      flags.push(w)
    } else if (w === '--badge' || w === '--collapsed') {
      p[w.slice(2)] = true
      flags.push(w)
    } else if (w === 'help' || w === '--help' || w === '-h') {
      if (p.sub === null) return { cmd: 'help' }
      p.args.push(w)
    } else if (w.startsWith('--')) return usage(`unknown option ${oneLine(w, 40)}`)
    else if (p.sub === null) p.sub = w
    else p.args.push(w)
  }
  if (p.sub === null) p.sub = 'list'
  const spec = SUBS[cmd] && Object.hasOwn(SUBS[cmd], p.sub) ? SUBS[cmd][p.sub] : null
  if (!spec) return usage(`unknown ${cmd} command "${oneLine(p.sub, 40)}"`)
  for (const f of flags) if (!spec.flags.includes(f)) return usage(`${cmd} ${p.sub} takes no ${f}`)
  const what = `${cmd} ${p.sub}`
  if (spec.optional) {
    if (p.args.length > spec.optional.length || p.args.some((a, i) => a !== spec.optional[i])) return usage(`${what} reads the JSON from stdin and takes no other argument`)
    p.args = []
    return p
  }
  const nameAt = spec.args.indexOf('name')
  if (nameAt >= 0 && p.args.length > nameAt) p.args = [...p.args.slice(0, nameAt), p.args.slice(nameAt).join(' ')]
  if (p.args.length < spec.args.length) {
    const need = { n: 'a rule number', ref: 'a group id or number', json: 'JSON (one quoted argument, or - to read it from stdin)', name: 'a name' }
    return usage(`${what} needs ${need[spec.args[p.args.length]]}`)
  }
  if (p.args.length > spec.args.length) {
    const json = spec.args.includes('json')
    return usage(json ? `${what}: pass the JSON as one quoted argument, or - and pipe it on stdin` : `${what} takes ${spec.args.length} argument${spec.args.length === 1 ? '' : 's'}`)
  }
  for (const [i, kind] of spec.args.entries()) {
    if (kind === 'n' && !isNum(p.args[i])) return usage(`${what}: "${oneLine(p.args[i], 40)}" is not a position (1, 2, ...)`)
  }
  if (cmd === 'rules' && p.sub === 'test' && isNum(p.args[0]) && p.at !== null) return usage('rules test <n> tests rule n where it stands: --at is for a new rule')
  return p
}

/** JSON from an argument or, for `-`, from stdin: `{ value }` or `{ error }`. */
function jsonOf(arg, stdin, what) {
  const fromStdin = arg === '-'
  const text = fromStdin ? String(stdin || '') : arg
  if (!text.trim()) return { error: fromStdin ? `no ${what} on stdin: pipe the JSON in (… | ccc inbox …) ` : `the ${what} is empty` }
  try {
    return { value: JSON.parse(text) }
  } catch (e) {
    return { error: `the ${what} is not JSON: ${oneLine(e && e.message, 200)}` }
  }
}

// ---- the text ----

/** What a rule checks, as `why` and the rows phrase it, and where it puts what holds. */
function ruleText(rule, set) {
  const parts = []
  if (Array.isArray(rule.when) && rule.when.length) parts.push(rule.when.map(conditionText).join(' and '))
  if (rule.jev) parts.push(`Jev "${rule.jev.question}" >= ${rule.jev.min}`)
  const name = rule.name ? `"${rule.name}": ` : ''
  return `${name}${parts.join(' and ')} → ${L.groupName(set, rule.group)}`
}

/** One numbered rule line: `3. on: sourceKind is chat → Chat [id chat]`. */
function ruleLine(rule, n, set) {
  return oneLine(`${n}. ${rule.enabled ? 'on' : 'off'}: ${ruleText(rule, set)} [id ${rule.id}]`, MAX_LINE)
}

function groupLine(g, n) {
  const flags = [g.id === REST ? 'built in, always last' : null, g.collapsed ? 'collapsed' : null, g.badge ? 'badge' : null].filter(Boolean)
  return oneLine(`${n}. ${g.name} [id ${g.id}]${flags.length ? ` (${flags.join(', ')})` : ''}`, MAX_LINE)
}

/**
 * Which set a command works on, in words: `set` is `global` or `project`, `own` whether this project
 * has a set of its own.
 */
function setTitle(set, own) {
  if (set === 'project') return "this project's rules (its own set; the global rules do not apply here)"
  return own ? 'global rules (not in effect here: this project has its own set)' : 'global rules (this project uses the global set)'
}

/** `ccc inbox rules` (and `groups`): the header, the groups, the numbered rules, the agenda. */
function formatSet(settings, set, own) {
  const out = [`Inbox ${setTitle(set, own)}`, '', 'Groups, in order:']
  settings.groups.forEach((g, i) => out.push(`  ${groupLine(g, i + 1)}`))
  out.push('', 'Rules: the first enabled rule that holds places an item; when none holds it goes to Rest.')
  if (!settings.rules.length) out.push('  (none: everything goes to Rest)')
  settings.rules.forEach((r, i) => out.push(`  ${ruleLine(r, i + 1, settings)}`))
  out.push('', `Agenda: ${settings.agenda}`)
  return `${out.join('\n')}\n`
}

/** The set as JSON (pretty when it fits the output limit, else compact), or `{ error }` when even compact does not. */
function exportText(settings) {
  const fits = (t) => JSON.stringify(t).length <= MAX_EXPORT
  const pretty = `${JSON.stringify(settings, null, 2)}\n`
  if (fits(pretty)) return { stdout: pretty }
  const compact = `${JSON.stringify(settings)}\n`
  if (fits(compact)) return { stdout: compact }
  return { error: `the set is too large for one output (${Math.round(compact.length / 1024)} KiB, the limit is ${MAX_EXPORT / 1024} KiB)` }
}

// ---- the edits: each builds the next whole set; the host checks it ----

const copy = (v) => JSON.parse(JSON.stringify(v))
const ruleIds = (s) => new Set(s.rules.map((r) => r.id))

/** Where `rules add` puts a rule without `--at` (1-based; see the header). */
function defaultAt(settings) {
  const i = settings.rules.findIndex((r) => r.group !== REST)
  return i < 0 ? settings.rules.length + 1 : i + 1
}

/** A group by id or 1-based position, or `{ error }`. */
function groupRef(settings, ref) {
  const i = isNum(ref) ? Number(ref) - 1 : settings.groups.findIndex((g) => g.id === ref)
  const g = settings.groups[i]
  if (!g) return { error: isNum(ref) ? `no group ${ref}: the set has ${settings.groups.length}` : `no group with the id "${oneLine(ref, 40)}" (ccc inbox rules lists them)` }
  return { g, i }
}

/** A rule position in range, or `{ error }`. */
function ruleAt(settings, n, extra = 0) {
  const max = settings.rules.length + extra
  if (n < 1 || n > max) return { error: settings.rules.length ? `no rule ${n}: the set has ${settings.rules.length}` : 'no rule: the set has none' }
  return { i: n - 1 }
}

/** A whole set given as JSON with the ids it lacks minted the editor's way (`g1`, `r1`, ...); given ids are kept. */
function withIds(raw) {
  if (!isObj(raw)) return { value: raw, minted: 0 }
  const v = { ...raw }
  let minted = 0
  for (const [key, prefix] of [['groups', 'g'], ['rules', 'r']]) {
    if (!Array.isArray(v[key])) continue
    const used = new Set(v[key].map((x) => (isObj(x) && typeof x.id === 'string' ? x.id : null)).filter(Boolean))
    v[key] = v[key].map((x) => {
      if (!isObj(x) || Object.hasOwn(x, 'id')) return x
      const id = L.mintId(prefix, used)
      used.add(id)
      minted++
      return { id, ...x }
    })
  }
  return { value: v, minted }
}

/** One rule given as JSON, ready to go into `settings`: an id minted when it has none. */
function newRule(raw, settings) {
  if (!isObj(raw)) return { error: 'a rule is a JSON object: {"group": "<group id>", "when": [...]} or {"group": ..., "jev": {...}}' }
  if (Object.hasOwn(raw, 'id')) return { rule: { ...raw } }
  return { rule: { id: L.mintId('r', ruleIds(settings)), ...raw } }
}

/**
 * An edit of `settings` (clean, the set in scope) by `p` (from `parse`), with `stdin`: `{ draft,
 * report(saved) }` (the next whole set, unchecked, and the line to print once it is stored) or
 * `{ error }`. `import` and the rule/group edits come here; `list`, `export` and `test` do not.
 */
function edit(settings, p, stdin) {
  const s = copy(settings)
  const [a, b] = p.args
  if (p.cmd === 'rules') {
    switch (p.sub) {
      case 'import': {
        const j = jsonOf('-', stdin, 'set')
        if (j.error) return j
        const { value, minted } = withIds(j.value)
        return {
          draft: value,
          report: (saved) => `Imported: ${plural(saved.groups.length, 'group')}, ${plural(saved.rules.length, 'rule')}, agenda ${saved.agenda}${minted ? ` (${plural(minted, 'id')} minted)` : ''}`,
        }
      }
      case 'add': {
        const j = jsonOf(a, stdin, 'rule')
        if (j.error) return j
        const r = newRule(j.value, s)
        if (r.error) return r
        const n = p.at ?? defaultAt(s)
        const at = ruleAt(s, n, 1)
        if (at.error) return { error: `--at ${n}: a new rule goes at 1 to ${s.rules.length + 1}` }
        s.rules.splice(at.i, 0, r.rule)
        return { draft: s, report: (saved) => `Added rule ${ruleLine(saved.rules[at.i], n, saved)}` }
      }
      case 'set': {
        const at = ruleAt(s, Number(a))
        if (at.error) return at
        const j = jsonOf(b, stdin, 'rule')
        if (j.error) return j
        if (!isObj(j.value)) return newRule(j.value, s)
        const old = s.rules[at.i]
        // Replaced whole, but what the JSON leaves out of id and on/off is the old rule's: a rule's id
        // is its Jev cache and the trace's name for it, and "set" is not "enable".
        s.rules[at.i] = { id: old.id, enabled: old.enabled, ...j.value }
        return { draft: s, report: (saved) => `Replaced rule ${ruleLine(saved.rules[at.i], at.i + 1, saved)}` }
      }
      case 'rm': {
        const at = ruleAt(s, Number(a))
        if (at.error) return at
        const line = ruleLine(s.rules[at.i], at.i + 1, s)
        s.rules.splice(at.i, 1)
        return { draft: s, report: () => `Removed rule ${line}` }
      }
      case 'move': {
        const from = ruleAt(s, Number(a))
        if (from.error) return from
        const to = ruleAt(s, Number(b))
        if (to.error) return { error: `cannot move to ${b}: the set has ${s.rules.length} rules` }
        const [r] = s.rules.splice(from.i, 1)
        s.rules.splice(to.i, 0, r)
        return { draft: s, report: (saved) => `Moved rule ${a} to ${ruleLine(saved.rules[to.i], to.i + 1, saved)}` }
      }
      case 'enable':
      case 'disable': {
        const at = ruleAt(s, Number(a))
        if (at.error) return at
        s.rules[at.i].enabled = p.sub === 'enable'
        return { draft: s, report: (saved) => `${p.sub === 'enable' ? 'Enabled' : 'Disabled'} rule ${ruleLine(saved.rules[at.i], at.i + 1, saved)}` }
      }
      default:
        return { error: `rules ${p.sub} is not an edit` }
    }
  }
  switch (p.sub) {
    case 'add': {
      const max = s.groups.length
      if (p.at !== null && p.at > max) return { error: `--at ${p.at}: a new group goes at 1 to ${max} (Rest stays last)` }
      const { draft, id } = L.addGroup(s, a)
      const g = draft.groups.find((x) => x.id === id)
      g.badge = p.badge
      g.collapsed = p.collapsed
      if (p.at !== null) {
        draft.groups.splice(draft.groups.indexOf(g), 1)
        draft.groups.splice(p.at - 1, 0, g)
      }
      return { draft, report: (saved) => `Added group ${groupLine(saved.groups.find((x) => x.id === id), saved.groups.findIndex((x) => x.id === id) + 1)}` }
    }
    case 'rename': {
      const r = groupRef(s, a)
      if (r.error) return r
      return { draft: L.renameGroup(s, r.g.id, b), report: (saved) => `Renamed group ${groupLine(saved.groups[r.i], r.i + 1)}` }
    }
    case 'rm': {
      const r = groupRef(s, a)
      if (r.error) return r
      if (r.g.id === REST) return { error: 'Rest is built in and cannot be removed (rename it instead)' }
      const moved = L.rulesIn(s, r.g.id)
      const line = groupLine(r.g, r.i + 1)
      return { draft: L.deleteGroup(s, r.g.id), report: () => `Removed group ${line}${moved ? `; its ${moved} rule${moved === 1 ? ' now goes' : 's now go'} to Rest` : ''}` }
    }
    case 'move': {
      const r = groupRef(s, a)
      if (r.error) return r
      if (r.g.id === REST) return { error: 'Rest is built in and stays last' }
      const to = Number(b)
      if (to > s.groups.length - 1) return { error: `cannot move to ${b}: groups go at 1 to ${s.groups.length - 1} (Rest stays last)` }
      const [g] = s.groups.splice(r.i, 1)
      s.groups.splice(to - 1, 0, g)
      return { draft: s, report: (saved) => `Moved group ${groupLine(saved.groups[to - 1], to)}` }
    }
    default:
      return { error: `groups ${p.sub} is not an edit` }
  }
}

/**
 * `rules test`: the draft to try and the rule's id, from `<n>` (a rule of the set, where it stands)
 * or a new rule as JSON (put where `rules add` would, or `--at`): `{ draft, ruleId, n, isNew }` or
 * `{ error }`.
 */
function testDraft(settings, p, stdin) {
  const [a] = p.args
  if (isNum(a)) {
    const at = ruleAt(settings, Number(a))
    if (at.error) return at
    return { draft: settings, ruleId: settings.rules[at.i].id, n: at.i + 1, isNew: false }
  }
  const j = jsonOf(a, stdin, 'rule')
  if (j.error) return j
  const s = copy(settings)
  const r = newRule(j.value, s)
  if (r.error) return r
  const n = p.at ?? defaultAt(s)
  const at = ruleAt(s, n, 1)
  if (at.error) return { error: `--at ${n}: a new rule goes at 1 to ${s.rules.length + 1}` }
  s.rules.splice(at.i, 0, r.rule)
  return { draft: s, ruleId: r.rule.id, n, isNew: true }
}

/**
 * The result of the host's `testRule` in words: the rule, the counts as the page says them, the Jev
 * note, then up to TEST_LIST of the items it would place (title, source, ref).
 */
function formatTest(result, t, set, own) {
  const rule = result.settings.rules[t.n - 1]
  const out = [
    `Test of ${t.isNew ? `a new rule at ${t.n}` : `rule ${t.n}`} in the ${setTitle(set, own)}; nothing is stored:`,
    `  ${ruleLine(rule, t.n, result.settings)}${!rule.enabled ? ' (disabled: tried as if enabled)' : ''}`,
  ]
  if (!result.total) out.push('No items in the Inbox of this window to test against.')
  else {
    const taken = result.holds - result.placed
    out.push(`Would place ${result.placed} of the ${result.total} items in this window${taken > 0 ? ` (holds for ${result.holds}; ${taken} placed by an earlier rule first)` : ''}.`)
  }
  if (rule.jev) {
    if (!result.jev) out.push('Jev: no jev provider is enabled, so this rule places nothing for now (a test uses cached answers only).')
    else out.push(`Jev: cached answers only (a test never asks Jev)${result.pending ? `; ${result.pending} item${result.pending === 1 ? ' has' : 's have'} no answer yet and ${result.pending === 1 ? 'is' : 'are'} not counted` : ''}.`)
  }
  for (const e of result.examples) out.push(`  [${oneLine(e.badge, 12)}] ${oneLine(e.title, 120)} (${oneLine(e.label, 40)}) ${oneLine(e.source, 80)}:${oneLine(e.id, 120)}`)
  if (result.placed > result.examples.length) out.push(`  … and ${result.placed - result.examples.length} more`)
  return `${out.join('\n')}\n`
}

module.exports = { MAX_EXPORT, TEST_LIST, SUBS, USAGE_RULES, USAGE_GROUPS, parse, jsonOf, ruleText, ruleLine, setTitle, formatSet, exportText, defaultAt, withIds, edit, testDraft, formatTest }
