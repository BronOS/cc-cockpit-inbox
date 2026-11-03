'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const L = require('../panels/settingslogic')
const { readSettings, DEFAULTS } = require('../dist/lib/settings')

const providers = [
  { pluginId: 'bronos.chat', label: 'Chat', color: 'green', kind: 'chat', markRead: true, on: true, items: 10, weight: 30, weightSet: false },
  { pluginId: 'bronos.jira', label: 'Jira', color: 'blue', kind: 'issues', markRead: false, on: true, items: 5, weight: 12, weightSet: true },
]
const stored = readSettings({ sources: { 'bronos.jira': { on: true, items: 5, weight: 12 }, 'bronos.gone': { on: false, items: 4, weight: 7 } }, ageCap: 99 })
const formOf = (over = {}) => ({
  sources: { 'bronos.chat': { on: true, items: '10', weight: '30' }, 'bronos.jira': { on: true, items: '5', weight: '12' } },
  levels: { urgent: '300', action: '150', fyi: '50' }, unread: '10', direct: '20', due: '25', agePerHour: '5',
  dedupeJira: true, doneMarksRead: true, doneReturns: true, notifySnooze: true, afternoon: '14:00', morning: '09:00', badge: 'urgent',
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

test('an untouched form round-trips through readSettings unchanged', () => {
  const out = L.formToSettings(stored, providers, formOf())
  assert.deepEqual(readSettings(out), out)
  assert.deepEqual(out, { ...stored, sources: { ...stored.sources, 'bronos.chat': { on: true } } }) // only the new row
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
  assert.deepEqual(readSettings(out), out)
})

test('bad input: the host refuses it, the form function never makes a stray key', () => {
  const f = formOf({ calendar: { position: 'left', upcoming: '99', pinMinutes: '30', timeline: 'auto' } })
  f.sources['bronos.chat'].weight = 'abc'
  f.sources['bronos.chat'].items = '99'
  f.levels.urgent = 'x'
  const out = L.formToSettings(stored, providers, f)
  assert.equal(out.sources['bronos.chat'].weight, undefined) // not a number: nothing stored
  assert.equal(out.levels.urgent, 300) // stored value kept
  const read = readSettings(out)
  assert.equal(read.calendar.position, DEFAULTS.calendar.position) // "left" replaced by the default
  assert.equal(read.calendar.upcoming, DEFAULTS.calendar.upcoming) // 99 out of range
  assert.equal(read.sources['bronos.chat'].items, undefined) // 99 out of 1..50: the kind's default
  const keys = (o) => Object.keys(o).sort().join()
  assert.equal(keys(out), keys(read))
  assert.equal(keys(out.calendar), keys(read.calendar))
  assert.equal(keys(out.levels), keys(read.levels))
})

test('parseInt10 takes whole numbers only', () => {
  assert.deepEqual(['12', ' -3 ', '1e3', '12abc', '', '1.5'].map(L.parseInt10), [12, -3, undefined, undefined, undefined, undefined])
})
