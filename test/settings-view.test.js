'use strict'
// The v1 settings view's form logic (panels/settingslogic.js), until the panel v2 replaces it. The
// stored settings are written out here as Inbox 0.1.0 stored them: the v1 reader (lib/v1.js) is gone
// with the v1 host, and the v2 host never saves this form's output (its settings are lib/settings.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const L = require('../panels/settingslogic')

const providers = [
  { pluginId: 'bronos.chat', label: 'Chat', color: 'green', kind: 'chat', markRead: true, on: true, items: 10, weight: 30, weightSet: false },
  { pluginId: 'bronos.jira', label: 'Jira', color: 'blue', kind: 'issues', markRead: false, on: true, items: 5, weight: 12, weightSet: true },
]
const stored = {
  sources: { 'bronos.jira': { on: true, items: 5, weight: 12 }, 'bronos.gone': { on: false, items: 4, weight: 7 } },
  levels: { urgent: 300, action: 150, fyi: 50 },
  unread: 10,
  direct: 20,
  due: 25,
  agePerHour: 5,
  ageCap: 99,
  readItems: 20,
  dedupeJira: true,
  doneReturns: true,
  notifySnooze: true,
  afternoon: '14:00',
  morning: '09:00',
  badge: 'urgent',
  calendar: { position: 'top', upcoming: 3, pinMinutes: 30, timeline: 'auto' },
}
const formOf = (over = {}) => ({
  sources: { 'bronos.chat': { on: true, items: '10', weight: '30' }, 'bronos.jira': { on: true, items: '5', weight: '12' } },
  levels: { urgent: '300', action: '150', fyi: '50' }, unread: '10', direct: '20', due: '25', agePerHour: '5',
  dedupeJira: true, doneReturns: true, notifySnooze: true, afternoon: '14:00', morning: '09:00', badge: 'urgent',
  calendar: { position: 'top', upcoming: '3', pinMinutes: '30', timeline: 'auto' }, ...over,
})

test('form model: live providers, then a provider that left, greyed', () => {
  const rows = L.sourceRows(stored, providers)
  assert.deepEqual(rows.map((r) => [r.pluginId, r.live]), [['bronos.chat', true], ['bronos.jira', true], ['bronos.gone', false]])
  assert.equal(rows[0].weight, '')
  assert.equal(rows[0].weightDefault, 30)
  assert.equal(rows[1].weight, '12')
  assert.equal(rows[2].note, 'not installed or off')
  assert.equal(rows[2].on, false)
})

test('an untouched form gives the stored settings back, plus the new row', () => {
  const out = L.formToSettings(stored, providers, formOf())
  assert.deepEqual(out, { ...stored, sources: { ...stored.sources, 'bronos.chat': { on: true } } })
  assert.equal(out.ageCap, 99)
  assert.deepEqual(out.sources['bronos.gone'], { on: false, items: 4, weight: 7 })
})

test('weights: empty drops, a changed value is stored, the default shown is not', () => {
  const f = formOf()
  f.sources['bronos.jira'].weight = ''
  f.sources['bronos.chat'].weight = '40'
  let out = L.formToSettings(stored, providers, f)
  assert.equal(out.sources['bronos.jira'].weight, undefined)
  assert.equal(out.sources['bronos.chat'].weight, 40)
  f.sources['bronos.chat'].items = '7'
  out = L.formToSettings(stored, providers, f)
  assert.equal(out.sources['bronos.chat'].items, 7)
})

test('bad input: a bad number keeps the stored value, no stray key is made', () => {
  const f = formOf({ calendar: { position: 'left', upcoming: 'x', pinMinutes: '30', timeline: 'auto' } })
  f.sources['bronos.chat'].weight = 'abc'
  f.levels.urgent = 'x'
  const out = L.formToSettings(stored, providers, f)
  assert.equal(out.sources['bronos.chat'].weight, undefined) // not a number: nothing stored
  assert.equal(out.levels.urgent, 300) // stored value kept
  assert.equal(out.calendar.upcoming, 3)
  const keys = (o) => Object.keys(o).sort().join()
  assert.equal(keys(out), keys(stored))
  assert.equal(keys(out.calendar), keys(stored.calendar))
  assert.equal(keys(out.levels), keys(stored.levels))
})

test('parseInt10 takes whole numbers only', () => {
  assert.deepEqual(['12', ' -3 ', '1e3', '12abc', '', '1.5'].map(L.parseInt10), [12, -3, undefined, undefined, undefined, undefined])
})
