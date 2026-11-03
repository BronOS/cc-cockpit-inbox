'use strict'
// The panel's pure parts (rowlogic.js, timeline.js) and a guard on main.js: provider text only ever
// goes in through textContent. Local time is Berlin so the strip and the clocks are checkable.
process.env.TZ = 'Europe/Berlin'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const R = require('../panels/rowlogic')
const T = require('../panels/timeline')

const NOW = Date.parse('2026-11-03T13:42:00+01:00')
const MIN = 60000
const HOUR = 60 * MIN
const row = (id, o = {}) => ({ key: `p.${o.src || 'chat'}\u0000${id}`, pluginId: `p.${o.src || 'chat'}`, id, badge: 'CHAT', color: 'green', title: `T ${id}`, from: 'Ann Example', where: 'DM', at: NOW - 4 * MIN, level: 'action', unread: true, why: 'w', ...o })

test('list: the first 9, FYI divider above the first fyi shown, the rest behind Show all', () => {
  const rows = [...Array.from({ length: 6 }, (_, i) => row(`a${i}`)), ...Array.from({ length: 6 }, (_, i) => row(`f${i}`, { level: 'fyi' }))]
  const m = R.listModel(rows, 'all', false)
  assert.equal(m.items.length, 9)
  assert.equal(m.rest, 3)
  assert.deepEqual(m.items.filter((x) => x.divider).map((x) => x.row.id), ['f0'])
  assert.equal(R.listModel(rows, 'all', true).items.length, 12)
  // A filter shows one source.
  const mixed = [row('c1'), row('m1', { src: 'mail' })]
  assert.deepEqual(R.listModel(mixed, 'p.mail', false).items.map((x) => x.row.id), ['m1'])
  assert.deepEqual(R.listModel([], 'all', false), { items: [], rest: 0, total: 0 })
})

test('chips: All counts items but not the calendar pin; problems and the Done & snoozed count', () => {
  const state = {
    rows: [row('c1'), { key: 'cal\u0000e1', calendar: true, id: 'e1' }],
    chips: [{ pluginId: 'p.chat', label: 'Chat', count: 1, color: 'green' }, { pluginId: 'p.jira', label: 'Jira', count: 0, color: 'blue', problem: 'Jira: signed out' }],
    today: [{}, {}],
  }
  assert.deepEqual(R.chipsModel(state), [
    { filter: 'all', label: 'All', count: 1 },
    { filter: 'p.chat', label: 'Chat', count: 1, color: 'green', problem: false },
    { filter: 'p.jira', label: 'Jira', count: 0, color: 'blue', problem: true },
    { filter: 'off', label: 'Done & snoozed', count: 2, done: true },
  ])
  assert.deepEqual(R.problemLines({ ...state, chips: [{ ...state.chips[1], stale: true, asOf: Date.parse('2026-11-03T12:58:00+01:00') }], calendar: { problem: 'Calendar: slow' } }), [
    'Jira: signed out (showing the items from 12:58)',
    'Calendar: slow',
  ])
})

test('rows: triage label, meta, ages, back and related marks; the calendar pin row', () => {
  const m = R.rowModel(row('c1', { also: 1, back: true }), NOW)
  assert.equal(m.tri, 'ACT')
  assert.equal(m.meta, 'Ann Example · DM · +1 related · back: new reply')
  assert.equal(m.age, '4m')
  assert.equal(R.ageText(NOW - 30 * 1000, NOW), 'now')
  assert.equal(R.ageText(NOW - 3 * HOUR, NOW), '3h')
  assert.equal(R.ageText(NOW - 50 * HOUR, NOW), '2d')
  assert.equal(R.ageText(null, NOW), '')
  const cal = R.rowModel({ calendar: true, title: 'Design review starts in 18 min', where: 'Meet', at: NOW + 18 * MIN, meetUrl: 'https://x' }, NOW)
  assert.deepEqual([cal.age, cal.meta, cal.join, cal.calendar], ['14:00', 'Calendar · Meet', true, true])
})

test('hostile titles stay plain strings; colours outside the palette become grey', () => {
  const evil = '<img src=x onerror=alert(1)>'
  assert.equal(R.rowModel(row('x', { title: evil, from: evil }), NOW).title, evil)
  assert.equal(R.colorClass('red'), 'c-red')
  assert.equal(R.colorClass('red; background:url(x)'), 'c-grey')
  // main.js builds every element with textContent: no markup sinks at all.
  for (const f of ['main.js', 'settings.js', 'settingslogic.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'panels', f), 'utf8')
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  }
})

test('Done & snoozed rows', () => {
  assert.deepEqual(R.offModel({ kind: 'done', title: 'A', badge: 'MAIL', at: NOW - HOUR }, NOW), { title: 'A', badge: 'MAIL', when: 'done 12:42', note: 'comes back when it changes' })
  assert.equal(R.offModel({ kind: 'snooze', title: 'B', at: NOW, until: Date.parse('2026-11-04T09:00:00+01:00') }, NOW).when, 'snoozed until tomorrow 09:00')
  assert.equal(R.offModel({ kind: 'snooze', title: 'B', at: NOW, until: null }, NOW).when, 'snoozed until it changes')
  assert.equal(R.dayClock(Date.parse('2026-11-05T09:00:00+01:00'), NOW), 'Thu 09:00')
})

test('the snooze menu labels follow the settings and the clock', () => {
  const before = R.snoozeChoices({ afternoon: '14:00', morning: '09:00' }, NOW)
  assert.deepEqual(before.map((c) => [c.key, c.choice, c.label]), [
    ['1', '1h', '1 hour'],
    ['2', 'afternoon', 'This afternoon, 14:00'],
    ['3', 'tomorrow', 'Tomorrow 9:00'],
    ['4', 'changes', 'Until it changes'],
  ])
  assert.equal(R.snoozeChoices({ afternoon: '13:00', morning: '08:00' }, NOW)[1].label, 'Tomorrow afternoon, 13:00')
})

test('calendar placement for every position', () => {
  const s = (position) => ({ calendar: { position } })
  assert.equal(R.calendarPlacement(s('top'), false), 'top')
  assert.equal(R.calendarPlacement(s('bottom'), true), 'bottom')
  assert.equal(R.calendarPlacement(s('beside'), true), 'side')
  assert.equal(R.calendarPlacement(s('beside'), false), 'top')
  assert.equal(R.calendarPlacement(s('inline'), true), null)
  assert.equal(R.calendarPlacement({ calendar: null }, true), null)
})

test('keys: j/k move, Enter opens, e done, s menu then 1-4, Esc closes, u undo; none on the calendar row', () => {
  const keys = ['a', 'cal', 'b']
  const rowOf = (k) => (k === 'cal' ? { calendar: true } : { key: k })
  const A = (ui, key, mods) => R.keyAction({ menu: null, ...ui }, key, keys, rowOf, mods)
  assert.deepEqual(A({ sel: 'a' }, 'j'), { type: 'select', key: 'cal' })
  assert.deepEqual(A({ sel: 'b' }, 'j'), { type: 'select', key: 'b' })
  assert.deepEqual(A({ sel: 'a' }, 'k'), { type: 'select', key: 'a' })
  assert.deepEqual(A({ sel: null }, 'j'), { type: 'select', key: 'a' })
  assert.deepEqual(A({ sel: 'b' }, 'Enter'), { type: 'open', key: 'b' })
  assert.deepEqual(A({ sel: 'b' }, 'e'), { type: 'done', key: 'b' })
  assert.deepEqual(A({ sel: 'b' }, 's'), { type: 'menu', key: 'b' })
  assert.equal(A({ sel: 'cal' }, 'e'), null)
  assert.equal(A({ sel: 'cal' }, 's'), null)
  assert.deepEqual(A({ sel: 'cal' }, 'Enter'), { type: 'open', key: 'cal' })
  assert.deepEqual(A({ sel: 'b', menu: 'b' }, '3'), { type: 'snooze', key: 'b', choice: 'tomorrow' })
  assert.deepEqual(A({ sel: 'b', menu: 'b' }, 'Escape'), { type: 'closeMenu' })
  assert.equal(A({ sel: 'b', menu: 'b' }, 'e'), null)
  assert.deepEqual(A({ sel: 'b' }, 'u'), { type: 'undo' })
  assert.equal(A({ sel: 'b' }, 'e', { ctrl: true }), null)
  assert.equal(R.keyAction({ sel: null, menu: null }, 'j', [], rowOf), null)
  // After a row leaves, the one now at its place.
  assert.equal(R.nextSelection(['a', 'b', 'c'], 'b', ['a', 'c']), 'c')
  assert.equal(R.nextSelection(['a', 'b', 'c'], 'c', ['a', 'b']), 'b')
  assert.equal(R.nextSelection(['a'], 'a', []), null)
})

test('the strip: half-hour cells, the 08-19 span widened by an early event, the now marker, the scale', () => {
  const at = (h, m = 0) => Date.parse(`2026-11-03T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+01:00`)
  const events = [
    { id: 'a', start: at(9, 30), end: at(10), response: 'accepted' },
    { id: 'b', start: at(16, 30), end: at(17), response: 'needsAction' },
    { id: 'c', start: at(12), end: at(13), response: 'declined' },
    { id: 'd', start: at(0), end: at(23, 59), allDay: true },
  ]
  const timed = T.timedOf(events, NOW)
  assert.equal(timed.length, 3)
  const { lo, hi } = T.dayRange(timed, 'auto')
  assert.deepEqual([lo, hi], [480, 1140])
  const cells = T.stripCells(timed, lo, hi)
  assert.equal(cells.length, 22)
  assert.equal(cells[3], 'busy') // 09:30
  assert.equal(cells[17], 'unanswered') // 16:30
  assert.equal(cells[8], 'free') // 12:00, declined
  assert.deepEqual(T.dayRange(T.timedOf([{ id: 'e', start: at(7, 15), end: at(7, 45) }], NOW), 'auto'), { lo: 420, hi: 1140 })
  assert.deepEqual(T.dayRange(T.timedOf([{ id: 'e', start: at(7, 15), end: at(7, 45) }], NOW), 'work'), { lo: 480, hi: 1140 })
  assert.equal(Math.round(T.nowPct(NOW, 480, 1140)), Math.round(((13 * 60 + 42 - 480) / 660) * 100))
  assert.equal(T.nowPct(at(20), 480, 1140), null)
  assert.deepEqual(T.stripScale(480, 1140).map((s) => s.text), ['08:00', '12:00', '16:00', '19:00'])
})

test('the block: next card with Join, upcoming without the next one, Accept on the unanswered', () => {
  const at = (iso) => Date.parse(iso)
  const review = { id: 'e3', title: 'Design review', start: at('2026-11-03T14:00:00+01:00'), end: at('2026-11-03T14:30:00+01:00'), allDay: false, response: 'accepted', meetUrl: 'https://meet.example.com/x' }
  const plan = { id: 'e5', title: 'Sprint planning', start: at('2026-11-03T16:30:00+01:00'), end: at('2026-11-03T17:30:00+01:00'), allDay: false, response: 'needsAction' }
  const later = { id: 'e9', title: 'Roadmap', start: at('2026-11-04T10:00:00+01:00'), end: at('2026-11-04T11:00:00+01:00'), allDay: false, response: 'accepted' }
  const cal = { position: 'top', timeline: 'auto', upcomingCount: 3, day: { events: [review, plan], tomorrow: { count: 1, first: later } }, upcoming: [review, plan, later] }
  const m = T.calendarModel(cal, NOW)
  assert.equal(m.title, 'Today · Tue 3 Nov')
  assert.equal(m.more, '2 events · tomorrow first 10:00')
  assert.deepEqual(m.next, { id: 'e3', when: 'in 18 min', what: '14:00 Design review', join: true })
  assert.deepEqual(m.upcoming, [
    { id: 'e5', when: '16:30', title: 'Sprint planning', unanswered: true },
    { id: 'e9', when: 'Wed 10:00', title: 'Roadmap', unanswered: false },
  ])
  assert.equal(T.countdown(review, at('2026-11-03T14:10:00+01:00')), 'now · 20 min left')
  assert.equal(T.countdown(plan, NOW), 'in 2 h 48 min')
  // An empty day.
  const empty = T.calendarModel({ position: 'top', upcomingCount: 3, day: { events: [], tomorrow: { count: 0 } }, upcoming: [] }, NOW)
  assert.equal(empty.more, '0 events · tomorrow nothing')
  assert.equal(empty.next, null)
  assert.equal(empty.cells.every((c) => c === 'free'), true)
})
