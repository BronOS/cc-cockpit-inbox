'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { createInbox } = host
const S = require('../dist/lib/settings')
const { fakeCtx, fakeFeedV2, fakeJev, fakeAppStorage, item2, flush, NOW, HOUR, CHAT, MAIL, JIRA } = require('./fakes')

const MIN = 60000
/** Let the host's chains of awaits run out (each source read is a few hops). */
async function settle() {
  for (let i = 0; i < 20; i++) await flush()
}

/** Manual timers for lib/jev.js: `fire(maxMs)` runs every pending timer of at most that delay. */
function fakeTimers() {
  const list = new Map()
  let n = 0
  return {
    set(fn, ms) {
      list.set(++n, { fn, ms })
      return n
    },
    clear(id) {
      list.delete(id)
    },
    fire(maxMs = 2000) {
      for (const [id, t] of [...list]) {
        if (t.ms > maxMs) continue
        list.delete(id)
        t.fn()
      }
    },
    size: () => list.size,
  }
}

/** A host over v2 fake feeds with a movable clock and manual Jev timers. */
function setup(o = {}) {
  const ctx = o.ctx || fakeCtx(o.ctxOpts)
  const clock = { t: o.t ?? NOW }
  for (const [id, feed] of Object.entries(o.feeds || {})) ctx.addProvider(id, feed)
  const timers = fakeTimers()
  const inbox = createInbox(ctx, { now: () => clock.t, callMs: o.callMs ?? 200, jevTimers: timers })
  return { ctx, clock, timers, inbox }
}
/** group id → item ids, groups with rows only. */
const groups = (ctx) => Object.fromEntries(ctx.lastState().groups.filter((g) => g.rows.length).map((g) => [g.id, g.rows.map((r) => r.id)]))
const rowOf = (ctx, id) => ctx.lastState().groups.flatMap((g) => g.rows).find((r) => r.id === id)
const sourceCalls = (feed) => feed.calls.filter((c) => c[0] === 'act')

const chatFeed = (items) => fakeFeedV2(CHAT, items)
const mailFeed = (items) => fakeFeedV2(MAIL, items)
const jiraFeed = (items) => fakeFeedV2(JIRA, items)
const actions = (...ids) => ids.map((id) => ({ id, label: id === 'open' ? 'Open' : id === 'markRead' ? 'Mark read' : id }))

test('two sources, then a third: each placed by the default rules, newest first; described once', async () => {
  const chat = chatFeed([item2('c1', { time: NOW - HOUR }), item2('c2', { time: NOW - MIN, extra: { mentionsMe: true } })])
  const mail = mailFeed([item2('m1'), item2('m2', { read: true })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': chat, 'bronos.mail': mail } })
  await inbox.first
  await settle()
  assert.deepEqual(groups(ctx), { now: ['c2'], chat: ['c1'], mail: ['m1'], rest: ['m2'] })
  const jira = jiraFeed([item2('APP-1')])
  ctx.addProvider('bronos.jira', jira)
  await settle()
  assert.deepEqual(groups(ctx), { now: ['c2'], chat: ['c1'], mail: ['m1'], jira: ['APP-1'], rest: ['m2'] })
  assert.deepEqual(ctx.lastState().sources.map((s) => [s.badge, s.count]), [['CHAT', 2], ['MAIL', 2], ['JIRA', 1]])
  for (const f of [chat, mail, jira]) assert.equal(f.calls.filter((c) => c[0] === 'describe').length, 1)
  const r = rowOf(ctx, 'c2')
  assert.equal(r.reason, 'rule 2: sourceKind is chat and mentionsMe is true')
  assert.equal(r.badge, 'CHAT')
  assert.deepEqual(r.actions, [], 'open is the row click, not a row action')
  assert.equal(r.canOpen, true)
  inbox.dispose()
})

test('a source leaving takes its rows and its line with it', async () => {
  const { ctx, inbox } = setup({ feeds: { 'bronos.chat': chatFeed([item2('c1')]), 'bronos.mail': mailFeed([item2('m1')]) } })
  await inbox.first
  ctx.removeProvider('bronos.chat')
  await settle()
  assert.deepEqual(groups(ctx), { mail: ['m1'] })
  assert.deepEqual(ctx.lastState().sources.map((s) => s.pluginId), ['bronos.mail'])
  inbox.dispose()
})

test('an item event re-places that item only; a rules change re-places every item', async () => {
  const { ctx, clock, inbox } = setup({ feeds: { 'bronos.mail': mailFeed([item2('m1', { time: NOW - 30 * MIN }), item2('m2', { time: NOW - 30 * MIN })]) } })
  await inbox.first
  // A time rule: m1 and m2 are newer than 40 minutes when placed.
  await inbox.saveSettings({ ...S.defaults(), rules: [{ id: 'fresh', enabled: true, group: 'now', when: [{ field: 'time', op: 'newerThan', value: 40 }] }, ...S.defaults().rules] })
  await settle()
  assert.deepEqual(groups(ctx), { now: ['m1', 'm2'] })
  // Time passes: nothing moves by itself (placements stay until something about the item changes).
  clock.t = NOW + HOUR
  await inbox.tick()
  assert.deepEqual(groups(ctx), { now: ['m1', 'm2'] })
  ctx.emitFeed('bronos.mail', 'item', item2('m1', { time: NOW - 30 * MIN, title: 'new title' }))
  await settle()
  assert.deepEqual(groups(ctx), { now: ['m2'], mail: ['m1'] }, 'only the item that changed was placed again')
  assert.equal(rowOf(ctx, 'm1').title, 'new title')
  // A rules change (the settings page) places every item again, at once in this window.
  await inbox.saveSettings({ ...S.defaults() })
  await settle()
  assert.deepEqual(groups(ctx), { mail: ['m1', 'm2'] })
  inbox.dispose()
})

test('settings saved in another window apply on the next read here', async () => {
  const store = fakeAppStorage()
  const w1 = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mailFeed([item2('m1')]) } })
  const w2 = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mailFeed([item2('m1')]) } })
  await Promise.all([w1.inbox.first, w2.inbox.first])
  const rules = [{ id: 'all', enabled: true, group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }] }]
  await w1.inbox.saveSettings({ ...S.defaults(), rules })
  await settle()
  assert.deepEqual(groups(w1.ctx), { now: ['m1'] })
  assert.deepEqual(groups(w2.ctx), { mail: ['m1'] })
  await w2.ctx.sendPanel({ type: 'visible' })
  await settle()
  assert.deepEqual(groups(w2.ctx), { now: ['m1'] })
  w1.inbox.dispose()
  w2.inbox.dispose()
})

const bossRule = { id: 'boss', enabled: true, group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }], jev: { question: 'Is this urgent?', min: 0.8 } }
const withBoss = () => ({ ...S.defaults(), rules: [bossRule, ...S.defaults().rules] })

test('a Jev rule: pending first ("Jev…"), the item moves once when the answer comes, then stays', async () => {
  const store = fakeAppStorage()
  await S.saveSettings(store, withBoss())
  const jev = fakeJev((it) => (it.text.startsWith('Urgent') ? 0.95 : 0.1))
  const mail = mailFeed([item2('m1', { title: 'Urgent: the release' }), item2('m2', { title: 'Newsletter', time: NOW - 2 * HOUR })])
  const { ctx, timers, inbox } = setup({ ctx: fakeCtx({ appStorage: store, jev }), feeds: { 'bronos.mail': mail, 'bronos.chat': chatFeed([item2('c1')]) } })
  await inbox.first
  await settle()
  assert.deepEqual(groups(ctx), { chat: ['c1'], mail: ['m1', 'm2'] })
  assert.equal(rowOf(ctx, 'm1').jev, 'pending')
  assert.match(rowOf(ctx, 'm1').reason, /rule 1: Jev…/)
  timers.fire()
  await settle()
  assert.equal(jev.calls.length, 1, 'one grid for the question; chat never asked (pre-filter)')
  assert.deepEqual(jev.calls[0].items.map((i) => i.text).sort(), ['Newsletter', 'Urgent: the release'])
  assert.deepEqual(groups(ctx), { now: ['m1'], chat: ['c1'], mail: ['m2'] })
  assert.equal(rowOf(ctx, 'm1').reason, 'rule 1: sourceKind is mail and Jev 0.95')
  assert.equal(rowOf(ctx, 'm1').jev, null)
  // A read change of m1 (same rev) is placed again from the cache: no new request.
  ctx.emitFeed('bronos.mail', 'item', item2('m1', { title: 'Urgent: the release', read: true }))
  await settle()
  timers.fire()
  await settle()
  assert.equal(jev.calls.length, 1)
  assert.deepEqual(groups(ctx), { now: ['m1'], chat: ['c1'], mail: ['m2'] })
  inbox.dispose()
})

test('a full placement drops queued Jev requests of a question that went; dispose stops Jev', async () => {
  const store = fakeAppStorage()
  await S.saveSettings(store, withBoss())
  const jev = fakeJev()
  const { timers, inbox } = setup({ ctx: fakeCtx({ appStorage: store, jev }), feeds: { 'bronos.mail': mailFeed([item2('m1')]) } })
  await inbox.first
  await settle()
  assert.equal(inbox.jev.pending(), 1)
  await inbox.saveSettings(S.defaults())
  await settle()
  assert.equal(inbox.jev.pending(), 0, 'the edited rules ask nothing: the queued request is dropped')
  timers.fire()
  await settle()
  assert.equal(jev.calls.length, 0)
  // Queued again, then the plugin stops: no timer is left and nothing is asked.
  await inbox.saveSettings(withBoss())
  await settle()
  assert.equal(inbox.jev.pending(), 1)
  inbox.dispose()
  assert.equal(timers.size(), 0)
  assert.equal(jev.calls.length, 0)
})

test('Jev unavailable: the rule is skipped with its reason, and the item is placed again when a provider appears', async () => {
  const store = fakeAppStorage()
  await S.saveSettings(store, withBoss())
  const ctx = fakeCtx({ appStorage: store })
  const { timers, inbox } = setup({ ctx, feeds: { 'bronos.mail': mailFeed([item2('m1')]) } })
  await inbox.first
  await settle()
  assert.equal(rowOf(ctx, 'm1').reason, 'rule 6: sourceKind is mail · rule 1 skipped: Jev unavailable')
  ctx.jev = fakeJev(() => 0.9)
  // The minute check sees the provider and hands the parked item over: it is asked, then moves.
  timers.fire(60000)
  await settle()
  timers.fire()
  await settle()
  assert.equal(ctx.jev.calls.length, 1)
  assert.deepEqual(groups(ctx), { now: ['m1'] })
  inbox.dispose()
})

test('Done via the overlay button: only for items Inbox shows, closes the overlay, never calls the source', async () => {
  const mail = mailFeed([item2('m1', { actions: actions('open', 'markRead') })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail } })
  await inbox.first
  await settle()
  assert.deepEqual(await ctx.buttonsFor({ source: 'bronos.chat', id: 'm1' }), [], 'not an item of that source')
  assert.deepEqual(await ctx.buttonsFor({ source: 'bronos.mail', id: 'nope' }), [])
  assert.deepEqual(await ctx.buttonsFor('junk'), [])
  const [b, ...more] = await ctx.buttonsFor({ source: 'bronos.mail', id: 'm1' })
  assert.equal(more.length, 0)
  assert.equal(b.label, 'Done (Inbox)')
  assert.deepEqual(await b.run(), { close: true })
  assert.deepEqual(groups(ctx), {})
  assert.deepEqual(sourceCalls(mail), [], 'Done is Inbox memory: no markRead, no act')
  assert.deepEqual(await ctx.buttonsFor({ source: 'bronos.mail', id: 'm1' }), [], 'done already')
  assert.deepEqual(ctx.lastState().done.rows.map((r) => r.id), ['m1'])
  assert.equal(ctx.lastState().undo.label, 'Done: Item m1')
  inbox.dispose()
})

test('Done from the row and `ccc inbox done` make no source call; undo and Back to Inbox bring it back', async () => {
  const mail = mailFeed([item2('m1', { actions: actions('open', 'markRead') }), item2('m2', { time: NOW - 2 * HOUR, actions: actions('open', 'markRead') })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail } })
  await inbox.first
  await settle()
  await ctx.sendPanel({ type: 'done', key: rowOf(ctx, 'm1').key })
  assert.deepEqual(groups(ctx), { mail: ['m2'] })
  await ctx.sendPanel({ type: 'undo' })
  assert.deepEqual(groups(ctx), { mail: ['m1', 'm2'] })
  assert.equal((await ctx.runCli(['done', 'bronos.mail:m2'])).stdout, 'Done: Item m2\n')
  assert.deepEqual(groups(ctx), { mail: ['m1'] })
  assert.deepEqual(sourceCalls(mail), [])
  const back = ctx.lastState().done.rows.find((r) => r.id === 'm2')
  await ctx.sendPanel({ type: 'restore', key: back.key })
  assert.deepEqual(groups(ctx), { mail: ['m1', 'm2'] })
  // A new rev brings a done item back marked "back"; a read change alone does not.
  await ctx.sendPanel({ type: 'done', key: rowOf(ctx, 'm1').key })
  ctx.emitFeed('bronos.mail', 'item', item2('m1', { read: true, actions: actions('open', 'markRead') }))
  await settle()
  assert.equal(rowOf(ctx, 'm1'), undefined)
  ctx.emitFeed('bronos.mail', 'item', item2('m1', { rev: 'm1-r2', actions: actions('open', 'markRead') }))
  await settle()
  assert.equal(rowOf(ctx, 'm1').back, true)
  assert.deepEqual(sourceCalls(mail), [])
  inbox.dispose()
})

test('the agenda slot follows the setting: placed at start, moved and removed on a change, never repeated', async () => {
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mailFeed([]) } })
  await inbox.first
  assert.deepEqual(ctx.slotPlacements, [[{ type: 'agenda', position: 'top', height: 140 }]])
  await inbox.saveSettings({ ...S.defaults(), agenda: 'bottom' })
  await inbox.saveSettings({ ...S.defaults(), agenda: 'bottom' })
  await inbox.saveSettings({ ...S.defaults(), agenda: 'off' })
  await settle()
  assert.deepEqual(ctx.slotPlacements.slice(1), [[{ type: 'agenda', position: 'bottom', height: 140 }], null])
  assert.equal(ctx.lastState().agenda, 'off')
  inbox.dispose()
})

test('the agenda setting stored before start is placed from the start', async () => {
  const store = fakeAppStorage()
  await S.saveSettings(store, { ...S.defaults(), agenda: 'off' })
  const { ctx, inbox } = setup({ ctx: fakeCtx({ appStorage: store }) })
  await inbox.first
  assert.deepEqual(ctx.slotPlacements, [null])
  inbox.dispose()
})

test('the badge counts unread items of badge groups only', async () => {
  const mail = mailFeed([item2('m1'), item2('m2'), item2('m3', { read: true })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail, 'bronos.chat': chatFeed([item2('c1', { read: null })]) } })
  await inbox.first
  await settle()
  // m3 is read (Rest, no badge); c1 has no read state.
  assert.equal(ctx.badges.at(-1), 2)
  await ctx.sendPanel({ type: 'done', key: rowOf(ctx, 'm1').key })
  assert.equal(ctx.badges.at(-1), 1)
  await inbox.saveSettings({ ...S.defaults(), groups: S.defaults().groups.map((g) => ({ ...g, badge: false })) })
  await settle()
  assert.equal(ctx.badges.at(-1), null)
  inbox.dispose()
})

test("row actions go to act(id, action) on the item's own source; a refusal shows its message", async () => {
  const mail = mailFeed([item2('m1', { actions: actions('open', 'markRead') })])
  const chat = chatFeed([item2('c1')])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail, 'bronos.chat': chat } })
  await inbox.first
  await settle()
  const key = rowOf(ctx, 'm1').key
  assert.deepEqual(rowOf(ctx, 'm1').actions, [{ id: 'markRead', label: 'Mark read' }])
  await ctx.sendPanel({ type: 'open', key })
  await ctx.sendPanel({ type: 'act', key, action: 'markRead' })
  assert.deepEqual(sourceCalls(mail), [['act', 'm1', 'open'], ['act', 'm1', 'markRead']])
  assert.deepEqual(sourceCalls(chat), [])
  mail.actReply = { ok: false, message: 'Google refused the change' }
  await ctx.sendPanel({ type: 'act', key, action: 'markRead' })
  assert.equal(ctx.posts.at(-1).text, 'Mark read failed: Google refused the change')
  // An action the item does not list never reaches the source.
  await ctx.sendPanel({ type: 'act', key, action: 'delete' })
  assert.equal(sourceCalls(mail).length, 3)
  assert.match(ctx.posts.at(-1).text, /no such action/)
  await ctx.sendPanel({ type: 'act', key: 'bronos.mail\u0000nope', action: 'open' })
  assert.match(ctx.posts.at(-1).text, /no longer in the Inbox/)
  mail.throwOn = 'act'
  await ctx.sendPanel({ type: 'open', key })
  assert.match(ctx.posts.at(-1).text, /^Open failed: act broke/)
  inbox.dispose()
})

test('the header: updated time and refresh only; refresh asks every source for its snapshot', async () => {
  const mail = mailFeed([item2('m1')])
  const chat = chatFeed([])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail, 'bronos.chat': chat } })
  await inbox.first
  const h = ctx.headers.at(-1)
  assert.match(h.meta, /^updated \d\d:\d\d$/)
  assert.deepEqual(h.actions.map((a) => a.id), ['refresh'])
  const snaps = () => [mail, chat].map((f) => f.calls.filter((c) => c[0] === 'snapshot').length)
  const before = snaps()
  mail.items = [item2('m1'), item2('m9')]
  ctx.clickAction('refresh')
  await settle()
  assert.deepEqual(snaps(), before.map((n) => n + 1))
  assert.deepEqual(groups(ctx), { mail: ['m1', 'm9'] })
  inbox.dispose()
})

test('a source that is not ok: its line says so and its last list stays, marked stale', async () => {
  const mail = mailFeed([item2('m1')])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail } })
  await inbox.first
  ctx.emitFeed('bronos.mail', 'sync', { items: [], state: 'signedOut', message: 'sign in again', asOf: NOW })
  await settle()
  const line = ctx.lastState().sources[0]
  assert.equal(line.state, 'signedOut')
  assert.equal(line.message, 'sign in again')
  assert.equal(line.stale, true)
  assert.deepEqual(groups(ctx), { mail: ['m1'] })
  inbox.dispose()
})

test('search: every item, Rest and Done included, grouped as the list, Done ones marked', async () => {
  const mail = mailFeed([item2('m1', { title: 'Budget review' }), item2('m2', { title: 'Lunch', preview: 'about the budget', time: NOW - 2 * HOUR }), item2('m3', { title: 'Old budget', read: true })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail } })
  await inbox.first
  await settle()
  await ctx.sendPanel({ type: 'done', key: rowOf(ctx, 'm1').key })
  await ctx.sendPanel({ type: 'search', query: '  BUDGET ' })
  const s = ctx.lastState().search
  assert.equal(s.query, 'BUDGET')
  assert.equal(s.count, 3)
  assert.deepEqual(s.groups.map((g) => [g.id, g.rows.map((r) => [r.id, r.done])]), [['mail', [['m1', true], ['m2', false]]], ['rest', [['m3', false]]]])
  await ctx.sendPanel({ type: 'search', query: '' })
  assert.equal(ctx.lastState().search, null)
  inbox.dispose()
})

test('snooze hides an item; when it wakes the rules place it, marked back, announced once', async () => {
  const { ctx, clock, inbox } = setup({ feeds: { 'bronos.chat': chatFeed([item2('c1')]) } })
  await inbox.first
  await settle()
  await ctx.sendPanel({ type: 'snooze', key: rowOf(ctx, 'c1').key, choice: '1h' })
  assert.deepEqual(groups(ctx), {})
  clock.t = NOW + HOUR + MIN
  await inbox.tick()
  assert.deepEqual(groups(ctx), { chat: ['c1'] })
  assert.equal(rowOf(ctx, 'c1').back, true)
  assert.deepEqual(ctx.notes.map((n) => n.text), ['Item c1'])
  await inbox.tick()
  assert.equal(ctx.notes.length, 1)
  inbox.dispose()
})

for (const missing of ['useAll', 'slots', 'overlay.buttons']) {
  test(`an app without ${missing}: the panel says which cc-cockpit to get, nothing is read`, async () => {
    const mail = mailFeed([item2('m1')])
    const ctx = fakeCtx({ missing: [missing] })
    if (missing !== 'useAll') ctx.addProvider('bronos.mail', mail)
    const inbox = createInbox(ctx, { now: () => NOW })
    await settle()
    await ctx.sendPanel({ type: 'hello' })
    assert.match(ctx.lastState().fatal, /needs cc-cockpit 0\.10\.0/)
    assert.deepEqual(mail.calls, [])
    inbox.dispose()
  })
}

test('junk from the panel is ignored', async () => {
  const mail = mailFeed([item2('m1')])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail } })
  await inbox.first
  await settle()
  for (const m of [null, 'x', 5, { type: 7 }, { type: 'done', key: 5 }, { type: 'snooze', key: rowOf(ctx, 'm1').key, choice: 'never' }, { type: 'restore', key: {} }, { type: 'search', query: { a: 1 } }]) await ctx.sendPanel(m)
  assert.deepEqual(groups(ctx), { mail: ['m1'] })
  assert.deepEqual(sourceCalls(mail), [])
  inbox.dispose()
})

test('no sources: empty groups, no badge, and the CLI says so', async () => {
  const { ctx, inbox } = setup()
  await inbox.first
  assert.deepEqual(groups(ctx), {})
  assert.deepEqual(ctx.lastState().sources, [])
  assert.equal(ctx.badges.at(-1), null)
  assert.equal((await ctx.runCli([])).stdout, 'Inbox zero.\n')
  inbox.dispose()
})

test('two windows: a done in one shows in the other when its panel becomes visible', async () => {
  const store = fakeAppStorage()
  const w1 = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mailFeed([item2('m1'), item2('m2')]) } })
  const w2 = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mailFeed([item2('m1'), item2('m2')]) } })
  await Promise.all([w1.inbox.first, w2.inbox.first])
  await settle()
  await w1.ctx.sendPanel({ type: 'done', key: rowOf(w1.ctx, 'm1').key })
  await w1.ctx.sendPanel({ type: 'snooze', key: rowOf(w1.ctx, 'm2').key, choice: '1h' })
  assert.deepEqual(groups(w1.ctx), {})
  assert.deepEqual(groups(w2.ctx), { mail: ['m1', 'm2'] }, 'not yet: the other window reads on hello, visible and tick')
  await w2.ctx.sendPanel({ type: 'visible' })
  await settle()
  assert.deepEqual(groups(w2.ctx), {})
  w1.inbox.dispose()
  w2.inbox.dispose()
})

test('an action that hangs fails at the call limit and never holds the other sources', async () => {
  const mail = mailFeed([item2('m1', { actions: actions('open', 'markRead') })])
  const chat = chatFeed([item2('c1')])
  mail.impl.act = () => new Promise(() => {})
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail, 'bronos.chat': chat }, callMs: 30 })
  await inbox.first
  await settle()
  await ctx.sendPanel({ type: 'act', key: rowOf(ctx, 'm1').key, action: 'markRead' })
  assert.match(ctx.posts.at(-1).text, /failed: Mail markRead did not answer/)
  await ctx.sendPanel({ type: 'open', key: rowOf(ctx, 'c1').key })
  assert.deepEqual(sourceCalls(chat), [['act', 'c1', 'open']])
  inbox.dispose()
})

test('same item id in two sources: each action goes to its own source', async () => {
  const mail = mailFeed([item2('x1', { actions: actions('open', 'markRead') })])
  const chat = chatFeed([item2('x1', { actions: actions('open', 'markRead') })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail, 'bronos.chat': chat } })
  await inbox.first
  await settle()
  const rows = ctx.lastState().groups.flatMap((g) => g.rows).filter((r) => r.id === 'x1')
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].key, rows[1].key)
  const mailRow = rows.find((r) => r.badge === 'MAIL')
  await ctx.sendPanel({ type: 'act', key: mailRow.key, action: 'markRead' })
  assert.deepEqual(sourceCalls(mail), [['act', 'x1', 'markRead']])
  assert.deepEqual(sourceCalls(chat), [])
  await ctx.sendPanel({ type: 'done', key: mailRow.key })
  assert.deepEqual(rows.filter((r) => r.badge === 'CHAT').map((r) => rowOf(ctx, r.id).badge), ['CHAT'], 'the chat item stays')
  inbox.dispose()
})

test('opening a back item ends its mark only when the source opened it', async () => {
  const mail = mailFeed([item2('m1', { actions: actions('open') })])
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mail } })
  await inbox.first
  await settle()
  await ctx.sendPanel({ type: 'done', key: rowOf(ctx, 'm1').key })
  ctx.emitFeed('bronos.mail', 'item', item2('m1', { rev: 'm1-r2', actions: actions('open') }))
  await settle()
  assert.equal(rowOf(ctx, 'm1').back, true)
  mail.actReply = { ok: false, message: 'no' }
  await ctx.sendPanel({ type: 'open', key: rowOf(ctx, 'm1').key })
  await settle()
  assert.equal(rowOf(ctx, 'm1').back, true, 'a failed open keeps the mark')
  mail.actReply = { ok: true }
  await ctx.sendPanel({ type: 'open', key: rowOf(ctx, 'm1').key })
  await settle()
  assert.notEqual(rowOf(ctx, 'm1').back, true)
  inbox.dispose()
})

test('dispose removes every listener, provider, timer, command and subscription; exports.deactivate disposes', async () => {
  const idle = fakeCtx().live()
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mailFeed([item2('m1')]) } })
  await inbox.first
  const live = ctx.live()
  // One of each, and the feed's four event subscriptions (onChange, item, gone, sync).
  assert.deepEqual(live, { panel: 1, actions: 1, overlay: 1, timers: 1, cli: true, feed: 4, settingsPage: 1 })
  inbox.dispose()
  assert.deepEqual(ctx.live(), { ...idle, feed: 0 })

  const c2 = fakeCtx()
  c2.addProvider('bronos.mail', mailFeed([item2('m1')]))
  host.activate(c2)
  assert.ok(c2.live().cli)
  host.deactivate()
  assert.deepEqual(c2.live(), { ...idle, feed: 0 })
  host.deactivate()
})

// ---- storage and notify failures (ctx.appStorage is main's RPC: it can reject) ----

test('a failed shared read keeps what this window had; the next tick recovers', async () => {
  const store = fakeAppStorage()
  const w1 = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mailFeed([item2('m1'), item2('m2')]) } })
  const w2 = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mailFeed([item2('m1'), item2('m2')]) } })
  await Promise.all([w1.inbox.first, w2.inbox.first])
  await settle()
  await w2.ctx.sendPanel({ type: 'done', key: rowOf(w2.ctx, 'm1').key })
  // Settings (a get) and the Done entries (keys) both fail on w1's next read.
  store.failNext('get')
  store.failNext('keys')
  await w1.inbox.tick()
  assert.deepEqual(groups(w1.ctx), { mail: ['m1', 'm2'] }, 'the rows stay as they were')
  const warns = w1.ctx.logs.filter((l) => l[0] === 'warn').map((l) => l[1])
  assert.ok(warns.some((w) => /^settings: appStorage\.get failed/.test(w)), warns.join('\n'))
  assert.ok(warns.some((w) => /^state: appStorage\.keys failed/.test(w)), warns.join('\n'))
  await w1.inbox.tick()
  assert.deepEqual(groups(w1.ctx), { mail: ['m2'] }, 'the next read sees the other window\'s Done')
  w1.inbox.dispose()
  w2.inbox.dispose()
})

test('a Done, snooze, undo or restore whose write fails: a notice, the row unchanged, the next one works', async () => {
  const store = fakeAppStorage()
  const mail = mailFeed([item2('m1'), item2('m2', { time: NOW - 2 * HOUR })])
  const { ctx, inbox } = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mail } })
  await inbox.first
  await settle()
  const lastNotice = () => [...ctx.posts].reverse().find((m) => m.type === 'notice')
  store.failNext('set')
  await ctx.sendPanel({ type: 'done', key: rowOf(ctx, 'm1').key })
  assert.match(lastNotice().text, /^Done failed: appStorage\.set failed/)
  // Read from memory (no reload from the store in between): the failed write was taken back.
  const shown = () => inbox.snapshot().groups.flatMap((g) => g.rows.map((r) => r.id))
  assert.deepEqual(shown(), ['m1', 'm2'], 'a Done never stored is not done here either')
  assert.equal(ctx.lastState().undo, null)
  store.failNext('set')
  await ctx.sendPanel({ type: 'snooze', key: rowOf(ctx, 'm1').key, choice: '1h' })
  assert.match(lastNotice().text, /^Snooze failed: /)
  assert.deepEqual(shown(), ['m1', 'm2'])
  // The queue goes on: the next Done works, then its undo and a restore fail and change nothing.
  await ctx.sendPanel({ type: 'done', key: rowOf(ctx, 'm1').key })
  assert.deepEqual(groups(ctx), { mail: ['m2'] })
  store.failNext('delete')
  await ctx.sendPanel({ type: 'undo' })
  assert.match(lastNotice().text, /^Undo failed: appStorage\.delete failed/)
  assert.deepEqual(shown(), ['m2'])
  const back = ctx.lastState().done.rows.find((r) => r.id === 'm1')
  store.failNext('delete')
  await ctx.sendPanel({ type: 'restore', key: back.key })
  assert.match(lastNotice().text, /^Back to Inbox failed: /)
  await ctx.sendPanel({ type: 'restore', key: back.key })
  assert.deepEqual(groups(ctx), { mail: ['m1', 'm2'] })
  // `ccc inbox done` reports the failure with exit 1.
  store.failNext('set')
  const r = await ctx.runCli(['done', 'bronos.mail:m1'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^done failed: appStorage\.set failed/)
  assert.deepEqual(groups(ctx), { mail: ['m1', 'm2'] })
  assert.deepEqual(sourceCalls(mail), [])
  inbox.dispose()
})

test('a woken snooze: a notify that rejects is logged, a failed mark is logged, the tick still publishes', async () => {
  const store = fakeAppStorage()
  const ctx = fakeCtx({ appStorage: store })
  ctx.notify = async () => {
    throw new Error('notifications off')
  }
  const { clock, inbox } = setup({ ctx, feeds: { 'bronos.chat': chatFeed([item2('c1')]) } })
  await inbox.first
  await settle()
  await ctx.sendPanel({ type: 'snooze', key: rowOf(ctx, 'c1').key, choice: '1h' })
  clock.t = NOW + HOUR + MIN
  const posted = ctx.posts.length
  store.failNext('set')
  await inbox.tick()
  await settle()
  assert.deepEqual(groups(ctx), { chat: ['c1'] }, 'woken and published')
  assert.ok(ctx.posts.length > posted)
  const warns = ctx.logs.filter((l) => l[0] === 'warn').map((l) => l[1])
  assert.ok(warns.some((w) => w === 'notify: notifications off'), warns.join('\n'))
  assert.ok(warns.some((w) => /^state: appStorage\.set failed/.test(w)), warns.join('\n'))
  // The mark was not stored, so the next tick tries again (the store works now) and stores it.
  await inbox.tick()
  await settle()
  const e = [...store.map.values()].find((v) => v && v.id === 'c1')
  assert.equal(e.notified, true)
  inbox.dispose()
})

test('a first read whose storage fails still starts the panel', async () => {
  const store = fakeAppStorage()
  store.failNext('get', 3)
  store.failNext('keys', 3)
  const { ctx, inbox } = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mailFeed([item2('m1')]) } })
  await inbox.first
  await settle()
  assert.deepEqual(groups(ctx), { mail: ['m1'] })
  inbox.dispose()
})

test('a heavy inbox: the state is cut to fit the post limit, said in the panel, and still posted', async () => {
  const big = (id, o) =>
    item2(id, {
      title: `${id} ${'t'.repeat(290)}`,
      preview: 'p'.repeat(1000),
      labels: Array.from({ length: 20 }, (_, i) => `${'l'.repeat(36)}${i}`),
      actions: [{ id: 'open', label: 'Open' }, ...Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, label: 'x'.repeat(40) }))],
      ...o,
    })
  const many = (prefix, n) => Array.from({ length: n }, (_, i) => big(`${prefix}${i}`, { time: NOW - i * MIN, read: i % 2 === 0 }))
  const { ctx, inbox } = setup({ feeds: { 'bronos.mail': mailFeed(many('m', 500)), 'bronos.chat': chatFeed(many('c', 500)), 'bronos.jira': jiraFeed(many('j', 500)) } })
  await inbox.first
  await settle()
  await ctx.sendPanel({ type: 'search', query: 'ttt' })
  const s = ctx.lastState()
  assert.ok(JSON.stringify(s).length <= 800 * 1024, 'under the budget')
  assert.match(s.limited, /too large to show in full/)
  const rows = s.groups.flatMap((g) => g.rows)
  assert.ok(rows.length > 0, 'rows still listed')
  assert.ok(rows.every((r) => r.preview === undefined), 'previews dropped first')
  const mail = s.groups.find((g) => g.id === 'mail')
  assert.equal(mail.count, 250, 'the counts stay whole, so the panel says how many more')
  assert.ok(mail.rows.length < 200)
  assert.equal(ctx.logs.filter((l) => l[0] === 'error').length, 0)
  // Back under the limit: the line goes.
  await ctx.sendPanel({ type: 'search', query: '' })
  ctx.emitFeed('bronos.mail', 'sync', { items: [item2('m1')], state: 'ok', asOf: NOW })
  ctx.emitFeed('bronos.chat', 'sync', { items: [], state: 'ok', asOf: NOW })
  ctx.emitFeed('bronos.jira', 'sync', { items: [], state: 'ok', asOf: NOW })
  await settle()
  assert.equal(ctx.lastState().limited, null)
  inbox.dispose()
})

test('a group\'s open state is remembered app-wide: carried in the state, kept over a restart, junk ignored', async () => {
  const store = fakeAppStorage()
  const first = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mailFeed([item2('m1')]) } })
  await first.inbox.first
  await settle()
  assert.deepEqual(first.ctx.lastState().groupsOpen, {})
  await first.ctx.sendPanel({ type: 'groupOpen', id: 'rest', open: true })
  await first.ctx.sendPanel({ type: 'groupOpen', id: 'mail', open: false })
  for (const junk of [{ id: 'nope', open: true }, { id: 'mail', open: 'yes' }, { id: '__proto__', open: true }, { id: 5, open: true }]) await first.ctx.sendPanel({ type: 'groupOpen', ...junk })
  await first.ctx.sendPanel({ type: 'visible' })
  assert.deepEqual(first.ctx.lastState().groupsOpen, { rest: true, mail: false })
  first.inbox.dispose()
  // A new window (or the next start) reads it.
  const again = setup({ ctx: fakeCtx({ appStorage: store }), feeds: { 'bronos.mail': mailFeed([item2('m1')]) } })
  await again.inbox.first
  await settle()
  await again.ctx.sendPanel({ type: 'hello' })
  assert.deepEqual(again.ctx.lastState().groupsOpen, { rest: true, mail: false })
  again.inbox.dispose()
})
