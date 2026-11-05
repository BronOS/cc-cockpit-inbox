'use strict'
// Times in these tests are Berlin wall time (TZ set before any Date use), so "tomorrow 9:00" can be
// checked across the end of daylight saving time (25 Oct 2026, 03:00 CEST -> 02:00 CET).
process.env.TZ = 'Europe/Berlin'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createState, storageKey, untilOf, KEEP_MS } = require('../dist/lib/state')
const { rankKey } = require('../dist/lib/state')
const { fakeAppStorage } = require('./fakes')

const NOW = Date.parse('2026-11-03T12:42:00+01:00')
const MIN = 60000
const HOUR = 60 * MIN
const row = (id, rev = 'r1', pluginId = 'bronos.mail') => ({ pluginId, id, rev, title: `T ${id}`, badge: 'MAIL' })
const look = (st, now, r, bonus = 500) => {
  const v = st.view(now, bonus)
  const k = rankKey(r.pluginId, r.id)
  return { hidden: v.hidden(k, r), extra: v.extra(k, r), back: v.back(k, r) }
}

test('storage keys fit the store rule; ids that do not are hashed', () => {
  assert.equal(storageKey('bronos.mail', 'abc123'), 'st:bronos.mail:abc123')
  const hashed = storageKey('bronos.chat', 'spaces/AAA/messages/BBB.CCC')
  assert.match(hashed, /^st:h[0-9a-f]{40}$/)
  assert.notEqual(hashed, storageKey('bronos.chat', 'spaces/AAA/messages/BBB.CCD'))
  assert.match(storageKey('p', 'x'.repeat(150)), /^st:h/)
})

test('done hides while the rev is the same; a new rev brings it back marked', async () => {
  const st = createState(fakeAppStorage())
  await st.done(row('a'), NOW)
  assert.deepEqual(look(st, NOW, row('a')), { hidden: true, extra: 0, back: false })
  assert.deepEqual(look(st, NOW, row('a', 'r2')), { hidden: false, extra: 0, back: true })
  // The setting off: done stays done.
  assert.equal(st.view(NOW, 500, { doneReturns: false }).hidden(rankKey('bronos.mail', 'a'), row('a', 'r2')), true)
})

test('snooze until a time: hidden before, back with the bonus after, for the rest of that day only', async () => {
  const st = createState(fakeAppStorage())
  await st.snooze(row('a'), NOW + HOUR, NOW)
  assert.equal(look(st, NOW + 59 * MIN, row('a')).hidden, true)
  assert.deepEqual(look(st, NOW + HOUR, row('a')), { hidden: false, extra: 500, back: false })
  assert.deepEqual(look(st, NOW + 12 * HOUR, row('a')), { hidden: false, extra: 0, back: false })
})

test('snooze until it changes; a new reply also wakes a timed snooze early', async () => {
  const st = createState(fakeAppStorage())
  await st.snooze(row('a'), null, NOW)
  await st.snooze(row('b'), NOW + 5 * HOUR, NOW)
  assert.equal(look(st, NOW + 48 * HOUR, row('a')).hidden, true)
  assert.deepEqual(look(st, NOW + MIN, row('a', 'r2')), { hidden: false, extra: 500, back: true })
  assert.equal(look(st, NOW + MIN, row('b', 'r2')).hidden, false)
})

test('undo puts back what was there; restore deletes', async () => {
  const store = fakeAppStorage()
  const st = createState(store)
  const t1 = await st.snooze(row('a'), NOW + HOUR, NOW)
  const t2 = await st.done(row('a'), NOW)
  await st.undo(t2)
  assert.equal(st.entries().get(rankKey('bronos.mail', 'a')).kind, 'snooze')
  await st.undo(t1)
  assert.equal(st.entries().size, 0)
  assert.equal(store.map.size, 0)
  await st.done(row('b'), NOW)
  await st.restore('bronos.mail', 'b')
  assert.equal(look(st, NOW, row('b')).hidden, false)
})

test('two windows: different items never collide, each sees the other after a load', async () => {
  const store = fakeAppStorage()
  const w1 = createState(store)
  const w2 = createState(store)
  await w1.load()
  await w2.load()
  await Promise.all([w1.done(row('a'), NOW), w2.snooze(row('b'), null, NOW)])
  await w1.load()
  await w2.load()
  for (const w of [w1, w2]) {
    assert.equal(look(w, NOW, row('a')).hidden, true)
    assert.equal(look(w, NOW, row('b')).hidden, true)
  }
})

test('a key that needs hashing round-trips through load', async () => {
  const store = fakeAppStorage()
  const r = row('spaces/A/messages/B', 'r1', 'bronos.chat')
  await createState(store).done(r, NOW)
  const fresh = createState(store)
  await fresh.load()
  assert.equal(look(fresh, NOW, r).hidden, true)
})

test('junk in the store is ignored; entries unseen for 14 days are pruned; touch bumps once a day', async () => {
  const store = fakeAppStorage()
  await store.set('st:junk', { nope: 1 })
  await store.set('other', 1)
  const st = createState(store)
  await st.done(row('old'), NOW - KEEP_MS - HOUR)
  await st.done(row('kept'), NOW - KEEP_MS - HOUR)
  await st.load()
  assert.equal(st.entries().size, 2)
  await st.touch([{ pluginId: 'bronos.mail', id: 'kept' }], NOW)
  await st.prune(NOW)
  assert.deepEqual([...st.entries().values()].map((e) => e.id), ['kept'])
  assert.equal(store.map.has('other'), true)
})

test('woken snoozes are announced once', async () => {
  const st = createState(fakeAppStorage())
  await st.snooze(row('a'), NOW + HOUR, NOW)
  assert.equal(st.woken(NOW).length, 0)
  const [e] = st.woken(NOW + HOUR)
  assert.equal(e.id, 'a')
  await st.markNotified(e)
  assert.equal(st.woken(NOW + 2 * HOUR).length, 0)
})

test("today's list: done today and snoozes still waiting, newest first", async () => {
  const st = createState(fakeAppStorage())
  await st.done(row('yesterday'), NOW - 24 * HOUR)
  await st.done(row('a'), NOW - HOUR)
  await st.snooze(row('b'), NOW + 5 * HOUR, NOW - 30 * HOUR)
  await st.snooze(row('c'), null, NOW)
  assert.deepEqual(st.today(NOW).map((e) => e.id), ['c', 'a', 'b'])
})

test('snooze times: 1 h, afternoon (today or tomorrow), tomorrow morning across the DST change', () => {
  assert.equal(untilOf('1h', NOW), NOW + HOUR)
  assert.equal(untilOf('afternoon', Date.parse('2026-11-03T10:00:00+01:00')), Date.parse('2026-11-03T14:00:00+01:00'))
  assert.equal(untilOf('afternoon', NOW), Date.parse('2026-11-03T14:00:00+01:00'))
  assert.equal(untilOf('afternoon', Date.parse('2026-11-03T15:00:00+01:00')), Date.parse('2026-11-04T14:00:00+01:00'))
  assert.equal(untilOf('tomorrow', NOW), Date.parse('2026-11-04T09:00:00+01:00'))
  // Sat 24 Oct 2026 22:00 CEST: tomorrow 9:00 is Sun 25 Oct 09:00 CET (a 25-hour day in between).
  assert.equal(untilOf('tomorrow', Date.parse('2026-10-24T22:00:00+02:00')), Date.parse('2026-10-25T09:00:00+01:00'))
  assert.equal(untilOf('tomorrow', NOW, { afternoon: '15:00', morning: '08:00' }), Date.parse('2026-11-04T08:00:00+01:00'))
  assert.equal(untilOf('changes', NOW), null)
  assert.throws(() => untilOf('never', NOW), /unknown snooze/)
})

// --- v2 ---
const v2 = (id, rev = 'r1', source = 'bronos.mail', title = `T ${id}`) => ({ source, id, rev, title })

test('v2 status: done returns on a new rev only, a read or label change does not', async () => {
  const st = createState(fakeAppStorage())
  await st.done(row('a'), NOW)
  assert.deepEqual(st.status(v2('a'), NOW), { hidden: true, back: false })
  assert.deepEqual(st.status({ ...v2('a'), read: true, labels: ['x'] }, NOW), { hidden: true, back: false })
  assert.deepEqual(st.status(v2('a', 'r2'), NOW), { hidden: false, back: true })
  assert.deepEqual(st.status(v2('a', 'r2'), NOW, { doneReturns: false }), { hidden: true, back: false })
  assert.deepEqual(st.status(v2('other'), NOW), { hidden: false, back: false })
})

test('v2 status: a woken snooze is placed by the rules, marked back', async () => {
  const st = createState(fakeAppStorage())
  await st.snooze(row('a'), NOW + HOUR, NOW)
  assert.deepEqual(st.status(v2('a'), NOW + MIN), { hidden: true, back: false })
  assert.deepEqual(st.status(v2('a'), NOW + HOUR), { hidden: false, back: true })
})

test('v2 entry shape and v1 entries carried over', async () => {
  const store = fakeAppStorage()
  // A v1 entry as the 0.1.0 host wrote it (same key form, extra fields ignored).
  await store.set('st:bronos.mail:old', { pluginId: 'bronos.mail', id: 'old', title: 'Old', badge: 'MAIL', kind: 'done', rev: 'r1', at: NOW, seen: NOW })
  const st = createState(store)
  await st.done(row('new'), NOW + 1)
  await st.load()
  assert.equal(st.status(v2('old', 'r1'), NOW).hidden, true)
  assert.equal(st.status(v2('old', 'r2'), NOW).back, true)
  const e = await store.get('st:bronos.mail:new')
  assert.deepEqual([e.kind, e.rev, e.at, e.title, e.pluginId, e.id], ['done', 'r1', NOW + 1, 'T new', 'bronos.mail', 'new'])
})

test('undoLastDone takes back only the last Done; none left returns false', async () => {
  const st = createState(fakeAppStorage())
  assert.equal(await st.undoLastDone(), false)
  await st.done(row('a'), NOW)
  await st.done(row('b'), NOW + 1)
  assert.equal(await st.undoLastDone(), true)
  assert.equal(st.status(v2('b'), NOW).hidden, false)
  assert.equal(st.status(v2('a'), NOW).hidden, true)
  assert.equal(await st.undoLastDone(), false)
})

test('Done view: newest first, live title else stored, snoozes left out, Back to Inbox restores', async () => {
  const st = createState(fakeAppStorage())
  await st.done(row('a'), NOW - 2 * HOUR)
  await st.done(row('b'), NOW - HOUR)
  await st.snooze(row('s'), null, NOW)
  const live = new Map([[rankKey('bronos.mail', 'a'), v2('a', 'r1', 'bronos.mail', 'Live A')]])
  assert.deepEqual(st.doneList(live).map((d) => [d.id, d.title, d.live]), [['b', 'T b', false], ['a', 'Live A', true]])
  await st.restore('bronos.mail', 'b')
  assert.deepEqual(st.doneList(live).map((d) => d.id), ['a'])
})

test('a gone item keeps its Done entry until pruned; it stays done on return with the same rev', async () => {
  const st = createState(fakeAppStorage())
  await st.done(row('a'), NOW)
  await st.prune(NOW + 13 * 24 * HOUR)
  assert.equal(st.status(v2('a'), NOW).hidden, true)
  await st.prune(NOW + 15 * 24 * HOUR)
  assert.equal(st.status(v2('a'), NOW).hidden, false)
})
