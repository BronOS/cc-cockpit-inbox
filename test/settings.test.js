'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../dist/lib/settings')
const { fakeAppStorage } = require('./fakes')

const v2 = (over = {}) => ({ version: 2, groups: [{ id: 'now', name: 'Now' }], rules: [], agenda: 'bottom', ...over })

test('defaults: Now, Chat, Mail, Jira, Rest (collapsed); read first, then Chat mentions and DMs, then by source', () => {
  const s = S.readSettings(undefined)
  assert.equal(s.version, 2)
  assert.deepEqual(s.groups.map((g) => [g.id, g.name, g.collapsed, g.badge]), [
    ['now', 'Now', false, true],
    ['chat', 'Chat', false, true],
    ['mail', 'Mail', false, true],
    ['jira', 'Jira', false, true],
    ['rest', 'Rest', true, false],
  ])
  assert.deepEqual(s.rules.map((r) => [r.id, r.group]), [['read', 'rest'], ['chat-mention', 'now'], ['chat-direct', 'now'], ['chat', 'chat'], ['mail', 'mail'], ['jira', 'jira']])
  assert.deepEqual(s.rules[0].when, [{ field: 'read', op: 'is', value: true }])
  assert.deepEqual(s.rules[2].when, [{ field: 'sourceKind', op: 'is', value: 'chat' }, { field: 'to', op: 'is', value: 'direct' }])
  assert.equal(s.agenda, 'top')
  // The defaults are valid settings: reading them changes nothing, and each call is a fresh copy.
  assert.deepEqual(S.readSettings(S.defaults()), S.defaults())
  s.groups.pop()
  assert.equal(S.defaults().groups.length, 5)
})

test('junk, a v2 value without lists: the defaults (agenda kept when valid)', () => {
  for (const junk of [null, 'x', 3, [], true]) assert.deepEqual(S.readSettings(junk), S.defaults())
  assert.deepEqual(S.readSettings({ version: 2, groups: 'no', rules: [], agenda: 'off' }), { ...S.defaults(), agenda: 'off' })
  assert.deepEqual(S.readSettings({ version: 2, groups: [], agenda: 'sideways' }), S.defaults())
  // A newer format this Inbox does not know is not guessed at.
  assert.deepEqual(S.readSettings({ version: 3, groups: [], rules: [] }), S.defaults())
})

test('migration from 0.1.0: everything dropped but the calendar position', () => {
  const v1 = {
    sources: { 'bronos.chat': { on: false, weight: 40 } },
    levels: { urgent: 300, action: 150, fyi: 50 },
    unread: 10,
    direct: 20,
    doneMarksRead: true,
    readItems: 20,
    badge: 'urgent',
    calendar: { position: 'bottom', upcoming: 3, pinMinutes: 30, timeline: 'auto' },
  }
  const s = S.readSettings(v1)
  assert.deepEqual(s, { ...S.defaults(), agenda: 'bottom' })
  assert.deepEqual(Object.keys(s).sort(), ['agenda', 'groups', 'rules', 'version'])
  for (const [pos, agenda] of [['top', 'top'], ['bottom', 'bottom'], ['off', 'off'], ['inline', 'top'], ['beside', 'top'], [undefined, 'top'], ['weird', 'top']]) {
    assert.equal(S.readSettings({ calendar: { position: pos } }).agenda, agenda, String(pos))
  }
  assert.equal(S.readSettings({}).agenda, 'top')
})

test('groups: bad and duplicate ones dropped, Rest always last with its stored name, at most 20', () => {
  const s = S.readSettings(v2({
    groups: [
      { id: 'rest', name: 'Later', collapsed: false, badge: true },
      { id: 'now', name: '  Now \n first ', collapsed: true, badge: true, extra: 1 },
      { id: 'now', name: 'Again' },
      { id: '__proto__', name: 'Proto' },
      { id: 'x', name: '' },
      { id: 'y', name: 'n'.repeat(41) },
      { id: 'z', name: 7 },
      'junk',
      null,
    ],
  }))
  assert.deepEqual(s.groups, [
    { id: 'now', name: 'Now first', collapsed: true, badge: true },
    { id: 'rest', name: 'Later', collapsed: false, badge: true },
  ])
  assert.deepEqual(S.readSettings(v2({ groups: [] })).groups, [{ id: 'rest', name: 'Rest', collapsed: true, badge: false }])
  const many = S.readSettings(v2({ groups: Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, name: `G${i}` })) }))
  assert.equal(many.groups.length, 20)
  assert.equal(many.groups[19].id, 'rest')
})

test('rules: clean copies; a bad part drops the whole rule; unknown group → Rest; at most 200', () => {
  const groups = [{ id: 'now', name: 'Now' }]
  const ok = { id: 'r1', enabled: true, group: 'now', when: [{ field: 'from.address', op: 'endsWith', value: '@example.com', extra: 1 }], extra: 2 }
  const s = S.readSettings(v2({
    groups,
    rules: [
      ok,
      { ...ok, id: 'r1' }, // duplicate id
      { ...ok, id: 'r2', group: 'gone' },
      { ...ok, id: 'r3', when: [ok.when[0], { field: 'title', op: 'matches', value: '.*' }] }, // one bad condition
      { ...ok, id: 'r4', when: [] }, // neither when nor jev
      { id: 'r5', group: 'now' }, // neither
      { ...ok, id: 'r6', name: 'Lead', enabled: false },
      { ...ok, id: 'r7', name: 'n'.repeat(61) },
      { ...ok, id: 'bad id!' },
      { ...ok, id: 'r8', when: Array.from({ length: 21 }, () => ok.when[0]) },
      { ...ok, id: 'r9', when: 'read is true' },
      { ...ok, id: 'r10', name: '' },
    ],
  }))
  assert.deepEqual(s.rules, [
    { id: 'r1', enabled: true, group: 'now', when: [{ field: 'from.address', op: 'endsWith', value: '@example.com' }] },
    { id: 'r2', enabled: true, group: 'rest', when: [{ field: 'from.address', op: 'endsWith', value: '@example.com' }] },
    { id: 'r6', name: 'Lead', enabled: false, group: 'now', when: [{ field: 'from.address', op: 'endsWith', value: '@example.com' }] },
    { id: 'r10', enabled: true, group: 'now', when: [{ field: 'from.address', op: 'endsWith', value: '@example.com' }] },
  ])
  const many = S.readSettings(v2({ rules: Array.from({ length: 250 }, (_, i) => ({ id: `r${i}`, enabled: true, group: 'now', when: [{ field: 'read', op: 'is', value: false }] })) }))
  assert.equal(many.rules.length, 200)
})

test('rules: Jev alone, conditions and Jev together, bad questions and thresholds', () => {
  const s = S.readSettings(v2({
    rules: [
      { id: 'j1', enabled: true, group: 'now', jev: { question: 'Is this urgent?', min: 0.8 } },
      { id: 'j2', enabled: true, group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }], jev: { question: 'From my manager?', min: 0 } },
      { id: 'j3', enabled: true, group: 'now', when: [], jev: { question: 'Empty when is fine with a question', min: 1 } },
      { id: 'b1', enabled: true, group: 'now', jev: { question: '', min: 0.5 } },
      { id: 'b2', enabled: true, group: 'now', jev: { question: 'q'.repeat(301), min: 0.5 } },
      { id: 'b3', enabled: true, group: 'now', jev: { question: 'Urgent?', min: 1.5 } },
      { id: 'b4', enabled: true, group: 'now', jev: { question: 'Urgent?', min: '0.5' } },
      { id: 'b5', enabled: true, group: 'now', jev: { question: 'Urgent?', min: NaN } },
      { id: 'b6', enabled: true, group: 'now', when: [{ field: 'read', op: 'is', value: 'yes' }], jev: { question: 'Urgent?', min: 0.5 } },
    ],
  }))
  assert.deepEqual(s.rules.map((r) => r.id), ['j1', 'j2', 'j3'])
  assert.deepEqual(s.rules[0], { id: 'j1', enabled: true, group: 'now', jev: { question: 'Is this urgent?', min: 0.8 } })
  assert.deepEqual(s.rules[1].when, [{ field: 'sourceKind', op: 'is', value: 'mail' }])
  assert.equal(Object.hasOwn(s.rules[2], 'when'), false)
})

test('enabled: anything but false is on (a hand edit that forgot it keeps the rule working)', () => {
  const r = (enabled) => S.readSettings(v2({ rules: [{ id: 'a', enabled, group: 'now', when: [{ field: 'read', op: 'is', value: true }] }] })).rules[0].enabled
  assert.equal(r(false), false)
  assert.equal(r(true), true)
  assert.equal(r(undefined), true)
})

test('prototype keys in a stored value reach nothing', () => {
  const raw = JSON.parse('{"version":2,"__proto__":{"agenda":"off"},"groups":[{"id":"now","name":"Now","__proto__":{"badge":true}}],"rules":[{"id":"a","group":"now","when":[{"field":"__proto__","op":"is","value":"x"}]},{"id":"b","group":"constructor","when":[{"field":"read","op":"is","value":true}]}],"agenda":"bottom"}')
  const s = S.readSettings(raw)
  assert.equal(s.agenda, 'bottom')
  assert.equal(s.groups[0].badge, false)
  assert.deepEqual(s.rules.map((r) => [r.id, r.group]), [['b', 'rest']])
  assert.equal(({}).agenda, undefined)
})

test('save stores the clean value; load reads it back; reset stores the defaults', async () => {
  const store = fakeAppStorage()
  assert.deepEqual(await S.loadSettings(store), S.defaults())
  const saved = await S.saveSettings(store, v2({ rules: [{ id: 'a', group: 'now', when: [{ field: 'read', op: 'is', value: false }] }, { id: 'bad' }], junk: 1 }))
  assert.deepEqual(saved.rules.map((r) => r.id), ['a'])
  assert.deepEqual(await store.get(S.KEY), saved)
  assert.deepEqual(await S.loadSettings(store), saved)
  assert.deepEqual(await S.resetSettings(store), S.defaults())
  assert.deepEqual(await S.loadSettings(store), S.defaults())
})
