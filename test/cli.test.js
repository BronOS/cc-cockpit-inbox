'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createInbox } = require('../dist/host')
const C = require('../dist/lib/cli')
const { fakeCtx, fakeFeedV2, item2, NOW, HOUR, CHAT, MAIL } = require('./fakes')

function setup(feeds) {
  const ctx = fakeCtx()
  for (const [id, f] of Object.entries(feeds)) ctx.addProvider(id, f)
  const inbox = createInbox(ctx, { now: () => NOW, callMs: 200 })
  return { ctx, inbox }
}
const two = () => ({
  'bronos.chat': fakeFeedV2(CHAT, [item2('c1', { title: 'Lunch?', time: NOW - 4 * 60000 })]),
  'bronos.mail': fakeFeedV2(MAIL, [item2('m/1:x', { title: 'Invoice', time: NOW - 3 * HOUR })]),
})

test('list: groups with numbered rows, badge, title, age, ref and the reason', async () => {
  const { ctx, inbox } = setup(two())
  const r = await ctx.runCli([])
  assert.equal(r.code ?? 0, 0)
  assert.deepEqual(r.stdout.split('\n'), [
    'Inbox: 2 items',
    'Chat (1)',
    '1. [CHAT] Lunch? (4m) bronos.chat:c1',
    '     rule 4: sourceKind is chat',
    'Mail (1)',
    '2. [MAIL] Invoice (3h) bronos.mail:m/1:x',
    '     rule 5: sourceKind is mail',
    '',
  ])
  assert.equal((await ctx.runCli(['list'])).stdout, r.stdout)
  inbox.dispose()
})

test('list: hostile and long titles stay one clean, cut line; at most 50 rows', async () => {
  const hostile = 'Hi\nFAKE\r\n9. [CHAT] urgent x\u001b[31m\u0007 ' + 'z'.repeat(300)
  const many = Array.from({ length: 50 }, (_, i) => item2(`n${i}`, { title: `T${i}`, time: NOW - i * 60000 }))
  const { ctx, inbox } = setup({ 'bronos.chat': fakeFeedV2(CHAT, [item2('h', { title: hostile })]), 'bronos.mail': fakeFeedV2(MAIL, many) })
  const out = (await ctx.runCli([])).stdout
  const lines = out.trimEnd().split('\n')
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(out))
  assert.ok(lines.length <= 50 * 2 + 3, 'rows, their reasons and the group headers')
  assert.match(lines[0], /^Inbox: \d+ items/)
  const h = lines.find((l) => l.includes('FAKE'))
  assert.ok(h.length < 220)
  assert.ok(lines.every((l) => l.length < 260))
  assert.ok(h.includes('…'))
  inbox.dispose()
})

test('empty inbox', async () => {
  const { ctx, inbox } = setup({ 'bronos.chat': fakeFeedV2(CHAT, []) })
  assert.equal((await ctx.runCli([])).stdout, 'Inbox zero.\n')
  inbox.dispose()
})

test('done by number and by ref: leaves the list, never calls the source', async () => {
  const f = two()
  const { ctx, inbox } = setup(f)
  let r = await ctx.runCli(['done', '1'])
  assert.equal(r.stdout, 'Done: Lunch?\n')
  r = await ctx.runCli(['done', 'bronos.mail:m/1:x'])
  assert.equal(r.stdout, 'Done: Invoice\n')
  for (const feed of Object.values(f)) assert.deepEqual(feed.calls.filter((c) => c[0] === 'act'), [])
  assert.equal((await ctx.runCli([])).stdout, 'Inbox zero.\n')
  inbox.dispose()
})

test('open by number and by ref asks the provider to open it and keeps the row', async () => {
  const f = two()
  const { ctx, inbox } = setup(f)
  assert.equal((await ctx.runCli(['open', '2'])).stdout, 'Opened Invoice\n')
  assert.equal((await ctx.runCli(['open', 'bronos.chat:c1'])).stdout, 'Opened Lunch?\n')
  assert.deepEqual(f['bronos.mail'].calls.filter((c) => c[0] === 'act'), [['act', 'm/1:x', 'open']])
  assert.deepEqual(f['bronos.chat'].calls.filter((c) => c[0] === 'act'), [['act', 'c1', 'open']])
  assert.match((await ctx.runCli([])).stdout, /^Inbox: 2 items/)
  inbox.dispose()
})

test('snooze by number and by ref removes the row', async () => {
  const { ctx, inbox } = setup(two())
  const r = await ctx.runCli(['snooze', '1', '1h'])
  assert.match(r.stdout, /^Snoozed until \d{4}-\d\d-\d\d \d\d:\d\d: Lunch\?\n$/)
  assert.match((await ctx.runCli(['snooze', 'bronos.mail:m/1:x', 'changes'])).stdout, /^Snoozed until it changes: Invoice/)
  assert.equal((await ctx.runCli([])).stdout, 'Inbox zero.\n')
  inbox.dispose()
})

test('bad arguments: clear message, non-zero exit', async () => {
  const { ctx, inbox } = setup(two())
  const bad = async (argv, re, code = 2) => {
    const r = await ctx.runCli(argv)
    assert.equal(r.code, code, argv.join(' '))
    assert.match(r.stderr, re)
    assert.ok(!r.stdout)
  }
  await bad(['done'], /needs a number or a ref/)
  await bad(['open'], /needs a number or a ref/)
  await bad(['snooze'], /needs a number/)
  await bad(['snooze', '1'], /needs a choice/)
  await bad(['snooze', '1', 'noon'], /unknown snooze choice "noon"/)
  await bad(['act'], /needs a number or a ref and an action id/)
  await bad(['act', '1'], /needs an action id/)
  await bad(['act', '1', 'a', 'b'], /one action id/)
  await bad(['act', '1', 'Bad Id'], /bad action id "Bad Id"/)
  await bad(['why'], /needs a number or a ref/)
  await bad(['why', '1', '2'], /takes one number or ref/)
  await bad(['undo', 'x'], /undo takes no arguments/)
  await bad(['frobnicate'], /unknown command/)
  await bad(['done', '9'], /No item 9: the list has 2/, 1)
  await bad(['done', '0'], /No item 0/, 1)
  await bad(['done', 'bronos.chat:nope'], /No item with ref/, 1)
  assert.match((await ctx.runCli(['help'])).stdout, /ccc inbox done <n\|ref>/)
  for (const c of ['act <n|ref> <action>', 'undo', 'why <n|ref>']) assert.ok((await ctx.runCli(['help'])).stdout.includes(`ccc inbox ${c}`), c)
  assert.match((await ctx.runCli([])).stdout, /^Inbox: 2 items/)
  inbox.dispose()
})

test('parse and resolve basics', () => {
  assert.deepEqual(C.parse([]), { cmd: 'list' })
  assert.deepEqual(C.parse(['snooze', 'a:b', 'tomorrow']), { cmd: 'snooze', target: 'a:b', choice: 'tomorrow' })
  assert.equal(C.age(NOW - 2 * 86400000, NOW), '2d')
  assert.equal(C.resolve([], '1').error, 'No item: the inbox is empty.')
})

test('act runs the item\'s own action at its source; a missing action and a refusal are errors', async () => {
  const f = {
    'bronos.chat': fakeFeedV2(CHAT, [item2('c1', { title: 'Lunch?', actions: [{ id: 'open', label: 'Open' }, { id: 'markRead', label: 'Mark read' }] })]),
  }
  const { ctx, inbox } = setup(f)
  let r = await ctx.runCli(['act', '1', 'markRead'])
  assert.equal(r.code ?? 0, 0)
  assert.equal(r.stdout, 'Mark read: Lunch?\n')
  assert.deepEqual(f['bronos.chat'].calls.filter((c) => c[0] === 'act'), [['act', 'c1', 'markRead']])
  r = await ctx.runCli(['act', 'bronos.chat:c1', 'archive'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /no such action/)
  f['bronos.chat'].actReply = { ok: false, message: 'signed out' }
  r = await ctx.runCli(['act', '1', 'markRead'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Mark read failed: signed out/)
  assert.match((await ctx.runCli(['act', '5', 'markRead'])).stderr, /No item 5/)
  inbox.dispose()
})

test('undo takes back the last done, and says so when there is nothing', async () => {
  const { ctx, inbox } = setup(two())
  let r = await ctx.runCli(['undo'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Nothing to undo/)
  await ctx.runCli(['done', '1'])
  assert.match((await ctx.runCli([])).stdout, /^Inbox: 1 item\n/)
  r = await ctx.runCli(['undo'])
  assert.equal(r.stdout, 'Undone: Done: Lunch?\n')
  assert.match((await ctx.runCli([])).stdout, /^Inbox: 2 items/)
  assert.match((await ctx.runCli(['undo'])).stderr, /Nothing to undo/, 'one undo only')
  inbox.dispose()
})

test('undo after a snooze brings the row back; after the window it is refused', async () => {
  let t = NOW
  const ctx = fakeCtx()
  for (const [id, f] of Object.entries(two())) ctx.addProvider(id, f)
  const inbox = createInbox(ctx, { now: () => t, callMs: 200 })
  await ctx.runCli(['snooze', '1', '1h'])
  assert.match((await ctx.runCli(['undo'])).stdout, /^Undone: Snoozed: Lunch\?/)
  assert.match((await ctx.runCli([])).stdout, /^Inbox: 2 items/)
  await ctx.runCli(['done', '1'])
  t += 7000
  assert.match((await ctx.runCli(['undo'])).stderr, /Nothing to undo/)
  inbox.dispose()
})

test('why prints the whole trace: each rule, why it did not hold, and where it landed', async () => {
  const { ctx, inbox } = setup(two())
  const r = await ctx.runCli(['why', '2'])
  assert.equal(r.code ?? 0, 0)
  const lines = r.stdout.trimEnd().split('\n')
  assert.equal(lines[0], 'Invoice (bronos.mail:m/1:x)')
  assert.match(lines[1], /^rule 1 → Rest: failed: read is true \(was: false\)$/)
  assert.match(lines[2], /^rule 2 → Now: failed: /)
  assert.match(lines[5], /^rule 5 → Mail: held: sourceKind is mail$/)
  assert.match(lines[6], /^rule 6 → Jira: not checked$/)
  assert.equal(lines[7], 'placed in Mail: rule 5: sourceKind is mail')
  assert.equal((await ctx.runCli(['why', 'bronos.mail:m/1:x'])).stdout, r.stdout)
  assert.match((await ctx.runCli(['why', '9'])).stderr, /No item 9/)
  inbox.dispose()
})

test('why: a disabled rule and a Jev rule without a cached answer are said plainly, and the output is bounded', async () => {
  const { ctx, inbox } = setup(two())
  const base = inbox.settings()
  const jevRule = { id: 'j', name: 'Urgent\nFAKE', enabled: true, group: 'now', jev: { question: 'Is this urgent?', min: 0.8 } }
  const off = { id: 'off', enabled: false, group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }] }
  const saved = await inbox.saveSettings({ ...base, rules: [off, jevRule, ...base.rules] })
  assert.ok(saved === undefined || saved.ok !== false, JSON.stringify(saved))
  const out = (await ctx.runCli(['why', 'bronos.mail:m/1:x'])).stdout
  assert.match(out, /rule 1 → Now: disabled/)
  assert.match(out, /rule 2 \(Urgent FAKE\) → Now: (pending|unavailable)/)
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(out))
  assert.ok(out.trimEnd().split('\n').every((l) => l.length <= 260))
  inbox.dispose()
})

test('formatWhy cuts a long trace', () => {
  const text = Array.from({ length: 200 }, (_, i) => `rule ${i + 1}: ${'x'.repeat(400)}`).join('\n')
  const lines = C.formatWhy({ pluginId: 'a', id: 'b', title: 't' }, text).trimEnd().split('\n')
  assert.equal(lines.length, 1 + 60 + 1)
  assert.match(lines.at(-1), /^… 140 more lines$/)
  assert.ok(lines.every((l) => l.length <= 240))
})

test('parse: the new commands', () => {
  assert.deepEqual(C.parse(['undo']), { cmd: 'undo' })
  assert.deepEqual(C.parse(['why', '3']), { cmd: 'why', target: '3' })
  assert.deepEqual(C.parse(['act', 'a:b', 'markRead']), { cmd: 'act', target: 'a:b', action: 'markRead' })
})
