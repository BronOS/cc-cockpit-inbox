'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createSources, MAX_BUFFER } = require('../dist/lib/sources')
const { CAPS } = require('../dist/lib/feed')
const { NOW, HOUR, item2, fakeFeedV2, fakeCtx, flush, CHAT, MAIL } = require('./fakes')

const V2_MAIL = { ...MAIL, scope: 'Inbox, unread 7 days' }
const V2_CHAT = { ...CHAT, scope: 'Mentions and DMs' }

/** A ctx with the given providers, and a started store over its `useAll('inbox-feed')`. */
async function setup(providers = {}, opts = {}) {
  const ctx = fakeCtx()
  for (const [id, feed] of Object.entries(providers)) ctx.addProvider(id, feed)
  const warns = []
  const changes = []
  const store = createSources(ctx.services.useAll('inbox-feed'), {
    log: { warn: (m) => warns.push(m) },
    onChange: (id) => changes.push(id),
    callMs: opts.callMs ?? 1000,
  })
  await store.start()
  await flush()
  return { ctx, store, warns, changes }
}
const ids = (store, pluginId) => store.get(pluginId).items.map((i) => i.id)

test('start: describe once, snapshot, items carry the registry id as source', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('t1', { time: NOW - 2 * HOUR }), item2('t2', { extra: { source: 'bronos.chat' } })])
  const { store } = await setup({ 'bronos.gmail': mail })
  const s = store.get('bronos.gmail')
  assert.deepEqual(s.desc, { label: 'Mail', badge: 'MAIL', color: 'red', kind: 'mail', scope: 'Inbox, unread 7 days' })
  assert.deepEqual(s.items.map((i) => i.id), ['t2', 't1'], 'newest first')
  assert.ok(s.items.every((i) => i.source === 'bronos.gmail'), 'a data field never names the source')
  assert.equal(s.state, 'ok')
  assert.equal(s.loaded, true)
  assert.equal(s.stale, false)
  await store.snapshot('bronos.gmail')
  assert.equal(mail.calls.filter((c) => c[0] === 'describe').length, 1, 'describe once per provider instance')
  assert.equal(mail.calls.filter((c) => c[0] === 'snapshot').length, 2)
  store.dispose()
})

test('item replaces the whole item, gone removes, sync replaces the set', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('a', { preview: 'first' }), item2('b')])
  const { ctx, store, changes } = await setup({ 'bronos.gmail': mail })
  changes.length = 0
  ctx.emitFeed('bronos.gmail', 'item', item2('a', { rev: 'a-r2', title: 'New title' }))
  await flush()
  const a = store.get('bronos.gmail').items.find((i) => i.id === 'a')
  assert.equal(a.title, 'New title')
  assert.equal(a.rev, 'a-r2')
  assert.equal(a.preview, undefined, 'whole item, never a patch')
  ctx.emitFeed('bronos.gmail', 'item', item2('c', { time: NOW }))
  ctx.emitFeed('bronos.gmail', 'gone', { ids: ['b', 'unknown'] })
  await flush()
  assert.deepEqual(ids(store, 'bronos.gmail'), ['c', 'a'])
  ctx.emitFeed('bronos.gmail', 'sync', { items: [item2('z')], state: 'ok', asOf: NOW })
  await flush()
  assert.deepEqual(ids(store, 'bronos.gmail'), ['z'])
  assert.deepEqual(changes, ['bronos.gmail', 'bronos.gmail', 'bronos.gmail', 'bronos.gmail'])
  store.dispose()
})

test('buffering: events during a pending snapshot apply after it, so an older snapshot never wins', async () => {
  const ctx = fakeCtx()
  const mail = fakeFeedV2(V2_MAIL, [item2('a'), item2('b')])
  const release = mail.hold()
  ctx.addProvider('bronos.gmail', mail)
  const store = createSources(ctx.services.useAll('inbox-feed'), { callMs: 1000 })
  const started = store.start()
  await flush()
  assert.equal(store.get('bronos.gmail').pending, true)
  // Newer than the snapshot the provider is still answering.
  ctx.emitFeed('bronos.gmail', 'item', item2('a', { rev: 'a-r2', title: 'Newer' }))
  ctx.emitFeed('bronos.gmail', 'gone', { ids: ['b'] })
  ctx.emitFeed('bronos.gmail', 'item', item2('c'))
  await flush()
  assert.equal(store.get('bronos.gmail').items.length, 0, 'nothing applied before the snapshot')
  release()
  await started
  const s = store.get('bronos.gmail')
  assert.equal(s.pending, false)
  assert.deepEqual(s.items.map((i) => [i.id, i.title]).sort(), [['a', 'Newer'], ['c', 'Item c']])
  store.dispose()
})

test('buffer overflow drops the buffer and asks a second snapshot', async () => {
  const ctx = fakeCtx()
  const mail = fakeFeedV2(V2_MAIL, [item2('a')])
  const release = mail.hold()
  ctx.addProvider('bronos.gmail', mail)
  const store = createSources(ctx.services.useAll('inbox-feed'), { callMs: 1000 })
  const started = store.start()
  await flush()
  for (let i = 0; i <= MAX_BUFFER; i++) ctx.emitFeed('bronos.gmail', 'item', item2(`e${i}`))
  await flush()
  mail.items = [item2('fresh')]
  release()
  await started
  await flush()
  assert.equal(mail.calls.filter((c) => c[0] === 'snapshot').length, 2)
  assert.deepEqual(ids(store, 'bronos.gmail'), ['fresh'])
  store.dispose()
})

test('a provider leaving takes its items; rejoining is a new instance (described and snapshotted again)', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('a')])
  const chat = fakeFeedV2(V2_CHAT, [item2('spaces/S1/threads/T1')])
  const { ctx, store, changes } = await setup({ 'bronos.gmail': mail, 'bronos.chat': chat })
  changes.length = 0
  ctx.removeProvider('bronos.gmail')
  await flush()
  assert.equal(store.get('bronos.gmail'), null)
  assert.deepEqual(store.list().map((s) => s.pluginId), ['bronos.chat'])
  assert.ok(changes.includes('bronos.gmail'))
  // An event from a provider no longer in the set is dropped.
  ctx.emitFeed('bronos.gmail', 'item', item2('ghost'))
  await flush()
  assert.equal(store.get('bronos.gmail'), null)
  mail.items = [item2('b')]
  ctx.addProvider('bronos.gmail', mail)
  await flush()
  await flush()
  assert.deepEqual(ids(store, 'bronos.gmail'), ['b'])
  assert.equal(mail.calls.filter((c) => c[0] === 'describe').length, 2)
  assert.deepEqual(ids(store, 'bronos.chat'), ['spaces/S1/threads/T1'], 'other sources untouched')
  store.dispose()
})

test('a late snapshot of a provider that left is dropped', async () => {
  const ctx = fakeCtx()
  const mail = fakeFeedV2(V2_MAIL, [item2('a')])
  const release = mail.hold()
  ctx.addProvider('bronos.gmail', mail)
  const store = createSources(ctx.services.useAll('inbox-feed'), { callMs: 1000 })
  void store.start()
  await flush()
  ctx.removeProvider('bronos.gmail')
  await flush()
  release()
  await flush()
  await flush()
  assert.equal(store.get('bronos.gmail'), null)
  assert.equal(store.list().length, 0)
  store.dispose()
})

test('an event before onChange announces the provider joins it behind its snapshot', async () => {
  const { ctx, store } = await setup({})
  const mail = fakeFeedV2(V2_MAIL, [item2('a')])
  const release = mail.hold()
  // The registry lists it, but the onChange has not run yet when the event comes.
  ctx.addProvider('bronos.gmail', mail)
  ctx.emitFeed('bronos.gmail', 'item', item2('b'))
  await flush()
  assert.equal(store.get('bronos.gmail').pending, true)
  release()
  await store.sync()
  await flush()
  assert.deepEqual(ids(store, 'bronos.gmail').sort(), ['a', 'b'])
  assert.equal(mail.calls.filter((c) => c[0] === 'snapshot').length, 1)
  store.dispose()
})

test('a throwing snapshot is that source error line only; buffered events still apply', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('a')])
  const chat = fakeFeedV2(V2_CHAT, [item2('spaces/S1/threads/T1')])
  mail.throwOn = 'snapshot'
  const { ctx, store, warns } = await setup({ 'bronos.gmail': mail, 'bronos.chat': chat })
  const s = store.get('bronos.gmail')
  assert.match(s.error, /^Mail: snapshot broke/)
  assert.equal(s.items.length, 0)
  assert.ok(warns.some((w) => w.includes('bronos.gmail snapshot')))
  assert.equal(store.get('bronos.chat').error, null)
  assert.equal(store.get('bronos.chat').items.length, 1)
  // Events still land; a later good sync clears the error.
  ctx.emitFeed('bronos.gmail', 'item', item2('b'))
  await flush()
  assert.deepEqual(ids(store, 'bronos.gmail'), ['b'])
  assert.equal(store.get('bronos.gmail').stale, true, 'items Inbox cannot vouch for while the error stands')
  ctx.emitFeed('bronos.gmail', 'sync', { items: [item2('a')], state: 'ok', asOf: NOW })
  await flush()
  assert.equal(store.get('bronos.gmail').error, null)
  assert.equal(store.get('bronos.gmail').stale, false)
  store.dispose()
})

test('a snapshot that never answers times out into an error', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('a')])
  mail.hold()
  const { store } = await setup({ 'bronos.gmail': mail }, { callMs: 20 })
  assert.match(store.get('bronos.gmail').error, /did not answer/)
  assert.equal(store.get('bronos.gmail').pending, false)
  store.dispose()
})

test('a failing describe falls back to the id and is asked again with the next snapshot', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('a')])
  mail.throwOn = 'describe'
  const { store } = await setup({ 'bronos.gmail': mail })
  assert.equal(store.get('bronos.gmail').desc.label, 'gmail')
  assert.deepEqual(ids(store, 'bronos.gmail'), ['a'])
  mail.throwOn = null
  await store.snapshot('bronos.gmail')
  assert.equal(store.get('bronos.gmail').desc.label, 'Mail')
  store.dispose()
})

test('signedOut and error keep the last list, stale, with the message', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('a'), item2('b')])
  const { ctx, store } = await setup({ 'bronos.gmail': mail })
  ctx.emitFeed('bronos.gmail', 'sync', { items: [], state: 'signedOut', message: 'Sign in to Gmail', asOf: NOW })
  await flush()
  let s = store.get('bronos.gmail')
  assert.equal(s.state, 'signedOut')
  assert.equal(s.message, 'Sign in to Gmail')
  assert.deepEqual(s.items.map((i) => i.id).sort(), ['a', 'b'])
  assert.equal(s.stale, true)
  // A non-ok sync that carries its last known list replaces it, still stale.
  ctx.emitFeed('bronos.gmail', 'sync', { items: [item2('a')], state: 'error', message: 'Google answered 500', asOf: NOW })
  await flush()
  s = store.get('bronos.gmail')
  assert.equal(s.state, 'error')
  assert.deepEqual(s.items.map((i) => i.id), ['a'])
  assert.equal(s.stale, true)
  // A malformed sync is an error with Inbox's message; the list stays.
  ctx.emitFeed('bronos.gmail', 'sync', 'junk')
  await flush()
  s = store.get('bronos.gmail')
  assert.equal(s.state, 'error')
  assert.match(s.message, /cannot read/)
  assert.deepEqual(s.items.map((i) => i.id), ['a'])
  ctx.emitFeed('bronos.gmail', 'sync', { items: [item2('c')], state: 'ok', asOf: NOW })
  await flush()
  s = store.get('bronos.gmail')
  assert.equal(s.state, 'ok')
  assert.equal(s.message, null)
  assert.equal(s.stale, false)
  store.dispose()
})

test('refused counts: from the snapshot, then added by events; a sync resets them', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('a'), item2('a'), { id: '' }, item2('b', { time: -1 })])
  const { ctx, store } = await setup({ 'bronos.gmail': mail })
  assert.equal(store.get('bronos.gmail').refused, 3)
  ctx.emitFeed('bronos.gmail', 'item', { id: 'x', title: 'no rev or time' })
  ctx.emitFeed('bronos.gmail', 'gone', { ids: ['ok', 5] })
  await flush()
  assert.equal(store.get('bronos.gmail').refused, 5)
  ctx.emitFeed('bronos.gmail', 'gone', { ids: Array.from({ length: CAPS.gone + 2 }, (_, i) => `g${i}`) })
  await flush()
  assert.equal(store.get('bronos.gmail').refused, 7, 'ids past 500 in one event are not applied')
  ctx.emitFeed('bronos.gmail', 'sync', { items: [item2('a')], state: 'ok', asOf: NOW })
  await flush()
  assert.equal(store.get('bronos.gmail').refused, 0)
  store.dispose()
})

test('at most 1000 items per source: an item past the cap drops the oldest, counted in overCap', async () => {
  const many = Array.from({ length: CAPS.perSource + 3 }, (_, i) => item2(`i${i}`, { time: NOW - i * 1000 }))
  const mail = fakeFeedV2(V2_MAIL, many)
  const { ctx, store } = await setup({ 'bronos.gmail': mail })
  let s = store.get('bronos.gmail')
  assert.equal(s.items.length, CAPS.perSource)
  assert.equal(s.overCap, 3)
  ctx.emitFeed('bronos.gmail', 'item', item2('new', { time: NOW + 1000 }))
  await flush()
  s = store.get('bronos.gmail')
  assert.equal(s.items.length, CAPS.perSource)
  assert.equal(s.items[0].id, 'new')
  assert.equal(s.items.some((i) => i.id === `i${CAPS.perSource - 1}`), false, 'the oldest left')
  assert.equal(s.overCap, 4)
  store.dispose()
})

test('hostile events: prototype keys, wrong types and a non-string pluginId never break the store', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('a')])
  const { ctx, store } = await setup({ 'bronos.gmail': mail })
  const set = ctx.services.useAll('inbox-feed')
  const raw = JSON.parse('{"id":"__proto__","rev":"r","title":"t","time":5,"read":false,"actions":[],"__proto__":{"polluted":true}}')
  ctx.emitFeed('bronos.gmail', 'item', raw)
  ctx.emitFeed('bronos.gmail', 'item', null)
  ctx.emitFeed('bronos.gmail', 'gone', 'nope')
  ctx.emitFeed('bronos.gmail', 'sync', { items: 'no' })
  await flush()
  assert.equal({}.polluted, undefined)
  const s = store.get('bronos.gmail')
  assert.ok(s.items.some((i) => i.id === '__proto__'), 'an id is just a key in a Map')
  assert.equal(Object.hasOwn(s.items.find((i) => i.id === '__proto__'), 'polluted'), false)
  assert.equal(set.providers().length, 1)
  store.dispose()
})

test('handle() gives the provider handle for act; dispose unsubscribes', async () => {
  const mail = fakeFeedV2(V2_MAIL, [item2('a')])
  const { ctx, store, changes } = await setup({ 'bronos.gmail': mail })
  assert.deepEqual(await store.handle('bronos.gmail').act('a', 'open'), { ok: true })
  assert.equal(store.handle('bronos.other'), null)
  store.dispose()
  changes.length = 0
  ctx.emitFeed('bronos.gmail', 'item', item2('b'))
  await flush()
  assert.deepEqual(changes, [])
  assert.deepEqual(store.list(), [])
})

test('the v1 extras some sources still send (recent, canUnread, markUnread as a method) are dropped; markUnread as an action stays', async () => {
  // Gmail, Chat and Jira 0.5 keep their v1 provider beside v2 and may leave v1 fields on items. The
  // v2 contract (docs/design-v2.md "Stops") has none of them: marking unread is only the action.
  const actions = [{ id: 'open', label: 'Open' }, { id: 'markUnread', label: 'Mark unread' }]
  const mail = fakeFeedV2(V2_MAIL, [item2('t1', { read: true, actions, extra: { recent: true, canUnread: true, markUnread: 'x' } })])
  const { store } = await setup({ 'bronos.gmail': mail })
  const [it] = store.get('bronos.gmail').items
  for (const k of ['recent', 'canUnread', 'markUnread']) assert.equal(Object.hasOwn(it, k), false, k)
  assert.equal(it.read, true)
  assert.deepEqual(it.actions, actions)
  store.dispose()
})
