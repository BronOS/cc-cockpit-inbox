'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const J = require('../dist/lib/jev')
const R = require('../dist/lib/rules')
const S = require('../dist/lib/settings')
const { NOW, item2, fakeAppStorage, flush } = require('./fakes')

const it = (source, id, o = {}) => ({ ...item2(id, o), source })
const urgent = { id: 'r1', enabled: true, group: 'g', jev: { question: 'Is this urgent?', min: 0.8 } }

/** A fake clock: `set` queues timers, `advance(ms)` fires the due ones in time order. */
function fakeClock(start = NOW) {
  let t = start
  let seq = 0
  const timers = new Map()
  const clock = {
    now: () => t,
    timers: {
      set(fn, ms) {
        const id = ++seq
        timers.set(id, { fn, at: t + Math.max(0, ms) })
        return id
      },
      clear(id) {
        timers.delete(id)
      },
    },
    async advance(ms) {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = Math.max(t, due[1].at)
        due[1].fn()
        await flush()
      }
      t = end
      await flush()
    },
    armed: () => timers.size,
  }
  return clock
}

/**
 * A fake `jev` service: `grid` records each call and answers `score(text)` per item; `jev.fail`
 * (an Error) rejects the next calls; `jev.answer(items)` overrides the whole result (hostile shapes).
 */
function fakeJev(score = () => 0.9) {
  const jev = {
    calls: [],
    fail: null,
    present: true,
    answer: null,
    impl: {
      async grid(items, questions, options) {
        jev.calls.push({ items: structuredClone(items), questions: structuredClone(questions), options })
        if (jev.fail) throw jev.fail
        if (jev.answer) return jev.answer(items)
        const results = {}
        for (const i of items) results[i.id] = { answers: { q: { type: 'noul', noul: score(i.text) } } }
        return { results, stats: { items: items.length } }
      },
    },
  }
  jev.services = {
    available: (name) => name === 'jev' && jev.present,
    use(name) {
      if (name !== 'jev') throw new Error(`does not declare service "${name}"`)
      if (!jev.present) throw new Error('no plugin provides service "jev"')
      return jev.impl
    },
  }
  return jev
}

function setup(o = {}) {
  const clock = fakeClock()
  const jev = o.jev || fakeJev(o.score)
  const store = o.store || fakeAppStorage()
  const answered = []
  const j = J.createJev({ store, services: jev.services, now: clock.now, timers: clock.timers, onAnswer: (refs) => answered.push(refs) })
  return { clock, jev, store, answered, j }
}

// --- key, text ------------------------------------------------------------------------------

test('cacheKey: per question and item, inside the store key rule, not the threshold', () => {
  const k = J.cacheKey('Is this urgent?', 'bronos.chat', 'spaces/S1/messages/M1')
  assert.match(k, /^jv:[0-9a-f]{16}:[0-9a-f]{32}$/)
  assert.match(k, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  assert.equal(k, J.cacheKey('Is this urgent?', 'bronos.chat', 'spaces/S1/messages/M1'))
  assert.notEqual(k, J.cacheKey('Is this urgent? ', 'bronos.chat', 'spaces/S1/messages/M1'), 'edited question text asks again')
  assert.notEqual(k, J.cacheKey('Is this urgent?', 'bronos.gmail', 'spaces/S1/messages/M1'))
  // pluginId and id are separated: ("a.b", "c") and ("a", "b.c")-style collisions cannot happen.
  assert.notEqual(J.cacheKey('q', 'ab', 'c'), J.cacheKey('q', 'a', 'bc'))
})

test('textOf: title, newline, preview, cut to 1500 and never mid surrogate pair', () => {
  assert.equal(J.textOf({ title: 'Deploy failed', preview: 'see the log' }), 'Deploy failed\nsee the log')
  assert.equal(J.textOf({ title: 'Deploy failed' }), 'Deploy failed')
  assert.equal(J.textOf({ title: 'x'.repeat(2000) }).length, 1500)
  const cut = J.textOf({ title: 'x'.repeat(1499) + '\u{1F600}' })
  assert.equal(cut, 'x'.repeat(1499))
})

// --- asking, caching ------------------------------------------------------------------------

test('a miss is pending, one grid asks with the noul question, the answer is cached with its rev', async () => {
  const { clock, jev, store, answered, j } = setup({ score: () => 0.86 })
  const a = it('bronos.gmail', 'm1', { title: 'Deploy failed', preview: 'prod is down', rev: 'r1' })
  assert.equal(j.answer(urgent, a), 'pending')
  assert.equal(j.answer(urgent, a), 'pending', 'asked once while pending')
  await clock.advance(0)
  assert.equal(jev.calls.length, 1)
  assert.deepEqual(jev.calls[0].items, [{ id: '0', text: 'Deploy failed\nprod is down' }])
  assert.deepEqual(jev.calls[0].questions, { q: { type: 'noul', instructions: 'Is this urgent?' } })
  assert.deepEqual(answered, [[{ pluginId: 'bronos.gmail', id: 'm1' }]])
  assert.deepEqual(j.answer(urgent, a), { score: 0.86 })
  const stored = store.map.get(J.cacheKey('Is this urgent?', 'bronos.gmail', 'm1'))
  assert.deepEqual(stored, { rev: 'r1', score: 0.86, at: NOW, seen: NOW })
  // read and label changes keep the rev: no new request
  j.answer(urgent, { ...a, read: true, labels: ['Work'] })
  await clock.advance(5000)
  assert.equal(jev.calls.length, 1)
  // a threshold change uses the same answer
  assert.deepEqual(j.answer({ ...urgent, jev: { question: 'Is this urgent?', min: 0.5 } }, a), { score: 0.86 })
  // a new rev asks again
  assert.equal(j.answer(urgent, { ...a, rev: 'r2' }), 'pending')
  await clock.advance(0)
  assert.equal(jev.calls.length, 2)
  assert.equal(store.map.get(J.cacheKey('Is this urgent?', 'bronos.gmail', 'm1')).rev, 'r2')
})

test('another window reads the cache on load: no request', async () => {
  const shared = fakeAppStorage()
  const one = setup({ store: shared })
  const a = it('bronos.chat', 'c1')
  one.j.answer(urgent, a)
  await one.clock.advance(0)
  const two = setup({ store: shared })
  await two.j.load()
  assert.deepEqual(two.j.answer(urgent, a), { score: 0.9 })
  assert.equal(two.jev.calls.length, 0)
})

test('load drops hostile cache entries', async () => {
  const store = fakeAppStorage()
  const a = it('bronos.chat', 'c1')
  await store.set(J.cacheKey('Is this urgent?', 'bronos.chat', 'c1'), { rev: a.rev, score: 'high', at: NOW })
  await store.set(J.cacheKey('Is this urgent?', 'bronos.chat', 'c2'), { rev: 'c2-r1', score: 3, at: NOW })
  await store.set('st:other', { kind: 'done' })
  const { j } = setup({ store })
  assert.equal(await j.load(), 0)
  assert.equal(j.answer(urgent, a), 'pending')
})

// --- batching -------------------------------------------------------------------------------

test('batching: 100 items a call, one call per question in flight, every 2 s at most', async () => {
  const { clock, jev, j } = setup()
  for (let i = 0; i < 250; i++) j.answer(urgent, it('bronos.gmail', `m${i}`))
  await clock.advance(0)
  assert.deepEqual(
    jev.calls.map((c) => c.items.length),
    [100]
  )
  await clock.advance(1999)
  assert.equal(jev.calls.length, 1, 'not before 2 s')
  await clock.advance(1)
  assert.deepEqual(
    jev.calls.map((c) => c.items.length),
    [100, 100]
  )
  await clock.advance(2000)
  assert.deepEqual(
    jev.calls.map((c) => c.items.length),
    [100, 100, 50]
  )
  assert.equal(j.pending(), 0)
  // each question has its own lane
  const other = { ...urgent, id: 'r2', jev: { question: 'Is it about money?', min: 0.5 } }
  j.answer(urgent, it('bronos.gmail', 'x1'))
  j.answer(other, it('bronos.gmail', 'x1'))
  await clock.advance(2000)
  assert.equal(jev.calls.length, 5)
  assert.deepEqual(new Set(jev.calls.slice(3).map((c) => c.questions.q.instructions)), new Set(['Is this urgent?', 'Is it about money?']))
})

test('a call in flight is never doubled: a slow grid holds the next batch', async () => {
  const jev = fakeJev()
  let release
  const slow = jev.impl.grid
  jev.impl.grid = async (...args) => {
    await new Promise((r) => (release = r))
    return slow(...args)
  }
  const { clock, j } = setup({ jev })
  j.answer(urgent, it('bronos.gmail', 'm1'))
  await clock.advance(0)
  j.answer(urgent, it('bronos.gmail', 'm2'))
  await clock.advance(5000)
  assert.equal(jev.calls.length, 0, 'first still waiting')
  release()
  await clock.advance(0)
  assert.equal(jev.calls.length, 1)
  await clock.advance(0)
  release()
  await clock.advance(0)
  assert.equal(jev.calls.length, 2, 'the second batch went once the first settled (its 2 s had passed)')
})

test('only items that reach the rule are asked (pre-filter, earlier rule)', async () => {
  const settings = S.readSettings({
    version: 2,
    groups: [
      { id: 'now', name: 'Now' },
      { id: 'mail', name: 'Mail' },
    ],
    rules: [
      { id: 'r1', enabled: true, group: 'mail', when: [{ field: 'title', op: 'contains', value: 'newsletter' }] },
      { id: 'r2', enabled: true, group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }], jev: { question: 'Is this urgent?', min: 0.8 } },
    ],
    agenda: 'top',
  })
  const { clock, jev, j } = setup()
  const kindOf = (p) => ({ 'bronos.gmail': 'mail', 'bronos.chat': 'chat' })[p]
  const items = [it('bronos.gmail', 'news', { title: 'Weekly newsletter' }), it('bronos.chat', 'c1'), it('bronos.gmail', 'm1', { title: 'Prod down' })]
  R.placeAll(settings, items, { now: NOW, kindOf, jevAnswer: j.answer })
  await clock.advance(0)
  assert.equal(jev.calls.length, 1)
  assert.deepEqual(
    jev.calls[0].items.map((i) => i.text),
    ['Prod down']
  )
})

// --- pending then one move ------------------------------------------------------------------

test('pending: the rule does not hold ("Jev…"), the answer moves the item once', async () => {
  const settings = S.readSettings({
    version: 2,
    groups: [{ id: 'now', name: 'Now' }],
    rules: [{ id: 'r1', enabled: true, group: 'now', jev: { question: 'Is this urgent?', min: 0.8 } }],
    agenda: 'top',
  })
  const { clock, jev, answered, j } = setup({ score: () => 0.93 })
  const a = it('bronos.gmail', 'm1')
  const p1 = R.placeItem(settings, a, { now: NOW, jevAnswer: j.answer })
  assert.equal(p1.group, 'rest')
  assert.equal(p1.jev, 'pending')
  assert.match(p1.reason, /rule 1: Jev…/)
  await clock.advance(0)
  assert.equal(answered.length, 1)
  const p2 = R.placeItem(settings, a, { now: NOW, jevAnswer: j.answer })
  assert.equal(p2.group, 'now')
  assert.equal(p2.reason, 'rule 1: Jev 0.93')
  // stays: later passes neither ask nor move it
  for (let i = 0; i < 3; i++) assert.equal(R.placeItem(settings, a, { now: NOW, jevAnswer: j.answer }).group, 'now')
  await clock.advance(10000)
  assert.equal(jev.calls.length, 1)
  assert.equal(answered.length, 1)
})

// --- unavailable ----------------------------------------------------------------------------

test('no provider: unavailable at once, no request, nothing cached', async () => {
  const jev = fakeJev()
  jev.present = false
  const { clock, store, j } = setup({ jev })
  assert.equal(j.answer(urgent, it('bronos.gmail', 'm1')), 'unavailable')
  await clock.advance(60000)
  assert.equal(jev.calls.length, 0)
  assert.equal([...store.map.keys()].filter((k) => k.startsWith('jv:')).length, 0)
  const settings = S.readSettings({ version: 2, groups: [{ id: 'now', name: 'Now' }], rules: [{ ...urgent, group: 'now' }], agenda: 'top' })
  assert.equal(R.placeItem(settings, it('bronos.gmail', 'm1'), { now: NOW, jevAnswer: j.answer }).reason, 'no rule · rule 1 skipped: Jev unavailable')
})

test('an error (a cap reached): unavailable, nothing cached, asked again after 10 minutes', async () => {
  const { clock, jev, store, answered, j } = setup()
  jev.fail = new Error('jev: monthly cap reached')
  const a = it('bronos.gmail', 'm1')
  assert.equal(j.answer(urgent, a), 'pending')
  await clock.advance(0)
  assert.equal(jev.calls.length, 1)
  assert.deepEqual(answered, [[{ pluginId: 'bronos.gmail', id: 'm1' }]], 'the host re-places it (reason changes)')
  assert.equal(j.answer(urgent, a), 'unavailable')
  assert.equal([...store.map.keys()].filter((k) => k.startsWith('jv:')).length, 0)
  await clock.advance(J.RETRY_MS - 1)
  assert.equal(j.answer(urgent, a), 'unavailable')
  assert.equal(jev.calls.length, 1, 'no retry inside 10 minutes')
  jev.fail = null
  await clock.advance(1)
  assert.equal(j.answer(urgent, a), 'pending', 'asked again')
  await clock.advance(0)
  assert.equal(jev.calls.length, 2)
  assert.deepEqual(j.answer(urgent, a), { score: 0.9 })
})

test('hostile answers (missing, non-number, out of range, error entry) are unavailable, never cached', async () => {
  const { clock, jev, store, j } = setup()
  const shapes = [
    (items) => ({ results: { [items[0].id]: { answers: { q: { type: 'noul', noul: 'high' } } } } }),
    (items) => ({ results: { [items[0].id]: { answers: { q: { type: 'noul', noul: 1.5 } } } } }),
    (items) => ({ results: { [items[0].id]: { answers: { q: { type: 'noul', noul: NaN } } } } }),
    (items) => ({ results: { [items[0].id]: { error: 'jev: timeout' } } }),
    () => ({ results: {} }),
    () => null,
    () => 'yes',
    (items) => ({ results: { [items[0].id]: { answers: {} } } }),
  ]
  for (const [n, shape] of shapes.entries()) {
    jev.answer = shape
    const a = it('bronos.gmail', `m${n}`)
    assert.equal(j.answer(urgent, a), 'pending')
    await clock.advance(2000)
    assert.equal(j.answer(urgent, a), 'unavailable', `shape ${n}`)
  }
  assert.equal(jev.calls.length, shapes.length)
  assert.equal([...store.map.keys()].filter((k) => k.startsWith('jv:')).length, 0)
})

test('one bad entry in a batch does not spoil the others', async () => {
  const { clock, jev, j } = setup()
  jev.answer = (items) => ({ results: { 0: { answers: { q: { noul: 0.2 } } }, 1: { error: 'jev: HTTP 500' } } })
  const a = it('bronos.gmail', 'm1')
  const b = it('bronos.gmail', 'm2')
  j.answer(urgent, a)
  j.answer(urgent, b)
  await clock.advance(0)
  assert.deepEqual(j.answer(urgent, a), { score: 0.2 })
  assert.equal(j.answer(urgent, b), 'unavailable')
})

// --- test mode, prune, dispose --------------------------------------------------------------

test('cachedAnswer (settings "Test"): cached answers only, never a request', async () => {
  const { clock, jev, j } = setup()
  const a = it('bronos.gmail', 'm1')
  const b = it('bronos.gmail', 'm2')
  j.answer(urgent, a)
  await clock.advance(0)
  assert.equal(jev.calls.length, 1)
  assert.deepEqual(j.cachedAnswer(urgent, a), { score: 0.9 })
  assert.equal(j.cachedAnswer(urgent, b), 'pending')
  assert.equal(j.cachedAnswer(urgent, { ...a, rev: 'r9' }), 'pending', 'an older rev is not this item')
  await clock.advance(60000)
  assert.equal(jev.calls.length, 1, 'Test asked nothing')
  assert.equal(j.pending(), 0)
  jev.present = false
  assert.equal(j.cachedAnswer(urgent, b), 'unavailable')
})

test('prune: answers not used for 14 days go, used ones stay (seen bumped once a day)', async () => {
  const { clock, store, j } = setup()
  const a = it('bronos.gmail', 'm1')
  const b = it('bronos.gmail', 'm2')
  j.answer(urgent, a)
  j.answer(urgent, b)
  await clock.advance(0)
  await clock.advance(10 * 24 * 3600000)
  j.answer(urgent, a) // still listed: its seen moves on
  await flush()
  assert.equal(store.map.get(J.cacheKey('Is this urgent?', 'bronos.gmail', 'm1')).seen, clock.now())
  await clock.advance(5 * 24 * 3600000)
  await j.prune()
  assert.ok(store.map.has(J.cacheKey('Is this urgent?', 'bronos.gmail', 'm1')))
  assert.ok(!store.map.has(J.cacheKey('Is this urgent?', 'bronos.gmail', 'm2')))
})

test('dispose stops the timers and drops late answers', async () => {
  const { clock, jev, answered, j } = setup()
  j.answer(urgent, it('bronos.gmail', 'm1'))
  assert.equal(clock.armed(), 1)
  j.dispose()
  assert.equal(clock.armed(), 0)
  await clock.advance(5000)
  assert.equal(jev.calls.length, 0)
  assert.equal(answered.length, 0)
})

test('a rule without a question is unavailable', () => {
  const { j } = setup()
  assert.equal(j.answer({ id: 'x', jev: { question: '' } }, it('bronos.gmail', 'm1')), 'unavailable')
  assert.equal(j.answer({ id: 'x' }, it('bronos.gmail', 'm1')), 'unavailable')
})

// --- deadlines, retries, parking, sweep -----------------------------------------------------

test('a grid that never settles times out: unavailable, the lane is free again, pending() drains', async () => {
  const jev = fakeJev()
  const real = jev.impl.grid
  let hang = true
  jev.impl.grid = (...args) => (hang ? (jev.calls.push({ hung: true }), new Promise(() => {})) : real(...args))
  const { clock, answered, j } = setup({ jev })
  const a = it('bronos.gmail', 'm1')
  assert.equal(j.answer(urgent, a), 'pending')
  await clock.advance(0)
  assert.equal(jev.calls.length, 1)
  j.answer(urgent, it('bronos.gmail', 'm2'))
  await clock.advance(J.CALL_TIMEOUT_MS - 1)
  assert.equal(j.pending(), 2, 'm1 in flight, m2 waits behind it')
  assert.equal(answered.length, 0)
  hang = false
  await clock.advance(1)
  assert.deepEqual(answered[0], [{ pluginId: 'bronos.gmail', id: 'm1' }], 'the timeout counts as a failure')
  assert.equal(j.answer(urgent, a), 'unavailable', 'blocked 10 minutes like any failure')
  await clock.advance(0)
  assert.equal(jev.calls.length, 2, 'the next batch of the question went')
  assert.deepEqual(j.answer(urgent, it('bronos.gmail', 'm2')), { score: 0.9 })
  assert.equal(j.pending(), 0)
})

test('a failure tells the host again when the 10 minutes are up, so the item is asked anew', async () => {
  const { clock, jev, answered, j } = setup()
  jev.fail = new Error('jev: monthly cap reached')
  const a = it('bronos.gmail', 'm1')
  j.answer(urgent, a)
  await clock.advance(0)
  assert.equal(answered.length, 1)
  jev.fail = null
  await clock.advance(J.RETRY_MS - 1)
  assert.equal(answered.length, 1)
  await clock.advance(1)
  assert.deepEqual(answered[1], [{ pluginId: 'bronos.gmail', id: 'm1' }])
  // the host places the item again on that call
  assert.equal(j.answer(urgent, a), 'pending')
  await clock.advance(0)
  assert.deepEqual(j.answer(urgent, a), { score: 0.9 })
  await clock.advance(J.RETRY_MS)
  assert.equal(answered.length, 3, 'an answered item gets no more retry calls')
})

test('a provider that appears later: the parked items reach onAnswer within a minute', async () => {
  const jev = fakeJev()
  jev.present = false
  const { clock, answered, j } = setup({ jev })
  const a = it('bronos.gmail', 'm1')
  assert.equal(j.answer(urgent, a), 'unavailable')
  assert.equal(j.answer({ ...urgent, jev: { question: 'Other?', min: 0.5 } }, a), 'unavailable')
  await clock.advance(J.PARK_CHECK_MS * 3)
  assert.equal(answered.length, 0, 'still no provider: nothing to tell')
  assert.equal(jev.calls.length, 0)
  jev.present = true
  await clock.advance(J.PARK_CHECK_MS)
  assert.deepEqual(answered, [[{ pluginId: 'bronos.gmail', id: 'm1' }]], 'once per item')
  assert.equal(j.answer(urgent, a), 'pending')
  await clock.advance(0)
  assert.deepEqual(j.answer(urgent, a), { score: 0.9 })
  assert.equal(clock.armed(), 0, 'no check left running')
})

test('sweep: queued requests of items gone or of an edited question are never asked', async () => {
  const jev = fakeJev()
  let release
  const slow = jev.impl.grid
  jev.impl.grid = async (...args) => {
    await new Promise((r) => (release = r))
    return slow(...args)
  }
  const { clock, j } = setup({ jev })
  const old = { ...urgent, jev: { question: 'Is this urgent now?', min: 0.8 } }
  j.answer(urgent, it('bronos.gmail', 'first'))
  await clock.advance(0) // 'first' in flight, holding the lane
  j.sweep(() => {
    for (const id of ['a', 'b', 'c']) j.answer(urgent, it('bronos.gmail', id))
    j.answer(old, it('bronos.gmail', 'a'))
  })
  assert.equal(j.pending(), 5)
  // the next full placement: 'b' left the feed, the question 'old' was edited away
  const out = j.sweep(() => {
    j.answer(urgent, it('bronos.gmail', 'first'))
    j.answer(urgent, it('bronos.gmail', 'a'))
    j.answer(urgent, it('bronos.gmail', 'c'))
    return 'placed'
  })
  assert.equal(out, 'placed')
  assert.equal(j.pending(), 3, 'first in flight, a and c queued')
  release()
  await clock.advance(0)
  await clock.advance(2000)
  release()
  await clock.advance(0)
  const asked = jev.calls.map((c) => [c.questions.q.instructions, c.items.length])
  assert.deepEqual(asked, [
    ['Is this urgent?', 1],
    ['Is this urgent?', 2],
  ])
  assert.equal(j.pending(), 0)
  // a throw in the placement drops nothing
  j.answer(urgent, it('bronos.gmail', 'z'))
  assert.throws(() =>
    j.sweep(() => {
      throw new Error('boom')
    })
  )
  assert.equal(j.pending(), 1)
})

test('sweep also forgets parked items that left the feed', async () => {
  const jev = fakeJev()
  jev.present = false
  const { clock, answered, j } = setup({ jev })
  j.answer(urgent, it('bronos.gmail', 'gone'))
  j.answer(urgent, it('bronos.gmail', 'kept'))
  j.sweep(() => j.answer(urgent, it('bronos.gmail', 'kept')))
  jev.present = true
  await clock.advance(J.PARK_CHECK_MS)
  assert.deepEqual(answered, [[{ pluginId: 'bronos.gmail', id: 'kept' }]])
})

test('a full queue parks the item instead of growing', async () => {
  const jev = fakeJev()
  jev.impl.grid = () => new Promise(() => {}) // the lane stays busy: nothing leaves the queue
  const { clock, answered, j } = setup({ jev })
  j.answer(urgent, it('bronos.gmail', 'busy'))
  await clock.advance(0)
  for (let i = 0; i < J.QUEUE_MAX; i++) assert.equal(j.answer(urgent, it('bronos.gmail', `m${i}`)), 'pending')
  assert.equal(j.answer(urgent, it('bronos.gmail', 'over')), 'unavailable')
  assert.equal(j.answer(urgent, it('bronos.gmail', 'm0', { rev: 'm0-r2' })), 'pending', 'a queued item may still change rev')
  assert.equal(j.pending(), J.QUEUE_MAX + 1)
  await clock.advance(J.PARK_CHECK_MS)
  assert.ok(answered.some((refs) => refs.some((r) => r.id === 'over')), 'told again later')
  j.dispose()
})

test('the seen bump never writes an old rev over a newer one from another window', async () => {
  const shared = fakeAppStorage()
  const one = setup({ store: shared })
  const a = it('bronos.gmail', 'm1', { rev: 'r1' })
  one.j.answer(urgent, a)
  await one.clock.advance(0)
  await one.clock.advance(2 * 24 * 3600000)
  const key = J.cacheKey('Is this urgent?', 'bronos.gmail', 'm1')
  // another window answered the item's next rev meanwhile
  await shared.set(key, { rev: 'r2', score: 0.2, at: one.clock.now(), seen: one.clock.now() })
  assert.deepEqual(one.j.answer(urgent, a), { score: 0.9 }, 'this window still lists r1')
  await flush()
  assert.equal(shared.map.get(key).rev, 'r2', 'not overwritten')
  assert.deepEqual(one.j.answer(urgent, { ...a, rev: 'r2' }), { score: 0.2 }, 'and this window takes it up')
  assert.equal(one.jev.calls.length, 1)
})

test('the cache writes of one batch run in parallel, onAnswer after all of them', async () => {
  const store = fakeAppStorage()
  const realSet = store.set
  let started = 0
  const gates = []
  store.set = (k, v) => {
    started++
    return new Promise((r) => gates.push(r)).then(() => realSet(k, v))
  }
  const { clock, answered, j } = setup({ store })
  for (let i = 0; i < 5; i++) j.answer(urgent, it('bronos.gmail', `m${i}`))
  await clock.advance(0)
  assert.equal(started, 5, 'all five writes started before any finished')
  assert.equal(answered.length, 0)
  for (const g of gates) g()
  await flush()
  assert.equal(answered.length, 1)
  assert.equal(answered[0].length, 5)
})

test('forget: an item gone between full placements is not asked, the rest of its lane still is', async () => {
  const jev = fakeJev()
  let release
  const slow = jev.impl.grid
  jev.impl.grid = async (...args) => {
    await new Promise((r) => (release = r))
    return slow(...args)
  }
  const { clock, j } = setup({ jev })
  j.answer(urgent, it('bronos.gmail', 'first'))
  await clock.advance(0) // 'first' in flight, holding the lane
  j.answer(urgent, it('bronos.gmail', 'a'))
  j.answer(urgent, it('bronos.gmail', 'b'))
  j.answer(urgent, it('bronos.chat', 'a'))
  assert.equal(j.pending(), 4)
  j.forget('bronos.gmail', 'a')
  j.forget('bronos.gmail', 'first') // in flight: finishes
  assert.equal(j.pending(), 3)
  release()
  await clock.advance(0)
  await clock.advance(2000)
  release()
  await clock.advance(0)
  assert.deepEqual(jev.calls.map((c) => c.items.length), [1, 2])
  assert.equal(j.pending(), 0)
})
