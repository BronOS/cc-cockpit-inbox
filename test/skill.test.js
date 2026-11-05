'use strict'
// Drift guard: the inbox-source skill (skills/inbox-source/) states the feed contract in prose. This
// test reads the numbers and names from the validation code (dist/lib/feed.js) and the manifest, and
// fails when the skill text no longer carries them.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { CAPS, itemOf } = require('../dist/lib/feed')

const ROOT = path.join(__dirname, '..')
const DIR = 'skills/inbox-source'
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
const skill = fs.readFileSync(path.join(ROOT, DIR, 'SKILL.md'), 'utf8')
const contract = fs.readFileSync(path.join(ROOT, DIR, 'contract.md'), 'utf8')
const fix = `Update ${DIR}/contract.md (and SKILL.md) to match the code.`

test('the skill is declared and its front matter is the two lines the app accepts', () => {
  assert.deepEqual(manifest.contributes.skills, [{ id: 'inbox-source', dir: DIR }])
  const m = /^---\nname: inbox-source\ndescription: ([^\n]+)\n---\n/.exec(skill)
  assert.ok(m, 'SKILL.md front matter must be exactly name and description')
  assert.ok(m[1].length <= 1024 && !m[1].includes(': ') && !m[1].includes(' #'), 'description must be a plain YAML string')
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
