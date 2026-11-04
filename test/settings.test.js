'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../dist/lib/settings')
const { fakeAppStorage } = require('./fakes')

test('defaults: the design values', () => {
  const s = S.readSettings(undefined)
  assert.deepEqual(s.levels, { urgent: 300, action: 150, fyi: 50 })
  assert.equal(s.badge, 'urgent')
  assert.deepEqual(s.calendar, { position: 'top', upcoming: 3, pinMinutes: 30, timeline: 'auto' })
  assert.equal(s.afternoon, '14:00')
  assert.equal(s.morning, '09:00')
  assert.deepEqual(s.sources, {})
  assert.deepEqual(S.sourceOf(s, 'bronos.chat', 'chat'), { on: true, items: 10, weight: 30, weightSet: false })
  assert.deepEqual(S.sourceOf(s, 'bronos.jira', 'issues'), { on: true, items: 8, weight: 0, weightSet: false })
  assert.deepEqual(S.sourceOf(s, 'x.y', 'weird'), { on: true, items: 10, weight: 0, weightSet: false })
})

test('bad values are replaced by defaults; unknown keys and hostile ids dropped', () => {
  const s = S.readSettings({
    levels: { urgent: 'lots', action: 1e9, fyi: 7 },
    unread: 1.5,
    badge: 'everything',
    afternoon: '14:30',
    calendar: { position: 'left', upcoming: 99, pinMinutes: 10 },
    sources: JSON.parse('{"__proto__": {"on": false}, "bronos.mail": {"on": "no", "items": 0, "weight": 40}, "bad id!": {}}'),
    extra: 1,
  })
  assert.deepEqual(s.levels, { urgent: 300, action: 150, fyi: 7 })
  assert.equal(s.unread, 10)
  assert.equal(s.badge, 'urgent')
  assert.equal(s.afternoon, '14:00')
  assert.deepEqual(s.calendar, { position: 'top', upcoming: 3, pinMinutes: 10, timeline: 'auto' })
  assert.deepEqual(Object.keys(s.sources), ['bronos.mail'])
  assert.deepEqual(s.sources['bronos.mail'], { on: true, weight: 40 })
  assert.equal(Object.hasOwn(s, 'extra'), false)
  assert.equal(({}).on, undefined)
  for (const junk of [null, 'x', 3, []]) assert.deepEqual(S.readSettings(junk), S.readSettings(undefined))
})

test("a removed provider's settings are kept; rules carry only set weights", async () => {
  const store = fakeAppStorage()
  await S.saveSettings(store, { sources: { 'bronos.chat': { on: false, items: 4 }, 'bronos.mail': { weight: 60 } } })
  const s = await S.loadSettings(store)
  // No provider is consulted here: a row for a plugin that is not installed stays as it was.
  assert.deepEqual(s.sources['bronos.chat'], { on: false, items: 4 })
  assert.deepEqual(S.rulesOf(s).weights, { 'bronos.mail': 60 })
  assert.equal(S.sourceOf(s, 'bronos.mail', 'mail').weight, 60)
  assert.equal(S.sourceOf(s, 'bronos.mail', 'mail').weightSet, true)
})

test('readItems: 20 by default, 1 to 50', () => {
  assert.equal(S.readSettings(undefined).readItems, 20)
  assert.equal(S.readSettings({ readItems: 35 }).readItems, 35)
  for (const bad of [0, 51, 2.5, '30']) assert.equal(S.readSettings({ readItems: bad }).readItems, 20)
})
