'use strict'
// The settings page: its pure parts (settings/logic.js) over a draft, the host's strict save check
// (lib/settings.js checkSettings), and the host's side of the page (dist/host.js over the fake
// ctx.settingsPage): the first read, a save round trip, a refused save with its reason, "Test" from
// cached Jev answers only, and a guard on index.js: settings and source text go in as text only.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const L = require('../settings/logic')
const S = require('../dist/lib/settings')
const { FIELDS, KINDS, TO, MAX_IN, MAX_VALUE, MAX_MINUTES, REST } = require('../dist/lib/rules')
const { createInbox } = require('../dist/host')
const { cacheKey } = require('../dist/lib/jev')
const { fakeCtx, fakeFeedV2, fakeJev, item2, flush, NOW, CHAT, MAIL } = require('./fakes')

const MIN = 60000
const TABLE = { fields: FIELDS, kinds: KINDS, to: TO, rest: REST, agenda: S.AGENDA, caps: { ...S.CAPS, in: MAX_IN, value: MAX_VALUE, minutes: MAX_MINUTES } }
const settle = async () => {
  for (let i = 0; i < 20; i++) await flush()
}

// ---- logic.js: groups ----

test('add a group: before Rest, a fresh id, a default name; the input draft is not changed', () => {
  const d = S.defaults()
  const before = JSON.stringify(d)
  const { draft, id } = L.addGroup(d, '  Boss ')
  assert.equal(JSON.stringify(d), before)
  assert.equal(id, 'g1')
  assert.deepEqual(draft.groups.map((g) => g.id), ['now', 'chat', 'mail', 'jira', 'g1', 'rest'])
  assert.deepEqual(draft.groups[4], { id: 'g1', name: 'Boss', collapsed: false, badge: false })
  assert.equal(L.addGroup(draft, '').draft.groups.at(-2).name, 'New group')
  assert.equal(L.addGroup(draft, '').id, 'g2')
  assert.ok(S.ID.test(id))
})

test('rename, flags, reorder: Rest stays last and nothing moves below it', () => {
  let d = L.renameGroup(S.defaults(), 'mail', 'Email')
  assert.equal(d.groups.find((g) => g.id === 'mail').name, 'Email')
  d = L.setGroupFlag(d, 'rest', 'collapsed', false)
  d = L.setGroupFlag(d, 'rest', 'badge', true)
  assert.deepEqual(d.groups.at(-1), { id: 'rest', name: 'Rest', collapsed: false, badge: true })
  assert.equal(L.setGroupFlag(d, 'mail', 'name', true), d)
  assert.equal(L.canMoveGroup(d, 'now', -1), false)
  assert.equal(L.canMoveGroup(d, 'jira', 1), false, 'not below Rest')
  assert.equal(L.canMoveGroup(d, 'rest', -1), false, 'Rest itself does not move')
  d = L.moveGroup(d, 'jira', -1)
  d = L.moveGroup(d, 'jira', -1)
  assert.deepEqual(d.groups.map((g) => g.id), ['now', 'jira', 'chat', 'mail', 'rest'])
  assert.equal(L.moveGroup(d, 'rest', -1), d)
})

test('delete a group: its rules move to Rest; Rest cannot be deleted', () => {
  const d = S.defaults()
  assert.equal(L.rulesIn(d, 'now'), 2)
  const next = L.deleteGroup(d, 'now')
  assert.deepEqual(next.groups.map((g) => g.id), ['chat', 'mail', 'jira', 'rest'])
  assert.deepEqual(next.rules.filter((r) => r.group === REST).map((r) => r.id), ['read', 'chat-mention', 'chat-direct'])
  assert.equal(L.deleteGroup(d, 'rest'), d)
  assert.equal(L.deleteGroup(d, 'nope'), d)
  assert.equal(S.checkSettings(next).ok, true)
})

// ---- logic.js: rules ----

test('rules: add at the top, move, duplicate below with a new id, delete, enable, group, name', () => {
  let { draft: d, id } = L.addRule(S.defaults(), TABLE)
  assert.equal(id, 'r1')
  assert.deepEqual(d.rules[0], { id: 'r1', enabled: true, group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'chat' }] })
  d = L.moveRule(d, 'r1', 1)
  assert.deepEqual(d.rules.slice(0, 2).map((r) => r.id), ['read', 'r1'])
  assert.equal(L.moveRule(d, 'read', -1), d)
  const dup = L.duplicateRule(d, 'r1')
  assert.equal(dup.id, 'r2')
  assert.deepEqual(dup.draft.rules.slice(1, 3).map((r) => r.id), ['r1', 'r2'])
  assert.deepEqual({ ...dup.draft.rules[2], id: 'r1' }, dup.draft.rules[1])
  d = L.deleteRule(dup.draft, 'r1')
  assert.deepEqual(d.rules.slice(0, 2).map((r) => r.id), ['read', 'r2'])
  d = L.setRule(d, 'r2', { enabled: false, group: 'mail', name: 'Boss' })
  assert.deepEqual(d.rules[1], { id: 'r2', name: 'Boss', enabled: false, group: 'mail', when: [{ field: 'sourceKind', op: 'is', value: 'chat' }] })
  assert.equal(L.setRule(d, 'r2', { group: 'gone' }).rules[1].group, 'mail', 'only a group that exists')
  assert.equal('name' in L.setRule(d, 'r2', { name: '  ' }).rules[1], false, 'an empty name is no name')
  assert.equal(S.checkSettings(d).ok, true)
})

test('conditions and Jev: on and off, never neither; the last condition stays without a Jev question', () => {
  let { draft: d } = L.addRule(S.defaults(), TABLE)
  assert.equal(L.setRuleParts(d, 'r1', { when: false }, TABLE), d, 'neither part: no change')
  assert.equal(L.removeCondition(d, 'r1', 0), d)
  d = L.setRuleParts(d, 'r1', { jev: true }, TABLE)
  assert.deepEqual(d.rules[0].jev, { question: '', min: L.DEFAULT_MIN })
  d = L.setJev(d, 'r1', { question: 'Is this urgent?', min: 0.7 })
  assert.deepEqual(d.rules[0].jev, { question: 'Is this urgent?', min: 0.7 })
  d = L.removeCondition(d, 'r1', 0)
  assert.equal('when' in d.rules[0], false)
  assert.equal(L.setRuleParts(d, 'r1', { jev: false }, TABLE), d)
  d = L.setRuleParts(d, 'r1', { when: true }, TABLE)
  d = L.addCondition(d, 'r1', TABLE)
  assert.equal(d.rules[0].when.length, 2)
  d = L.setRuleParts(d, 'r1', { jev: false }, TABLE)
  assert.equal('jev' in d.rules[0], false)
  assert.equal(S.checkSettings(d).ok, true)
})

test('a condition edit: a new field keeps an op it takes and a value of the same kind; in takes a list', () => {
  let { draft: d } = L.addRule(S.defaults(), TABLE)
  const c = (x) => x.rules[0].when[0]
  d = L.setCondition(d, 'r1', 0, { field: 'title' }, TABLE)
  assert.deepEqual(c(d), { field: 'title', op: 'is', value: '' }, 'kind → text: the op kept (title takes is), the value reset')
  d = L.setCondition(d, 'r1', 0, { field: 'labels' }, TABLE)
  assert.deepEqual(c(d), { field: 'labels', op: 'has', value: '' }, 'an op the new field does not take: its first')
  d = L.setCondition(d, 'r1', 0, { field: 'title', op: 'is', value: 'Build failed' }, TABLE)
  d = L.setCondition(d, 'r1', 0, { field: 'preview' }, TABLE)
  assert.deepEqual(c(d), { field: 'preview', op: 'is', value: 'Build failed' }, 'text → text: kept')
  d = L.setCondition(d, 'r1', 0, { field: 'from.address', op: 'in' }, TABLE)
  assert.deepEqual(c(d), { field: 'from.address', op: 'in', value: ['Build failed'] })
  d = L.setCondition(d, 'r1', 0, { value: L.parseValue('lead@example.com\n\n  boss@example.com ', 'text', 'in') }, TABLE)
  assert.deepEqual(c(d).value, ['lead@example.com', 'boss@example.com'])
  d = L.setCondition(d, 'r1', 0, { op: 'endsWith' }, TABLE)
  assert.deepEqual(c(d), { field: 'from.address', op: 'endsWith', value: 'lead@example.com' })
  d = L.setCondition(d, 'r1', 0, { op: 'hasPrefix' }, TABLE)
  assert.equal(c(d).op, 'endsWith', 'an op the field does not take is ignored')
  d = L.setCondition(d, 'r1', 0, { field: 'time' }, TABLE)
  assert.deepEqual(c(d), { field: 'time', op: 'newerThan', value: 60 })
  d = L.setCondition(d, 'r1', 0, { field: 'nope' }, TABLE)
  assert.equal(c(d).field, 'time')
  assert.equal(S.checkSettings(d).ok, true)
})

test('inputs: values to text and back per kind, the threshold, the controls the table gives', () => {
  assert.equal(L.valueText(['a', 'b']), 'a\nb')
  assert.equal(L.valueText(null), 'null')
  assert.equal(L.valueText(false), 'false')
  assert.equal(L.parseValue('45', 'minutes', 'newerThan'), 45)
  assert.equal(L.parseValue('4.5', 'minutes', 'newerThan'), '4.5', 'not a whole number: left for the host to refuse')
  assert.equal(L.parseValue('false', 'bool', 'is'), false)
  assert.equal(L.parseValue('null', 'read', 'is'), null)
  assert.equal(L.parseValue('true', 'read', 'is'), true)
  assert.deepEqual(L.parseValue('chat\nmail', 'kind', 'in'), ['chat', 'mail'])
  assert.equal(L.parseMin('0.85'), 0.85)
  assert.equal(L.parseMin('1'), 1)
  assert.equal(L.parseMin('1.5'), '1.5')
  assert.equal(L.parseMin('abc'), 'abc')
  assert.deepEqual(L.valueControl({ field: 'sourceKind', op: 'is' }, TABLE), { type: 'select', options: KINDS })
  assert.deepEqual(L.valueControl({ field: 'to', op: 'in' }, TABLE), { type: 'checks', options: TO })
  assert.deepEqual(L.valueControl({ field: 'read', op: 'is' }, TABLE), { type: 'select', options: ['true', 'false', 'null'] })
  assert.deepEqual(L.valueControl({ field: 'time', op: 'olderThan' }, TABLE), { type: 'number', min: 1, max: MAX_MINUTES })
  assert.deepEqual(L.valueControl({ field: 'from.name', op: 'in' }, TABLE), { type: 'lines', max: MAX_VALUE })
  assert.deepEqual(L.valueControl({ field: 'title', op: 'contains' }, TABLE), { type: 'text', max: MAX_VALUE })
  assert.deepEqual(L.opChoices('labels', TABLE).map((o) => o.label), ['has', 'has not', 'has one starting with'])
  for (const f of Object.values(FIELDS)) for (const op of f.ops) assert.ok(L.OP_LABELS[op], `a word for ${op}`)
})

test('what the page says: summaries, notes, test results, source rows, dirty', () => {
  const d = S.defaults()
  assert.equal(L.ruleSummary(d.rules[1], d), 'sourceKind is chat and mentionsMe is true → Now')
  const jevRule = { id: 'j', enabled: true, group: 'now', when: [{ field: 'sourceKind', op: 'in', value: ['mail', 'chat'] }], jev: { question: 'Urgent?', min: 0.8 } }
  assert.equal(L.ruleSummary(jevRule, d), 'sourceKind is one of mail, chat and Jev: “Urgent?” at least 0.8 → Now')
  assert.equal(L.ruleNote(jevRule, false), 'inactive: no Jev provider is enabled')
  assert.equal(L.ruleNote(jevRule, true), null)
  assert.equal(L.ruleNote({ ...jevRule, enabled: false }, true), 'disabled')
  assert.equal(L.testText({ ok: false, reason: 'rule 2 needs a condition or a Jev question' }), 'Cannot test: rule 2 needs a condition or a Jev question')
  assert.equal(L.testText({ ok: true, total: 0, placed: 0, holds: 0, pending: 0 }), 'No items in the Inbox to test against.')
  assert.equal(L.testText({ ok: true, total: 10, placed: 2, holds: 5, pending: 1 }), 'Would place 2 of 10 items (holds for 5; 3 placed by an earlier rule). 1 have no Jev answer yet (Test never asks).')
  assert.deepEqual(L.sourceRow({ pluginId: 'p.mail', label: 'Mail', badge: 'MAIL', kind: 'mail', scope: 'lead@example.com', state: 'signedOut', message: 'sign in again', count: 3 }), {
    label: 'Mail',
    id: 'p.mail',
    badge: 'MAIL',
    meta: 'mail · lead@example.com · signedOut: sign in again · 3 items',
    problem: true,
  })
  assert.equal(L.sourceRow({ pluginId: 'p.chat', state: 'ok', count: 0 }).problem, false)
  assert.equal(L.isDirty(L.draftOf(d), d), false)
  assert.equal(L.isDirty(L.setAgenda(d, 'off'), d), true)
  assert.equal(L.setAgenda(d, 'beside'), d)
})

// ---- lib/settings.js: the strict check of a save ----

test('checkSettings: the defaults and the editor drafts pass; Rest is put last', () => {
  assert.deepEqual(S.checkSettings(S.defaults()), { ok: true, settings: S.defaults() })
  const d = S.defaults()
  const restFirst = { ...d, groups: [d.groups.at(-1), ...d.groups.slice(0, -1)] }
  const got = S.checkSettings(restFirst)
  assert.equal(got.ok, true)
  assert.equal(got.settings.groups.at(-1).id, REST)
})

test('checkSettings: a refusal names what does not fit and where', () => {
  const d = S.defaults()
  const withRule = (r) => ({ ...d, rules: [...d.rules, { id: 'x', enabled: true, group: 'now', ...r }] })
  const cases = [
    [null, 'the settings are not an object'],
    [{ ...d, version: 1 }, 'these are not Inbox v2 settings (version 2)'],
    [{ ...d, agenda: 'beside' }, 'the agenda must be top, bottom or off'],
    [{ ...d, groups: 'x' }, 'the groups are not a list'],
    [{ ...d, groups: d.groups.filter((g) => g.id !== REST) }, 'the Rest group is missing'],
    [{ ...d, groups: [{ id: 'now', name: '  ' }, ...d.groups.slice(1)] }, 'group 1 needs a name of 1 to 40 characters'],
    [{ ...d, groups: [d.groups[0], d.groups[0], ...d.groups.slice(1)] }, 'group 2: the id "now" is used twice'],
    [{ ...d, groups: [{ id: '__proto__', name: 'X' }, ...d.groups] }, 'group 1 has a bad id'],
    [{ ...d, groups: Array.from({ length: 21 }, (_, i) => ({ id: `g${i}`, name: 'G' })) }, 'at most 20 groups, Rest included'],
    [withRule({ group: 'gone' }), 'rule 7 goes to a group that is not there ("gone")'],
    [withRule({}), 'rule 7 needs a condition or a Jev question'],
    [withRule({ when: [] }), 'rule 7 needs a condition or a Jev question'],
    [withRule({ when: [{ field: 'size', op: 'is', value: 1 }] }), 'rule 7, condition 1: has no known field ("size")'],
    [withRule({ when: [{ field: 'labels', op: 'is', value: 'x' }] }), 'rule 7, condition 1: labels takes has, hasNot, hasPrefix, not "is"'],
    [withRule({ when: [{ field: 'read', op: 'is', value: true }, { field: 'time', op: 'newerThan', value: 4.5 }] }), 'rule 7, condition 2: time newerThan needs a whole number of minutes from 1 to 525600'],
    [withRule({ when: [{ field: 'title', op: 'contains', value: '' }] }), 'rule 7, condition 1: title contains needs text of 1 to 200 characters'],
    [withRule({ when: [{ field: 'to', op: 'in', value: [] }] }), 'rule 7, condition 1: to in needs a list of 1 to 50 values, each one of direct, group, cc, none'],
    [withRule({ jev: { question: '', min: 0.5 } }), 'rule 7: the Jev question needs 1 to 300 characters'],
    [withRule({ jev: { question: 'Urgent?', min: '0.5' } }), 'rule 7: the Jev threshold must be a number from 0 to 1'],
    [withRule({ jev: { question: 'Urgent?', min: 1.5 } }), 'rule 7: the Jev threshold must be a number from 0 to 1'],
    [withRule({ name: 'x'.repeat(61), when: [{ field: 'read', op: 'is', value: false }] }), 'rule 7: the name must be 1 to 60 characters on one line'],
    [withRule({ enabled: 'yes', when: [{ field: 'read', op: 'is', value: false }] }), 'rule 7: enabled must be true or false'],
    [{ ...d, rules: [...d.rules, { ...d.rules[0] }] }, 'rule 7: the id "read" is used twice'],
  ]
  for (const [raw, reason] of cases) assert.deepEqual(S.checkSettings(raw), { ok: false, reason }, reason)
})

test('checkSettings: everything it accepts survives readSettings unchanged (no silent drop)', () => {
  const d = S.defaults()
  d.rules.unshift({ id: 'j', name: 'Urgent mail', enabled: false, group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }], jev: { question: 'Is this urgent?', min: 0.8 } })
  d.rules.unshift({ id: 'boss', enabled: true, group: 'now', when: [{ field: 'from.address', op: 'in', value: ['lead@example.com', 'boss@example.com'] }, { field: 'time', op: 'newerThan', value: 1440 }] })
  const got = S.checkSettings(d)
  assert.equal(got.ok, true)
  assert.deepEqual(got.settings, d)
})

// ---- dist/host.js: the page's backend ----

function setup(o = {}) {
  const ctx = fakeCtx(o.ctxOpts)
  const clock = { t: NOW }
  for (const [id, feed] of Object.entries(o.feeds || {})) ctx.addProvider(id, feed)
  const timers = { set: () => 0, clear() {} }
  const inbox = createInbox(ctx, { now: () => clock.t, callMs: 200, jevTimers: timers })
  return { ctx, clock, inbox }
}

test('host: the page gets the settings, the field table, the defaults, the sources and Jev availability; nothing else', async () => {
  const chat = fakeFeedV2({ ...CHAT, scope: 'team@example.com' }, [item2('c1'), item2('c2')])
  const { ctx, inbox } = setup({ feeds: { 'p.chat': chat } })
  await inbox.first
  await settle()
  const page = ctx.openSettingsPage()
  await page.send({ type: 'ready' })
  const m = page.last('settings')
  assert.deepEqual(Object.keys(m).sort(), ['defaults', 'jev', 'saved', 'settings', 'sources', 'table', 'type'])
  assert.equal(m.saved, false)
  assert.deepEqual(m.settings, S.defaults())
  assert.deepEqual(m.defaults, S.defaults())
  assert.deepEqual(m.table, JSON.parse(JSON.stringify(TABLE)))
  assert.equal(m.jev, false)
  assert.deepEqual(m.sources, [{ pluginId: 'p.chat', label: 'Chat', badge: 'CHAT', color: 'green', kind: 'chat', scope: 'team@example.com', state: 'ok', count: 2 }])
  inbox.dispose()
})

test('host: the sources go again once they are read, if the page opened first', async () => {
  const chat = fakeFeedV2(CHAT, [item2('c1')])
  const release = chat.hold()
  const { ctx, inbox } = setup({ feeds: { 'p.chat': chat } })
  const page = ctx.openSettingsPage()
  await page.send({ type: 'ready' })
  await settle()
  assert.deepEqual(page.last('settings').sources.map((s) => s.count), [])
  release()
  await inbox.first
  await settle()
  assert.deepEqual(page.last('settings').sources.map((s) => s.count), [1])
  inbox.dispose()
})

test('host: a save round trip stores, applies in this window at once, and answers with what it stored', async () => {
  const chat = fakeFeedV2(CHAT, [item2('c1', { extra: { from: { name: 'Lead', address: 'lead@example.com' } } }), item2('c2')])
  const { ctx, inbox } = setup({ feeds: { 'p.chat': chat } })
  await inbox.first
  await settle()
  const page = ctx.openSettingsPage()
  await page.send({ type: 'ready' })
  let { draft, id } = L.addGroup(page.last('settings').settings, 'Boss')
  draft = L.addRule(draft, TABLE).draft
  draft = L.setRule(draft, 'r1', { group: id })
  draft = L.setCondition(draft, 'r1', 0, { field: 'from.address', op: 'is', value: 'lead@example.com' }, TABLE)
  draft = L.setAgenda(draft, 'bottom')
  await page.send({ type: 'save', settings: draft })
  await settle()
  const m = page.last('settings')
  assert.equal(m.saved, true)
  assert.deepEqual(m.settings, draft)
  assert.deepEqual(await ctx.appStorage.get(S.KEY), draft)
  assert.deepEqual(inbox.settings(), draft)
  const g = ctx.lastState().groups.find((x) => x.id === id)
  assert.deepEqual(g.rows.map((r) => r.id), ['c1'])
  assert.deepEqual(ctx.slotPlacements.at(-1), [{ type: 'agenda', position: 'bottom', height: 140 }])
  inbox.dispose()
})

test('host: a refused save says why and stores nothing; a hostile message is ignored', async () => {
  const { ctx, inbox } = setup()
  await inbox.first
  const page = ctx.openSettingsPage()
  await page.send({ type: 'ready' })
  const bad = { ...S.defaults(), rules: [{ id: 'x', enabled: true, group: 'now', when: [{ field: 'time', op: 'newerThan', value: 'soon' }] }] }
  await page.send({ type: 'save', settings: bad })
  assert.deepEqual(page.last('refused'), { type: 'refused', reason: 'rule 1, condition 1: time newerThan needs a whole number of minutes from 1 to 525600' })
  assert.equal(await ctx.appStorage.get(S.KEY), undefined)
  assert.deepEqual(inbox.settings(), S.defaults())
  const n = page.posts.length
  await page.send('save')
  await page.send({ type: 'save' })
  await page.send({ type: 'nope', settings: bad })
  assert.equal(page.posts.length, n + 1, 'only the save without settings answered (refused)')
  assert.equal(page.posts.at(-1).reason, 'the settings are not an object')
  inbox.dispose()
})

test('host: a failing store is a refused save with the reason', async () => {
  const { ctx, inbox } = setup()
  await inbox.first
  const page = ctx.openSettingsPage()
  ctx.appStorage.set = async () => {
    throw new Error('disk full')
  }
  await page.send({ type: 'save', settings: S.defaults() })
  assert.deepEqual(page.last('refused'), { type: 'refused', reason: 'Saving failed: disk full' })
  inbox.dispose()
})

test('host: Test places the draft over the visible items, with five examples, a disabled rule tried as enabled', async () => {
  const items = Array.from({ length: 7 }, (_, i) => item2(`m${i}`, { time: NOW - (i + 1) * MIN, title: `<b>Mail ${i}</b>` }))
  items.push(item2('m-read', { read: true }))
  const mail = fakeFeedV2(MAIL, items)
  const { ctx, inbox } = setup({ feeds: { 'p.mail': mail } })
  await inbox.first
  await settle()
  await inbox.act({ type: 'done', key: `p.mail\u0000m6` })
  const page = ctx.openSettingsPage()
  let draft = L.addRule(S.defaults(), TABLE).draft
  draft = L.setCondition(draft, 'r1', 0, { value: 'mail' }, TABLE)
  draft = L.moveRule(draft, 'r1', 1)
  draft = L.setRule(draft, 'r1', { enabled: false })
  await page.send({ type: 'test', settings: draft, ruleId: 'r1' })
  const m = page.last('test')
  assert.equal(m.ruleId, 'r1')
  assert.equal(m.result.ok, true)
  assert.equal(m.result.rule, 2)
  assert.equal(m.result.total, 7, 'the Done item left out')
  assert.equal(m.result.holds, 7)
  assert.equal(m.result.placed, 6, 'the read one goes to Rest by rule 1')
  assert.equal(m.result.pending, 0)
  assert.deepEqual(m.result.examples.map((x) => x.title), ['<b>Mail 0</b>', '<b>Mail 1</b>', '<b>Mail 2</b>', '<b>Mail 3</b>', '<b>Mail 4</b>'])
  assert.deepEqual(m.result.examples[0], { title: '<b>Mail 0</b>', label: 'Mail', badge: 'MAIL', color: 'red', reason: 'rule 2: sourceKind is mail' })
  assert.deepEqual(inbox.settings(), S.defaults(), 'a test changes nothing')
  assert.equal(await ctx.appStorage.get(S.KEY), undefined)
  inbox.dispose()
})

test('host: Test of a bad draft or a rule not in it says why', async () => {
  const { ctx, inbox } = setup()
  await inbox.first
  const page = ctx.openSettingsPage()
  await page.send({ type: 'test', settings: { ...S.defaults(), agenda: 'x' }, ruleId: 'read' })
  assert.deepEqual(page.last('test').result, { ok: false, reason: 'the agenda must be top, bottom or off' })
  await page.send({ type: 'test', settings: S.defaults(), ruleId: 'gone' })
  assert.deepEqual(page.last('test').result, { ok: false, reason: 'that rule is not in the draft' })
  await page.send({ type: 'test', settings: S.defaults(), ruleId: 42 })
  assert.deepEqual(page.last('test'), { type: 'test', ruleId: '', result: { ok: false, reason: 'that rule is not in the draft' } })
  inbox.dispose()
})

test('host: Test of a Jev rule uses cached answers only and never asks Jev', async () => {
  const jev = fakeJev(() => 0.9)
  const mail = fakeFeedV2(MAIL, [item2('m1'), item2('m2'), item2('m3')])
  const { ctx, inbox } = setup({ feeds: { 'p.mail': mail }, ctxOpts: { jev } })
  await inbox.first
  await settle()
  const q = 'Is this urgent?'
  // m1 answered high, m2 answered low (for this rev), m3 not answered.
  await ctx.appStorage.set(cacheKey(q, 'p.mail', 'm1'), { rev: 'm1-r1', score: 0.95, at: NOW })
  await ctx.appStorage.set(cacheKey(q, 'p.mail', 'm2'), { rev: 'm2-r1', score: 0.1, at: NOW })
  await inbox.jev.load()
  const page = ctx.openSettingsPage()
  await page.send({ type: 'ready' })
  assert.equal(page.last('settings').jev, true)
  let draft = L.addRule(S.defaults(), TABLE).draft
  draft = L.setRuleParts(draft, 'r1', { jev: true, when: false }, TABLE)
  draft = L.setJev(draft, 'r1', { question: q, min: 0.8 })
  const calls = jev.calls.length
  await page.send({ type: 'test', settings: draft, ruleId: 'r1' })
  await settle()
  const r = page.last('test').result
  assert.equal(jev.calls.length, calls, 'no grid call')
  assert.deepEqual([r.total, r.placed, r.holds, r.pending], [3, 1, 1, 1])
  assert.equal(r.examples[0].reason, 'rule 1: Jev 0.95')
  inbox.dispose()
})

test('host: a page for another scope is told the settings are app-wide; the listener goes on dispose', async () => {
  const { ctx, inbox } = setup()
  await inbox.first
  const page = ctx.openSettingsPage('project')
  await page.send({ type: 'ready' })
  assert.deepEqual(page.posts, [{ type: 'fatal', reason: "Inbox's settings are app-wide: edit them under Settings > Plugins." }])
  assert.equal(ctx.live().settingsPage, 1)
  inbox.dispose()
  assert.equal(ctx.live().settingsPage, 0)
})

test('host: an app without ctx.settingsPage still runs', async () => {
  const ctx = fakeCtx()
  delete ctx.settingsPage
  const inbox = createInbox(ctx, { now: () => NOW, callMs: 200 })
  await inbox.first
  assert.ok(ctx.lastState())
  inbox.dispose()
})

// ---- the page files ----

test('index.js builds every element with textContent or a value: no markup sinks; the scripts in order', () => {
  const dir = path.join(__dirname, '..', 'settings')
  for (const f of ['index.js', 'logic.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, f)
  }
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1]), ['/__sdk/panel.js', 'logic.js', 'index.js'])
  assert.doesNotMatch(html, /<script>(?!<)/, 'no inline script (the page CSP)')
  assert.doesNotMatch(html, /on[a-z]+="/, 'no inline handlers')
})

test('logic.js and index.js share one global scope as classic scripts: no top-level name in both', () => {
  const dir = path.join(__dirname, '..', 'settings')
  const names = (src) => new Set([...src.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)].map((x) => x[1]))
  const a = names(fs.readFileSync(path.join(dir, 'logic.js'), 'utf8'))
  const b = names(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'))
  assert.deepEqual([...a].filter((n) => b.has(n)), [])
})

