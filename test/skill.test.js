'use strict'
// Drift guard: the inbox-source skill (skills/inbox-source/) states the feed contract in prose, and the
// inbox-rules skill (skills/inbox-rules/) the rule format and the commands. These tests read the numbers
// and names from the validation code (dist/lib/feed.js, dist/lib/rules.js, dist/lib/settings.js), the
// CLI (dist/lib/rulescli.js) and the manifest, and fail when a skill's text no longer carries them.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { CAPS, itemOf } = require('../dist/lib/feed')
const R = require('../dist/lib/rules')
const S = require('../dist/lib/settings')
const RC = require('../dist/lib/rulescli')

const ROOT = path.join(__dirname, '..')
const DIR = 'skills/inbox-source'
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
const skill = fs.readFileSync(path.join(ROOT, DIR, 'SKILL.md'), 'utf8')
const contract = fs.readFileSync(path.join(ROOT, DIR, 'contract.md'), 'utf8')
const fix = `Update ${DIR}/contract.md (and SKILL.md) to match the code.`

const RULES_DIR = 'skills/inbox-rules'
const rulesSkill = fs.readFileSync(path.join(ROOT, RULES_DIR, 'SKILL.md'), 'utf8')
const rulesFix = `Update ${RULES_DIR}/SKILL.md to match the code.`

/** The front matter the app accepts: exactly `name` and a plain one-line `description`. */
function frontMatter(text, id) {
  const m = new RegExp(`^---\\nname: ${id}\\ndescription: ([^\\n]+)\\n---\\n`).exec(text)
  assert.ok(m, `${id}/SKILL.md front matter must be exactly name and description`)
  assert.ok(m[1].length <= 1024 && !m[1].includes(': ') && !m[1].includes(' #') && !/^['"]/.test(m[1]), 'description must be a plain YAML string')
  assert.ok(!text.includes('\r'), 'no CRLF')
}

test('the skills are declared and their front matter is the two lines the app accepts', () => {
  assert.deepEqual(manifest.contributes.skills, [{ id: 'inbox-source', dir: DIR }, { id: 'inbox-rules', dir: RULES_DIR }])
  frontMatter(skill, 'inbox-source')
  frontMatter(rulesSkill, 'inbox-rules')
  assert.match(skill, /contract\.md/)
})

test('the feed version Inbox accepts is the one the skill tells sources to provide', () => {
  const v = manifest.services.uses['inbox-feed']
  assert.ok(v >= 1)
  assert.ok(contract.includes(`"inbox-feed": ${v}`), `contract.md must show "inbox-feed": ${v}. ${fix}`)
  assert.ok(contract.includes(`inbox-feed\` v${v}`), `contract.md must name v${v}. ${fix}`)
})

test('the caps in the skill are the caps of the validation code', () => {
  const must = (n, what) => assert.ok(new RegExp(`\\b${n}\\b`).test(contract), `${DIR}/contract.md must state ${what} = ${n}. ${fix}`)
  must(CAPS.perSource, 'items per source')
  must(CAPS.gone, 'ids per gone event')
  must(CAPS.id, 'id length')
  must(CAPS.rev, 'rev length')
  must(CAPS.title, 'title length')
  must(CAPS.preview, 'preview length')
  must(CAPS.name, 'name length')
  must(CAPS.address, 'address length')
  must(CAPS.placeStatus, 'place status length')
  must(CAPS.labels, 'labels count')
  must(CAPS.labelLen, 'label length')
  must(CAPS.actions, 'actions count')
  must(CAPS.message, 'message length')
  must(CAPS.scope, 'scope length')
  must(CAPS.label, 'describe label length')
  must(CAPS.badge, 'badge length')
})

test('every item field and well-known action the code knows is named in the skill', () => {
  // Fields: whatever itemOf returns for a fully populated item.
  const full = {
    id: 'a', rev: 'r', title: 't', time: 1, read: true, mentionsMe: true, preview: 'p', to: 'direct',
    from: { name: 'n', address: 'a' }, place: { kind: 'project', name: 'n', status: 's' }, labels: ['l'],
    actions: [{ id: 'open', label: 'Open' }],
  }
  const { item } = itemOf(full)
  for (const k of Object.keys(item)) assert.ok(contract.includes(`\`${k}\``) || contract.includes(` ${k}`), `contract.md must name the item field ${k}. ${fix}`)
  for (const k of ['name', 'address', 'kind', 'status']) assert.ok(contract.includes(k), `contract.md must name ${k}. ${fix}`)
  // Action ids and place kinds are read from the validation code's source.
  const src = fs.readFileSync(path.join(ROOT, 'dist/lib/feed.js'), 'utf8')
  const kinds = /PLACE_KINDS = new Set\(\[([^\]]*)\]/.exec(src)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1))
  for (const k of kinds) assert.ok(contract.includes(`\`${k}\``), `contract.md must list the place kind ${k}. ${fix}`)
  const tos = /TO = new Set\(\[([^\]]*)\]/.exec(src)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1))
  for (const k of tos) assert.ok(contract.includes(`\`${k}\``), `contract.md must list the "to" value ${k}. ${fix}`)
  // The action-id pattern is quoted verbatim; the well-known ids come from the design's list the panel uses.
  const pat = /ACTION_ID = \/(.*)\//.exec(src)[1]
  assert.ok(contract.includes(pat), `contract.md must quote the action id pattern ${pat}. ${fix}`)
  for (const id of ['open', 'markRead', 'markUnread', 'done']) assert.ok(contract.includes(`\`${id}\``), `contract.md must list the action ${id}. ${fix}`)
  for (const c of ['green', 'red', 'blue', 'amber', 'violet', 'grey']) assert.ok(contract.includes(c), `contract.md must list color ${c}. ${fix}`)
  for (const k of ['chat', 'mail', 'issues', 'other']) assert.ok(contract.includes(k), `contract.md must list kind ${k}. ${fix}`)
  for (const s of ['ok', 'signedOut', 'error']) assert.ok(contract.includes(s), `contract.md must list state ${s}. ${fix}`)
})

// ---- inbox-rules ----

/** The skill's field table: field → { ops, value } from its `| `field` | `op`, ... | value |` rows. */
function skillTable() {
  const rows = new Map()
  for (const m of rulesSkill.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)) {
    rows.set(m[1], { ops: [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]), value: m[3] })
  }
  return rows
}

test('inbox-rules: the field table is the validation code\'s, every field with exactly its ops', () => {
  const rows = skillTable()
  assert.deepEqual([...rows.keys()].sort(), Object.keys(R.FIELDS).sort(), `the table must list exactly the fields of rules.js FIELDS. ${rulesFix}`)
  for (const [field, spec] of Object.entries(R.FIELDS)) {
    assert.deepEqual(rows.get(field).ops, spec.ops, `the ops of ${field} must be ${spec.ops.join(', ')}, in that order. ${rulesFix}`)
  }
  // The values of the fixed-list kinds are named on their rows.
  for (const [field, spec] of Object.entries(R.FIELDS)) {
    const v = rows.get(field).value
    if (spec.value === 'kind') for (const k of R.KINDS) assert.ok(v.includes(`\`${k}\``), `${field} must list ${k}. ${rulesFix}`)
    if (spec.value === 'to') for (const k of R.TO) assert.ok(v.includes(`\`${k}\``), `${field} must list ${k}. ${rulesFix}`)
    if (spec.value === 'bool') assert.match(v, /true or false/)
    if (spec.value === 'read') assert.match(v, /true, false or null/)
    if (spec.value === 'minutes') assert.ok(v.includes(`1 to ${R.MAX_MINUTES}`), `${field} must say 1 to ${R.MAX_MINUTES}. ${rulesFix}`)
  }
  const src = fs.readFileSync(path.join(ROOT, 'dist/lib/feed.js'), 'utf8')
  const kinds = /PLACE_KINDS = new Set\(\[([^\]]*)\]/.exec(src)[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1))
  for (const k of kinds) assert.ok(rows.get('place.kind').value.includes(`\`${k}\``), `place.kind must list ${k}. ${rulesFix}`)
})

test('inbox-rules: the caps and values the skill states are the validation code\'s', () => {
  const must = (text, what) => assert.ok(rulesSkill.includes(text), `${RULES_DIR}/SKILL.md must state ${what} ("${text}"). ${rulesFix}`)
  must(`1 to ${R.MAX_VALUE} characters`, 'the text value length')
  must(`1 to ${R.MAX_IN} values`, 'the in list length')
  must(`at most ${S.CAPS.groups} groups`, 'the group cap')
  must(`at most ${S.CAPS.rules}.`, 'the rule cap')
  must(`1 to ${S.CAPS.conditions} conditions`, 'the condition cap')
  must(`1 to ${S.CAPS.groupName} characters`, 'the group name length')
  must(`1 to ${S.CAPS.ruleName} characters`, 'the rule name length')
  must(`1 to ${S.CAPS.question} characters`, 'the Jev question length')
  must(`at\n  most ${S.MAX_ID_LENGTH} characters`, 'the id length')
  must(`"version": ${S.VERSION}`, 'the version')
  for (const a of S.AGENDA) must(`\`${a}\``, `the agenda ${a}`)
  must(`id \`${R.REST}\``, 'the Rest id')
  // The id pattern the skill describes is the one the validation uses.
  assert.equal(S.ID.source, `^[A-Za-z0-9][A-Za-z0-9_-]{0,${S.MAX_ID_LENGTH - 1}}$`, `the id rule changed. ${rulesFix}`)
  // The example set in the skill passes the save check as it stands.
  const json = /```json\n([\s\S]*?)\n```/.exec(rulesSkill)[1]
  assert.equal(S.checkSettings(JSON.parse(json)).ok, true, `the example set must pass checkSettings. ${rulesFix}`)
})

test('inbox-rules: every rules and groups command and flag is in the skill', () => {
  for (const sub of ['export', 'import', 'add <json|->', 'set <n> <json|->', 'rm <n>', 'move <n> <to>', 'enable <n>', 'disable <n>', 'test <json|-|n>']) {
    assert.ok(rulesSkill.includes(`ccc inbox rules ${sub}`), `the skill must show ccc inbox rules ${sub}. ${rulesFix}`)
  }
  for (const sub of ['add <name>', 'rename <id|n> <name>', 'rm <id|n>', 'move <id|n> <to>']) {
    assert.ok(rulesSkill.includes(`ccc inbox groups ${sub}`), `the skill must show ccc inbox groups ${sub}. ${rulesFix}`)
  }
  for (const w of ['--global', '--project', '--at <n>', '--badge', '--collapsed']) assert.ok(rulesSkill.includes(w), `the skill must name ${w}. ${rulesFix}`)
  // The --project refusal is quoted as the host says it (case aside).
  const host = fs.readFileSync(path.join(ROOT, 'dist/host.js'), 'utf8')
  const refusal = /This project uses the global rules; make it its own in Settings › This Project, or use --global\./.exec(host)
  assert.ok(refusal, 'the host refusal text moved')
  const flat = (t) => t.toLowerCase().replace(/\s+/g, ' ')
  assert.ok(flat(rulesSkill).includes(flat(refusal[0]).replace(/\.$/, '')), `the skill must quote the --project refusal. ${rulesFix}`)
  // Every subcommand the parser knows (lib/rulescli.js SUBS) is in the skill and in ccc inbox help.
  const help = require('../dist/lib/cli').HELP
  for (const [cmd, subs] of Object.entries(RC.SUBS)) {
    for (const sub of Object.keys(subs)) {
      if (sub === 'list') continue
      assert.ok(rulesSkill.includes(`ccc inbox ${cmd} ${sub}`), `the skill must show ccc inbox ${cmd} ${sub}. ${rulesFix}`)
      assert.ok(help.includes(`ccc inbox ${cmd} ${sub}`), `ccc inbox help must show ccc inbox ${cmd} ${sub}`)
    }
  }
})
