'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createInbox } = require('../dist/host')
const C = require('../dist/lib/cli')
const { fakeCtx, fakeFeed, item, NOW, HOUR, CHAT, MAIL } = require('./fakes')

function setup(feeds) {
  const ctx = fakeCtx()
  for (const [id, f] of Object.entries(feeds)) ctx.addProvider(id, f)
  const inbox = createInbox(ctx, { now: () => NOW, debounceMs: 0, callMs: 200 })
  return { ctx, inbox }
}
const two = () => ({
  'bronos.chat': fakeFeed(CHAT, [item('c1', { title: 'Lunch?', level: 'urgent', at: NOW - 4 * 60000 })]),
  'bronos.mail': fakeFeed(MAIL, [item('m/1:x', { title: 'Invoice', level: 'fyi', at: NOW - 3 * HOUR })]),
})

test('list: header, numbers, badge, level, title, age, ref', async () => {
  const { ctx, inbox } = setup(two())
  const r = await ctx.runCli([])
  assert.equal(r.code ?? 0, 0)
  assert.deepEqual(r.stdout.split('\n'), [
    'Inbox: 2 items',
    '1. [CHAT] urgent Lunch? (4m) bronos.chat:c1',
    '2. [MAIL] fyi Invoice (3h) bronos.mail:m/1:x',
    '',
  ])
  assert.equal((await ctx.runCli(['list'])).stdout, r.stdout)
  inbox.dispose()
})

test('list: hostile and long titles stay one clean, cut line; at most 50 rows', async () => {
  const hostile = 'Hi\nFAKE\r\n9. [CHAT] urgent x\u001b[31m\u0007 ' + 'z'.repeat(300)
  const many = Array.from({ length: 50 }, (_, i) => item(`n${i}`, { title: `T${i}`, at: NOW - i * 60000 }))
  const { ctx, inbox } = setup({ 'bronos.chat': fakeFeed(CHAT, [item('h', { title: hostile, level: 'urgent' })]), 'bronos.mail': fakeFeed(MAIL, many) })
  const out = (await ctx.runCli([])).stdout
  const lines = out.trimEnd().split('\n')
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(out))
  assert.ok(lines.length <= 51)
  assert.match(lines[0], /^Inbox: \d+ items/)
  const h = lines.find((l) => l.includes('FAKE'))
  assert.ok(h.length < 220)
  assert.ok(h.includes('…'))
  inbox.dispose()
})

test('empty inbox', async () => {
  const { ctx, inbox } = setup({ 'bronos.chat': fakeFeed(CHAT, []) })
  assert.equal((await ctx.runCli([])).stdout, 'Inbox zero.\n')
  inbox.dispose()
})

test('done by number and by ref: marks read, leaves the list', async () => {
  const f = two()
  const { ctx, inbox } = setup(f)
  let r = await ctx.runCli(['done', '1'])
  assert.equal(r.stdout, 'Done: Lunch?\n')
  assert.deepEqual(f['bronos.chat'].calls.filter((c) => c[0] === 'markRead'), [['markRead', 'c1']])
  r = await ctx.runCli(['done', 'bronos.mail:m/1:x'])
  assert.equal(r.stdout, 'Done: Invoice\n')
  assert.deepEqual(f['bronos.mail'].calls.filter((c) => c[0] === 'markRead'), [['markRead', 'm/1:x']])
  assert.equal((await ctx.runCli([])).stdout, 'Inbox zero.\n')
  inbox.dispose()
})

test('open by number and by ref calls the provider and keeps the row', async () => {
  const f = two()
  const { ctx, inbox } = setup(f)
  assert.equal((await ctx.runCli(['open', '2'])).stdout, 'Opened Invoice\n')
  assert.equal((await ctx.runCli(['open', 'bronos.chat:c1'])).stdout, 'Opened Lunch?\n')
  assert.deepEqual(f['bronos.mail'].calls.filter((c) => c[0] === 'open'), [['open', 'm/1:x']])
  assert.deepEqual(f['bronos.chat'].calls.filter((c) => c[0] === 'open'), [['open', 'c1']])
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
  await bad(['frobnicate'], /unknown command/)
  await bad(['done', '9'], /No item 9: the list has 2/, 1)
  await bad(['done', '0'], /No item 0/, 1)
  await bad(['done', 'bronos.chat:nope'], /No item with ref/, 1)
  assert.match((await ctx.runCli(['help'])).stdout, /ccc inbox done <n\|ref>/)
  assert.match((await ctx.runCli([])).stdout, /^Inbox: 2 items/)
  inbox.dispose()
})

test('parse and resolve basics', () => {
  assert.deepEqual(C.parse([]), { cmd: 'list' })
  assert.deepEqual(C.parse(['snooze', 'a:b', 'tomorrow']), { cmd: 'snooze', target: 'a:b', choice: 'tomorrow' })
  assert.equal(C.age(NOW - 2 * 86400000, NOW), '2d')
  assert.equal(C.resolve([], '1').error, 'No item: the inbox is empty.')
})
