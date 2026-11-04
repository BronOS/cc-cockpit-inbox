'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createInbox } = require('../dist/host')
const { fakeCtx, fakeFeed, fakeCalendar, fakeAppStorage, item, flush, NOW, HOUR, CHAT, MAIL, JIRA } = require('./fakes')

const MIN = 60000
/** Let the host's chains of awaits run out (each source read is a few hops). */
async function settle() {
  for (let i = 0; i < 20; i++) await flush()
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** A host with a movable clock, a 0 ms debounce and a short call limit. */
function setup(o = {}) {
  const ctx = o.ctx || fakeCtx(o.ctxOpts)
  const clock = { t: o.t ?? NOW }
  const feeds = {}
  for (const [id, feed] of Object.entries(o.feeds || {})) {
    feeds[id] = feed
    ctx.addProvider(id, feed)
  }
  const inbox = createInbox(ctx, { now: () => clock.t, debounceMs: 0, callMs: o.callMs ?? 200 })
  return { ctx, clock, feeds, inbox }
}
const ids = (ctx) => ctx.lastState().rows.map((r) => r.id)
const itemCalls = (feed) => feed.calls.filter((c) => c[0] === 'items').length

test('two providers, then a third joining: each is described once, all rows ranked together', async () => {
  const chat = fakeFeed(CHAT, [item('c1', { level: 'action', mentionsMe: true })])
  const mail = fakeFeed(MAIL, [item('m1', { level: 'fyi' })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': chat, 'bronos.mail': mail } })
  await inbox.first
  assert.deepEqual(ids(ctx), ['c1', 'm1'])
  const jira = fakeFeed(JIRA, [item('APP-1', { level: 'urgent' })], { markRead: false })
  ctx.addProvider('bronos.jira', jira)
  await settle()
  assert.deepEqual(ids(ctx), ['APP-1', 'c1', 'm1'])
  assert.deepEqual(ctx.lastState().chips.map((c) => [c.badge, c.count]), [['CHAT', 1], ['MAIL', 1], ['JIRA', 1]])
  // Once when it joins (a full refresh asks again: see "gains a feature" below).
  for (const f of [chat, mail, jira]) assert.equal(f.calls.filter((c) => c[0] === 'describe').length, 1)
  await inbox.tick()
  // Items per source by kind: chat 10, mail 10, issues 8.
  assert.deepEqual(jira.calls.find((c) => c[0] === 'items')[1], { limit: 8 })
  inbox.dispose()
})

test('a provider leaving takes its rows and chip with it', async () => {
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': fakeFeed(CHAT, [item('c1')]), 'bronos.mail': fakeFeed(MAIL, [item('m1')]) } })
  await inbox.first
  ctx.removeProvider('bronos.chat')
  await settle()
  assert.deepEqual(ids(ctx), ['m1'])
  assert.deepEqual(ctx.lastState().chips.map((c) => c.pluginId), ['bronos.mail'])
  inbox.dispose()
})

test('`changed` re-reads only its own source', async () => {
  const chat = fakeFeed(CHAT, [item('c1')])
  const mail = fakeFeed(MAIL, [item('m1')])
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': chat, 'bronos.mail': mail } })
  await inbox.first
  await settle()
  const before = { chat: itemCalls(chat), mail: itemCalls(mail) }
  chat.items = [item('c1'), item('c2')]
  ctx.emitFeed('bronos.chat', 'changed')
  ctx.emitFeed('bronos.chat', 'changed')
  await settle()
  await wait(5)
  await settle()
  assert.equal(itemCalls(chat), before.chat + 1, 'one read for two events (debounced)')
  assert.equal(itemCalls(mail), before.mail)
  assert.deepEqual(ids(ctx).sort(), ['c1', 'c2', 'm1'])
  inbox.dispose()
})

test('a throwing source keeps its last items with an error line; a hanging one never holds the others', async () => {
  const chat = fakeFeed(CHAT, [item('c1')])
  const mail = fakeFeed(MAIL, [item('m1')])
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': chat, 'bronos.mail': mail }, callMs: 50 })
  await inbox.first
  chat.throwOn = 'items'
  mail.impl.items = () => new Promise(() => {})
  mail.items = []
  await inbox.tick()
  const st = ctx.lastState()
  assert.deepEqual(ids(ctx).sort(), ['c1', 'm1'])
  const chip = (id) => st.chips.find((c) => c.pluginId === id)
  assert.equal(chip('bronos.chat').stale, true)
  assert.match(chip('bronos.chat').problem, /Chat: feed broke/)
  assert.match(chip('bronos.mail').problem, /did not answer/)
  inbox.dispose()
})

test('a signed-out source shows its line and its cached items', async () => {
  const jira = fakeFeed(JIRA, [item('APP-1')], { markRead: false })
  jira.state = 'signedOut'
  jira.message = 'signed out, showing the last items'
  const { ctx, inbox } = setup({ feeds: { 'bronos.jira': jira } })
  await inbox.first
  assert.deepEqual(ids(ctx), ['APP-1'])
  assert.equal(ctx.lastState().chips[0].problem, 'Jira: signed out, showing the last items')
  inbox.dispose()
})

test('done calls markRead only where the feed has it, and only with the setting on; undo brings it back', async () => {
  const chat = fakeFeed(CHAT, [item('c1')])
  const jira = fakeFeed(JIRA, [item('APP-1')], { markRead: false })
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': chat, 'bronos.jira': jira } })
  await inbox.first
  const key = (id) => ctx.lastState().rows.find((r) => r.id === id).key
  await inbox.act({ type: 'done', key: key('c1') })
  await inbox.act({ type: 'done', key: key('APP-1') })
  assert.deepEqual(chat.calls.filter((c) => c[0] === 'markRead'), [['markRead', 'c1']])
  assert.deepEqual(ids(ctx), [])
  assert.match(ctx.lastState().undo.label, /^Done: /)
  // Undo takes back the last action only.
  await inbox.act({ type: 'undo' })
  assert.deepEqual(ids(ctx), ['APP-1'])
  assert.equal(ctx.lastState().undo, null)
  assert.deepEqual(ctx.lastState().today.map((e) => e.id), ['c1'])
  await inbox.act({ type: 'restore', pluginId: 'bronos.chat', id: 'c1' })
  assert.deepEqual(ids(ctx).sort(), ['APP-1', 'c1'])
  // Setting off: no markRead.
  await inbox.act({ type: 'saveSettings', settings: { doneMarksRead: false } })
  await inbox.act({ type: 'done', key: key('c1') })
  assert.equal(chat.calls.filter((c) => c[0] === 'markRead').length, 1)
  inbox.dispose()
})

test('panel actions only touch rows the host listed; open restores a back item', async () => {
  const mail = fakeFeed(MAIL, [item('m1', { rev: 'r1' })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail } })
  await inbox.first
  await inbox.act({ type: 'done', key: 'bronos.mail\u0000nope' })
  await inbox.act({ type: 'open', key: 'bronos.mail\u0000nope' })
  assert.equal(mail.calls.filter((c) => c[0] === 'open' || c[0] === 'markRead').length, 0)
  const k = ctx.lastState().rows[0].key
  await inbox.act({ type: 'done', key: k })
  mail.items = [item('m1', { rev: 'r2' })]
  await inbox.tick()
  assert.equal(ctx.lastState().rows[0].back, true)
  await inbox.act({ type: 'open', key: k })
  assert.deepEqual(mail.calls.filter((c) => c[0] === 'open'), [['open', 'm1']])
  assert.equal(ctx.lastState().rows[0].back, undefined)
  inbox.dispose()
})

test('badge modes: urgent (default), urgent + action, all, off', async () => {
  const chat = fakeFeed(CHAT, [item('u', { level: 'urgent' }), item('a', { level: 'action' }), item('f', { level: 'fyi' })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': chat } })
  await inbox.first
  assert.equal(ctx.badges.at(-1), 1)
  await inbox.act({ type: 'saveSettings', settings: { badge: 'action' } })
  assert.equal(ctx.badges.at(-1), 2)
  await inbox.act({ type: 'saveSettings', settings: { badge: 'all' } })
  assert.equal(ctx.badges.at(-1), 3)
  await inbox.act({ type: 'saveSettings', settings: { badge: 'off' } })
  assert.equal(ctx.badges.at(-1), null)
  inbox.dispose()
})

test('the calendar: read when available, re-read on its `changed`, join opens only an https meet link', async () => {
  const ev = { id: 'e1', title: 'Design review', start: NOW + 18 * MIN, end: NOW + 48 * MIN, allDay: false, response: 'needsAction', meetUrl: 'https://meet.example.com/x' }
  const calendar = fakeCalendar({ events: [ev] }, [ev])
  const { ctx, inbox } = setup({ ctxOpts: { calendar }, feeds: { 'bronos.chat': fakeFeed(CHAT, [item('c1')]) } })
  await inbox.first
  assert.equal(ctx.lastState().calendar.day.events[0].title, 'Design review')
  assert.equal(ctx.lastState().calendar.position, 'top')
  calendar.day = { ...calendar.day, events: [{ ...ev, title: 'Moved review' }] }
  ctx.emitCalendar('changed')
  await settle()
  await wait(5)
  await settle()
  assert.equal(ctx.lastState().calendar.day.events[0].title, 'Moved review')
  await inbox.act({ type: 'join', eventId: 'e1' })
  await inbox.act({ type: 'join', eventId: 'unknown' })
  assert.deepEqual(ctx.external, ['https://meet.example.com/x'])
  await inbox.act({ type: 'respond', eventId: 'e1', answer: 'accepted' })
  await inbox.act({ type: 'respond', eventId: 'e1', answer: 'sure' })
  assert.deepEqual(calendar.calls.filter((c) => c[0] === 'respond'), [['respond', 'e1', 'accepted']])
  // In the list: the pin row under the urgent items.
  await inbox.act({ type: 'saveSettings', settings: { calendar: { position: 'inline' } } })
  // No urgent item, so the pinned event comes first.
  assert.deepEqual(ids(ctx), ['e1', 'c1'])
  inbox.dispose()
})

test('no calendar provider: no calendar block', async () => {
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': fakeFeed(CHAT, [item('c1')]) } })
  await inbox.first
  assert.equal(ctx.lastState().calendar, null)
  inbox.dispose()
})

test('a snooze that ends is announced once; one that ended long ago is not', async () => {
  const chat = fakeFeed(CHAT, [item('c1'), item('c2')])
  const { ctx, clock, inbox } = setup({ feeds: { 'bronos.chat': chat } })
  await inbox.first
  const key = (id) => ctx.lastState().rows.find((r) => r.id === id).key
  await inbox.act({ type: 'snooze', key: key('c1'), choice: '1h' })
  await inbox.act({ type: 'snooze', key: key('c2'), choice: '1h' })
  assert.deepEqual(ids(ctx), [])
  clock.t = NOW + HOUR + MIN
  // c2's entry: pretend it ended a day ago (the app was closed).
  const e2 = [...inbox.state.entries().values()].find((e) => e.id === 'c2')
  await ctx.appStorage.set([...ctx.appStorage.map.keys()].find((k) => ctx.appStorage.map.get(k).id === 'c2'), { ...e2, until: NOW - 24 * HOUR })
  await inbox.tick()
  assert.deepEqual(ctx.notes.map((n) => n.text), ['Item c1'])
  assert.equal(ctx.notes[0].opts.title, 'Inbox: snooze ended')
  await inbox.tick()
  assert.equal(ctx.notes.length, 1)
  // Back at the top with the snooze-back bonus.
  assert.match(ctx.lastState().rows.find((r) => r.id === 'c1').why, /snooze ended \+500/)
  inbox.dispose()
})

test('two windows: a done in one shows in the other when its panel becomes visible', async () => {
  const store = fakeAppStorage()
  const w1 = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': fakeFeed(MAIL, [item('m1')]) } })
  const w2 = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': fakeFeed(MAIL, [item('m1')]) } })
  await Promise.all([w1.inbox.first, w2.inbox.first])
  await w1.inbox.act({ type: 'done', key: w1.ctx.lastState().rows[0].key })
  assert.deepEqual(ids(w2.ctx), ['m1'])
  await w2.ctx.sendPanel({ type: 'visible' })
  assert.deepEqual(ids(w2.ctx), [])
  w1.inbox.dispose()
  w2.inbox.dispose()
})

test('a source switched off leaves the list and is not read; settings survive a reload', async () => {
  const chat = fakeFeed(CHAT, [item('c1')])
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': chat, 'bronos.mail': fakeFeed(MAIL, [item('m1')]) } })
  await inbox.first
  await inbox.act({ type: 'saveSettings', settings: { sources: { 'bronos.chat': { on: false } } } })
  const n = itemCalls(chat)
  await inbox.tick()
  assert.equal(itemCalls(chat), n)
  assert.deepEqual(ids(ctx), ['m1'])
  assert.deepEqual(ctx.lastState().chips.map((c) => c.pluginId), ['bronos.mail'])
  assert.equal(ctx.lastState().providers.find((p) => p.pluginId === 'bronos.chat').on, false)
  inbox.dispose()
})

test('an app without useAll: the panel gets the update message', async () => {
  const ctx = fakeCtx({ old: true })
  const inbox = createInbox(ctx)
  await ctx.sendPanel({ type: 'hello' })
  assert.match(ctx.lastState().fatal, /0\.9\.7/)
  inbox.dispose()
})

test('junk from the panel is ignored', async () => {
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': fakeFeed(CHAT, [item('c1')]) } })
  await inbox.first
  for (const m of [null, 'x', { type: 5 }, { type: 'snooze', key: 'x', choice: 'forever' }, { type: 'restore', pluginId: 1 }, { type: 'nope' }]) await ctx.sendPanel(m)
  assert.deepEqual(ids(ctx), ['c1'])
  inbox.dispose()
})

test('no providers at all: an empty list, no chips, no badge, and the CLI says so', async () => {
  const { ctx, inbox } = setup({})
  await inbox.first
  const st = ctx.lastState()
  assert.deepEqual([st.rows, st.chips, st.calendar], [[], [], null])
  assert.deepEqual(ctx.badges, [null])
  assert.match((await ctx.runCli([])).stdout, /Inbox zero/)
  inbox.dispose()
})

test('the Read chip: read messages of the sources that offer them, newest first; they open and never take done', async () => {
  const chat = fakeFeed(CHAT, [item('c1')], { recent: [item('r1', { unread: false, at: NOW - 3 * HOUR }), item('r2', { unread: false, at: NOW - HOUR }), item('sneaky', { unread: true })] })
  const jira = fakeFeed(JIRA, [item('APP-1')], { markRead: false })
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': chat, 'bronos.jira': jira } })
  await inbox.first
  const st = ctx.lastState()
  assert.deepEqual(st.read.map((r) => r.id), ['r2', 'r1'], 'unread rows from recent are left out')
  assert.equal(st.read[0].read, true)
  assert.deepEqual(chat.calls.find((c) => c[0] === 'recent')[1], { limit: 20 })
  await inbox.act({ type: 'open', key: st.read[0].key })
  assert.deepEqual(chat.calls.filter((c) => c[0] === 'open'), [['open', 'r2']])
  await inbox.act({ type: 'done', key: st.read[0].key })
  await inbox.act({ type: 'snooze', key: st.read[0].key, choice: '1h' })
  assert.equal(chat.calls.filter((c) => c[0] === 'markRead').length, 0)
  assert.equal(ctx.lastState().today.length, 0)
  // A source switched off takes its read rows with it.
  await inbox.act({ type: 'saveSettings', settings: { sources: { 'bronos.chat': { on: false } } } })
  assert.deepEqual(ctx.lastState().read, [])
  inbox.dispose()
})

test('no source offers read messages: no Read chip', async () => {
  const { ctx, inbox } = setup({ feeds: { 'bronos.jira': fakeFeed(JIRA, [item('APP-1')], { markRead: false }) } })
  await inbox.first
  assert.equal(ctx.lastState().read, null)
  inbox.dispose()
})

test('a provider that gains a feature while it stays listed is seen on the next full refresh', async () => {
  const chat = fakeFeed(CHAT, [item('c1')])
  const { ctx, clock, inbox } = setup({ feeds: { 'bronos.chat': chat } })
  await inbox.first
  assert.equal(ctx.lastState().read, null)
  clock.t += 61000
  // The plugin reloaded with `recent` (same plugin id, no onChange).
  chat.impl.features = async () => ['markRead', 'recent']
  chat.impl.recent = async () => ({ items: [item('r1', { unread: false })], asOf: NOW, state: 'ok' })
  await inbox.tick()
  assert.deepEqual(ctx.lastState().read.map((r) => r.id), ['r1'])
  // A describe that fails later keeps the last description.
  chat.impl.describe = async () => { throw new Error('busy') }
  clock.t += 61000
  await inbox.tick()
  assert.equal(ctx.lastState().chips[0].label, 'Chat')
  assert.equal(ctx.lastState().chips[0].problem, undefined)
  inbox.dispose()
})
