'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const R = require('../dist/lib/rules')
const S = require('../dist/lib/settings')
const { NOW, HOUR, item2 } = require('./fakes')

const KINDS = { 'bronos.chat': 'chat', 'bronos.gmail': 'mail', 'bronos.jira': 'issues', 'x.other': 'other' }
const kindOf = (pluginId) => KINDS[pluginId]
const opts = (o = {}) => ({ now: NOW, kindOf, ...o })

/** A stored item: a v2 FeedItem with `source` set by the store. */
const it = (source, id, o = {}) => ({ ...item2(id, o), source })

/** Settings with one group `g` and the given rules (validated, as the host reads them). */
function withRules(...rules) {
  return S.readSettings({
    version: 2,
    groups: [{ id: 'g', name: 'G' }, { id: 'h', name: 'H' }],
    rules: rules.map((r, i) => ({ id: `r${i + 1}`, enabled: true, group: 'g', ...r })),
    agenda: 'top',
  })
}
const when = (field, op, value) => ({ when: [{ field, op, value }] })
/** Whether a single condition holds for an item. */
const check = (field, op, value, item) => {
  const c = R.conditionOf({ field, op, value })
  assert.ok(c, `${field} ${op} ${JSON.stringify(value)} is a valid condition`)
  return R.holds(c, item, kindOf(item.source) || 'other', NOW)
}

// --- conditions ------------------------------------------------------------------------------

test('conditionOf: the field table, value kinds, in lists, hostile input', () => {
  assert.deepEqual(R.conditionOf({ field: 'title', op: 'contains', value: '  login  ' }), { field: 'title', op: 'contains', value: 'login' })
  assert.deepEqual(R.conditionOf({ field: 'to', op: 'in', value: ['direct', 'cc', 'direct'] }), { field: 'to', op: 'in', value: ['direct', 'cc'] })
  assert.deepEqual(R.conditionOf({ field: 'time', op: 'newerThan', value: 60 }), { field: 'time', op: 'newerThan', value: 60 })
  for (const bad of [
    { field: 'title', op: 'matches', value: '.*' }, // no regex op
    { field: 'title', op: 'in', value: ['a'] }, // op not for this field
    { field: 'title', op: 'contains', value: '' },
    { field: 'title', op: 'contains', value: 'x'.repeat(201) },
    { field: 'title', op: 'contains', value: 3 },
    { field: 'to', op: 'is', value: 'everyone' },
    { field: 'sourceKind', op: 'is', value: 'calendar' },
    { field: 'mentionsMe', op: 'is', value: 'true' },
    { field: 'read', op: 'is', value: 0 },
    { field: 'time', op: 'olderThan', value: 0 },
    { field: 'time', op: 'olderThan', value: 525601 },
    { field: 'time', op: 'olderThan', value: 1.5 },
    { field: 'from.address', op: 'in', value: [] },
    { field: 'from.address', op: 'in', value: Array.from({ length: 51 }, (_, i) => `a${i}@example.com`) },
    { field: 'from.address', op: 'in', value: ['ok@example.com', 5] },
    { field: 'from.address', op: 'in', value: 'ok@example.com' },
    { field: '__proto__', op: 'is', value: 'x' },
    { field: 'constructor', op: 'is', value: 'x' },
    { field: 'labels', op: 'has' },
    null,
    'read is true',
    [],
  ]) {
    assert.equal(R.conditionOf(bad), null, JSON.stringify(bad))
  }
  assert.deepEqual(R.conditionOf({ field: 'read', op: 'is', value: null }), { field: 'read', op: 'is', value: null })
})

test('text ops: case-insensitive over NFKC, absent fields hold only for the negative ops', () => {
  const m = it('bronos.gmail', 't1', { title: 'Fix the LOGIN redirect', preview: 'See ＰＲＯＪ-12' })
  assert.equal(check('title', 'contains', 'login', m), true)
  assert.equal(check('title', 'contains', 'logout', m), false)
  assert.equal(check('title', 'notContains', 'logout', m), true)
  assert.equal(check('title', 'notContains', 'Login', m), false)
  assert.equal(check('title', 'startsWith', 'fix the', m), true)
  assert.equal(check('title', 'startsWith', 'the', m), false)
  assert.equal(check('title', 'is', 'fix the login redirect', m), true)
  assert.equal(check('title', 'is', 'fix the login', m), false)
  // Full-width letters fold to ASCII under NFKC.
  assert.equal(check('preview', 'contains', 'proj-12', m), true)
  const bare = it('bronos.gmail', 't2')
  assert.equal(check('preview', 'contains', 'x', bare), false)
  assert.equal(check('preview', 'notContains', 'x', bare), true)
  assert.equal(check('preview', 'is', 'x', bare), false)
  assert.equal(check('preview', 'startsWith', 'x', bare), false)
})

test('from, source and sourceKind: is, isNot, contains, endsWith, in', () => {
  const m = it('bronos.gmail', 'f1', { extra: { from: { name: 'Lead Person', address: 'Lead@example.com' } } })
  assert.equal(check('from.address', 'is', 'lead@example.com', m), true)
  assert.equal(check('from.address', 'endsWith', '@example.com', m), true)
  assert.equal(check('from.address', 'endsWith', '@example.org', m), false)
  assert.equal(check('from.address', 'in', ['a@example.com', 'LEAD@example.com'], m), true)
  assert.equal(check('from.address', 'in', ['a@example.com'], m), false)
  assert.equal(check('from.name', 'contains', 'lead', m), true)
  assert.equal(check('from.name', 'is', 'lead', m), false)
  const anon = it('bronos.gmail', 'f2')
  assert.equal(check('from.name', 'is', 'lead', anon), false)
  assert.equal(check('from.address', 'in', ['lead@example.com'], anon), false)
  assert.equal(check('source', 'is', 'bronos.gmail', m), true)
  assert.equal(check('source', 'isNot', 'bronos.gmail', m), false)
  assert.equal(check('source', 'isNot', 'bronos.chat', m), true)
  assert.equal(check('source', 'in', ['bronos.chat', 'bronos.gmail'], m), true)
  assert.equal(check('sourceKind', 'is', 'mail', m), true)
  assert.equal(check('sourceKind', 'isNot', 'mail', m), false)
  assert.equal(check('sourceKind', 'in', ['chat', 'issues'], m), false)
})

test('to (absent = none), mentionsMe (absent = false), read (true, false, null)', () => {
  const dm = it('bronos.chat', 'c1', { extra: { to: 'direct', mentionsMe: true } })
  const plain = it('bronos.chat', 'c2', { read: null })
  assert.equal(check('to', 'is', 'direct', dm), true)
  assert.equal(check('to', 'is', 'none', dm), false)
  assert.equal(check('to', 'is', 'none', plain), true)
  assert.equal(check('to', 'in', ['group', 'none'], plain), true)
  assert.equal(check('to', 'in', ['group', 'cc'], dm), false)
  assert.equal(check('mentionsMe', 'is', true, dm), true)
  assert.equal(check('mentionsMe', 'is', false, plain), true)
  assert.equal(check('mentionsMe', 'is', true, plain), false)
  assert.equal(check('read', 'is', false, dm), true)
  assert.equal(check('read', 'is', true, dm), false)
  assert.equal(check('read', 'is', null, plain), true)
  assert.equal(check('read', 'is', false, plain), false)
})

test('place: kind, name, status with is, contains, in', () => {
  const j = it('bronos.jira', 'PROJ-12', { extra: { place: { kind: 'project', name: 'PROJ', status: 'In Progress' } } })
  assert.equal(check('place.kind', 'is', 'project', j), true)
  assert.equal(check('place.name', 'in', ['ops', 'proj'], j), true)
  assert.equal(check('place.status', 'contains', 'progress', j), true)
  assert.equal(check('place.status', 'is', 'done', j), false)
  const none = it('bronos.jira', 'PROJ-13')
  assert.equal(check('place.name', 'is', 'proj', none), false)
  assert.equal(check('place.status', 'in', ['done'], none), false)
})

test('labels: has, hasNot, hasPrefix, case-insensitive; no labels has nothing', () => {
  const j = it('bronos.jira', 'PROJ-12', { labels: ['assigned', 'Priority:High', 'due:2026-11-06'] })
  assert.equal(check('labels', 'has', 'priority:high', j), true)
  assert.equal(check('labels', 'has', 'priority', j), false)
  assert.equal(check('labels', 'hasNot', 'mentioned', j), true)
  assert.equal(check('labels', 'hasNot', 'ASSIGNED', j), false)
  assert.equal(check('labels', 'hasPrefix', 'due:2026-11', j), true)
  assert.equal(check('labels', 'hasPrefix', 'type:', j), false)
  const bare = it('bronos.jira', 'PROJ-13')
  assert.equal(check('labels', 'has', 'assigned', bare), false)
  assert.equal(check('labels', 'hasNot', 'assigned', bare), true)
})

test('time: newerThan and olderThan in minutes from now', () => {
  const recent = it('bronos.chat', 'c1', { time: NOW - 30 * 60000 })
  const old = it('bronos.chat', 'c2', { time: NOW - 3 * HOUR })
  assert.equal(check('time', 'newerThan', 60, recent), true)
  assert.equal(check('time', 'newerThan', 60, old), false)
  assert.equal(check('time', 'olderThan', 120, old), true)
  assert.equal(check('time', 'olderThan', 120, recent), false)
})

// --- placing ---------------------------------------------------------------------------------

test('first enabled rule that holds wins; disabled rules are skipped; none → Rest "no rule"', () => {
  const s = withRules(
    { ...when('title', 'contains', 'deploy'), enabled: false },
    { ...when('title', 'contains', 'deploy'), group: 'h' },
    { ...when('title', 'contains', 'deploy') },
  )
  const p = R.placeItem(s, it('bronos.chat', 'c1', { title: 'Deploy at 5' }), opts())
  assert.deepEqual(p, { group: 'h', rule: 2, ruleId: 'r2', reason: 'rule 2: title contains deploy', jev: null })
  const none = R.placeItem(s, it('bronos.chat', 'c2', { title: 'Lunch?' }), opts())
  assert.deepEqual(none, { group: 'rest', rule: null, ruleId: null, reason: 'no rule', jev: null })
})

test('reasons: all conditions joined, the rule name instead when it has one', () => {
  const s = S.readSettings({
    version: 2,
    groups: [{ id: 'now', name: 'Now' }],
    rules: [
      { id: 'a', name: 'Lead', enabled: true, group: 'now', when: [{ field: 'from.address', op: 'is', value: 'lead@example.com' }, { field: 'read', op: 'is', value: false }] },
      { id: 'b', enabled: true, group: 'now', when: [{ field: 'from.address', op: 'is', value: 'lead@example.com' }, { field: 'to', op: 'in', value: ['direct', 'cc'] }] },
    ],
  })
  const lead = it('bronos.gmail', 'm1', { extra: { from: { address: 'lead@example.com' }, to: 'cc' } })
  assert.equal(R.placeItem(s, lead, opts()).reason, 'rule 1: Lead')
  assert.equal(R.placeItem(s, { ...lead, read: true }, opts()).reason, 'rule 2: from.address is lead@example.com and to in direct, cc')
})

test('a rule naming a group that left places in Rest', () => {
  const s = withRules(when('read', 'is', false))
  s.rules[0].group = 'gone'
  assert.equal(R.placeItem(s, it('bronos.chat', 'c1'), opts()).group, 'rest')
})

test('the source kind comes from kindOf; an unknown or throwing kindOf is "other"', () => {
  const s = withRules(when('sourceKind', 'is', 'other'))
  assert.equal(R.placeItem(s, it('x.other', 'o1'), opts()).rule, 1)
  assert.equal(R.placeItem(s, it('x.unknown', 'o2'), opts()).rule, 1)
  assert.equal(R.placeItem(s, it('bronos.chat', 'o3'), opts({ kindOf: () => { throw new Error('boom') } })).rule, 1)
  assert.equal(R.placeItem(s, it('bronos.chat', 'o4'), opts()).rule, null)
})

// --- Jev -------------------------------------------------------------------------------------

test('Jev: pre-filter first (Jev never asked for an item that fails it), then the threshold', () => {
  const s = withRules(
    { when: [{ field: 'sourceKind', op: 'is', value: 'mail' }], jev: { question: 'Is this urgent?', min: 0.8 } },
    { jev: { question: 'Needs a reply?', min: 0.5 }, group: 'h' },
  )
  const asked = []
  const jevAnswer = (rule, item) => {
    asked.push([rule.id, item.id])
    return { score: item.id === 'm1' ? 0.86 : 0.3 }
  }
  const p1 = R.placeItem(s, it('bronos.gmail', 'm1'), opts({ jevAnswer }))
  assert.deepEqual(p1, { group: 'g', rule: 1, ruleId: 'r1', reason: 'rule 1: sourceKind is mail and Jev 0.86', jev: null, score: 0.86 })
  const p2 = R.placeItem(s, it('bronos.chat', 'c1'), opts({ jevAnswer }))
  assert.equal(p2.group, 'rest')
  // The chat item never reached rule 1's question; it was asked rule 2's only.
  assert.deepEqual(asked, [['r1', 'm1'], ['r2', 'c1']])
  const pure = withRules({ jev: { question: 'Urgent?', min: 0.5 } })
  assert.equal(R.placeItem(pure, it('bronos.chat', 'c2'), opts({ jevAnswer: () => ({ score: 0.5 }) })).reason, 'rule 1: Jev 0.50')
})

test('Jev: only items that reach the rule are asked (an earlier rule placed the others)', () => {
  const s = withRules(when('read', 'is', true), { jev: { question: 'Urgent?', min: 0.5 } })
  const asked = []
  const jevAnswer = (rule, item) => (asked.push(item.id), { score: 1 })
  R.placeAll(s, [it('bronos.chat', 'read', { read: true }), it('bronos.chat', 'new')], opts({ jevAnswer }))
  assert.deepEqual(asked, ['new'])
})

test('Jev pending: the rule does not hold, evaluation goes on, the placement says Jev…', () => {
  const s = withRules({ jev: { question: 'Urgent?', min: 0.8 } }, { ...when('sourceKind', 'is', 'chat'), group: 'h' })
  const p = R.placeItem(s, it('bronos.chat', 'c1'), opts({ jevAnswer: () => 'pending' }))
  assert.deepEqual(p, { group: 'h', rule: 2, ruleId: 'r2', reason: 'rule 2: sourceKind is chat · rule 1: Jev…', jev: 'pending' })
  // The answer arrives: the item moves once, to the Jev rule's group.
  const after = R.placeItem(s, it('bronos.chat', 'c1'), opts({ jevAnswer: () => ({ score: 0.9 }) }))
  assert.equal(after.group, 'g')
  assert.equal(after.jev, null)
})

test('Jev unavailable (no answerer, a throw, a hostile answer): not holding, said in the reason', () => {
  const s = withRules({ jev: { question: 'Urgent?', min: 0.1 } })
  const cases = [undefined, () => 'unavailable', () => { throw new Error('jev: cap') }, () => ({}), () => ({ score: 'high' }), () => ({ score: 1.5 }), () => ({ score: NaN }), () => null, () => 0.9]
  for (const jevAnswer of cases) {
    const p = R.placeItem(s, it('bronos.chat', 'c1'), opts({ jevAnswer }))
    assert.deepEqual(p, { group: 'rest', rule: null, ruleId: null, reason: 'no rule · rule 1 skipped: Jev unavailable', jev: null })
  }
})

// --- the list --------------------------------------------------------------------------------

test('placeAll: groups in the settings order, Rest last, newest first then source then id', () => {
  const s = withRules(when('sourceKind', 'is', 'chat'), { ...when('sourceKind', 'is', 'mail'), group: 'h' })
  const items = [
    it('bronos.gmail', 'm-old', { time: NOW - 5 * HOUR }),
    it('bronos.chat', 'b', { time: NOW - HOUR }),
    it('bronos.chat', 'a', { time: NOW - HOUR }),
    it('bronos.chat', 'new', { time: NOW - 60000 }),
    it('bronos.gmail', 'm-new', { time: NOW - 2 * HOUR }),
    it('x.other', 'o', { time: NOW - HOUR }),
    it('bronos.jira', 'PROJ-1', { time: NOW - HOUR }),
  ]
  const out = R.placeAll(s, items, opts())
  assert.deepEqual(out.groups.map((g) => [g.id, g.rows.map((r) => r.item.id)]), [
    ['g', ['new', 'a', 'b']],
    ['h', ['m-new', 'm-old']],
    // Same time: the source decides before the id.
    ['rest', ['PROJ-1', 'o']],
  ])
  assert.equal(out.byKey.get(R.keyOf('bronos.chat', 'a')).placement.rule, 1)
  assert.equal(out.byKey.size, items.length)
})

test('stable: the same items and rules give the same list, whatever order they come in', () => {
  const s = S.defaults()
  const items = []
  for (let i = 0; i < 40; i++) {
    const source = ['bronos.chat', 'bronos.gmail', 'bronos.jira', 'x.other'][i % 4]
    items.push(it(source, `i${i % 7}-${i}`, { time: NOW - (i % 5) * HOUR, read: i % 3 === 0, extra: i % 6 === 0 ? { to: 'direct' } : {} }))
  }
  const ids = (list) => R.placeAll(s, list, opts()).groups.map((g) => [g.id, g.rows.map((r) => r.key)])
  const first = ids(items)
  for (let n = 0; n < 5; n++) {
    const shuffled = [...items].sort(() => Math.random() - 0.5)
    assert.deepEqual(ids(shuffled), first)
  }
})

test('the default rules: Chat mentions and DMs in Now, then Chat, Mail, Jira; read in Rest', () => {
  const s = S.defaults()
  // Facts as the sources emit them (feed v2): Chat sets `to` from the conversation kind and
  // `mentionsMe` on unread mentions; Gmail sets `to` from To / Cc; Jira sets `to: direct` when
  // assigned, `cc` + `mentioned` when only mentioned.
  const items = [
    it('bronos.chat', 'spaces/S1/threads/T1', { time: NOW - 10 * 60000, extra: { to: 'group', mentionsMe: true, place: { kind: 'channel', name: 'Team' } } }),
    it('bronos.chat', 'spaces/D1', { time: NOW - 20 * 60000, extra: { to: 'direct' } }),
    it('bronos.chat', 'spaces/S2/threads/T2', { time: NOW - 5 * 60000, extra: { to: 'group', place: { kind: 'channel', name: 'Random' } } }),
    it('bronos.chat', 'spaces/D2', { time: NOW - 60000, read: true, extra: { to: 'direct' } }),
    it('bronos.gmail', 'thread-1', { time: NOW - 2 * 60000, extra: { to: 'direct', from: { address: 'lead@example.com' } } }),
    it('bronos.gmail', 'thread-2', { time: NOW - HOUR, labels: ['category:updates'], extra: { to: 'group' } }),
    it('bronos.gmail', 'thread-3', { time: NOW - 30000, read: true }),
    it('bronos.jira', 'PROJ-12', { time: NOW - 30000, labels: ['assigned', 'priority:High', 'type:Bug'], extra: { to: 'direct', place: { kind: 'project', name: 'PROJ', status: 'In Progress' } } }),
    it('bronos.jira', 'PROJ-7', { time: NOW - 3 * HOUR, labels: ['mentioned', 'assignee:Someone'], extra: { to: 'cc', mentionsMe: true } }),
    it('bronos.jira', 'PROJ-3', { time: NOW - HOUR, read: true, labels: ['assigned'], extra: { to: 'direct' } }),
  ]
  const out = R.placeAll(s, items, opts())
  assert.deepEqual(out.groups.map((g) => [g.id, g.rows.map((r) => r.item.id)]), [
    ['now', ['spaces/S1/threads/T1', 'spaces/D1']],
    ['chat', ['spaces/S2/threads/T2']],
    ['mail', ['thread-1', 'thread-2']],
    ['jira', ['PROJ-12', 'PROJ-7']],
    ['rest', ['thread-3', 'spaces/D2', 'PROJ-3']],
  ])
  const reason = (src, id) => out.byKey.get(R.keyOf(src, id)).placement.reason
  assert.equal(reason('bronos.chat', 'spaces/S1/threads/T1'), 'rule 2: sourceKind is chat and mentionsMe is true')
  assert.equal(reason('bronos.chat', 'spaces/D1'), 'rule 3: sourceKind is chat and to is direct')
  assert.equal(reason('bronos.gmail', 'thread-3'), 'rule 1: read is true')
  assert.equal(reason('bronos.jira', 'PROJ-12'), 'rule 6: sourceKind is issues')
  // A source of kind `other` lands in Rest until a rule names it.
  assert.equal(R.placeItem(s, it('x.other', 'o1'), opts()).reason, 'no rule')
})

test('traceItem: each rule, why it did not hold, and the same placement as placeItem', () => {
  const s = S.defaults()
  s.rules.splice(1, 0, { id: 'off', enabled: false, group: 'now', when: [{ field: 'read', op: 'is', value: false }] })
  const item = it('bronos.gmail', 'thread-1', { extra: { to: 'direct' } })
  const t = R.traceItem(s, item, opts())
  assert.deepEqual(t.placement, R.placeItem(s, item, opts()))
  assert.deepEqual(t.steps.map((x) => [x.rule, x.id, x.result]), [
    [1, 'read', 'failed'],
    [2, 'off', 'disabled'],
    [3, 'chat-mention', 'failed'],
    [4, 'chat-direct', 'failed'],
    [5, 'chat', 'failed'],
    [6, 'mail', 'held'],
    [7, 'jira', 'not checked'],
  ])
  assert.equal(t.steps[0].detail, 'read is true (was: false)')
  assert.equal(t.steps[2].detail, 'sourceKind is chat (was: mail)')
  assert.match(t.text, /^rule 1 → Rest: failed: read is true \(was: false\)$/m)
  assert.match(t.text, /^rule 2 → Now: disabled$/m)
  assert.match(t.text, /^placed in Mail: rule 6: sourceKind is mail$/m)
  const jev = withRules({ name: 'Urgent', jev: { question: 'Urgent?', min: 0.8 } })
  const jt = R.traceItem(jev, it('bronos.chat', 'c1'), opts({ jevAnswer: () => ({ score: 0.4 }) }))
  assert.deepEqual(jt.steps.map((x) => [x.result, x.detail]), [['failed', 'Jev 0.40 below 0.8']])
  assert.match(jt.text, /^rule 1 \(Urgent\) → G: failed: Jev 0\.40 below 0\.8$/m)
})
