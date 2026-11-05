'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { DEFAULT_RULES, rank, score } = require('../dist/lib/v1')
const { keyOf } = require('../dist/lib/rules')
const { item, NOW, HOUR, CHAT, MAIL, JIRA } = require('./fakes')

const src = (pluginId, d, items) => ({ pluginId, ...d, items })
const R = DEFAULT_RULES

test("the design's example: an urgent Jira 'PROD down' (310) beats a Chat action (208)", () => {
  const jira = src('bronos.jira', JIRA, [item('OPS-77', { level: 'urgent', title: 'OPS-77 PROD down', at: NOW - 6 * 60000 })])
  const chat = src('bronos.chat', CHAT, [item('c2', { level: 'action', mentionsMe: true, at: NOW - 22 * 60000 })])
  const { rows } = rank([chat, jira], {}, NOW)
  assert.deepEqual(rows.map((r) => [r.id, r.score]), [['OPS-77', 310], ['c2', 210]])
  assert.equal(rows[0].why, 'urgent 300 · jira +0 · unread +10 = 310')
  assert.equal(rows[1].why, 'action 150 · chat +30 · unread +10 · mention +20 = 210')
})

test('within one level the source weight orders: urgent Chat above urgent Jira', () => {
  const { rows } = rank([src('j', JIRA, [item('APP-1', { level: 'urgent' })]), src('c', CHAT, [item('c1', { level: 'urgent' })])], {}, NOW)
  assert.deepEqual(rows.map((r) => r.id), ['c1', 'APP-1'])
})

test('a weight bigger than the level gap makes its source win across levels', () => {
  const rules = { weights: { c: 200 } }
  const { rows } = rank([src('j', JIRA, [item('APP-1', { level: 'urgent' })]), src('c', CHAT, [item('c1', { level: 'action' })])], rules, NOW)
  assert.deepEqual(rows.map((r) => r.id), ['c1', 'APP-1'])
})

test('boosts: unread, direct, due soon and overdue; the age penalty with its cap', () => {
  const s = { pluginId: 'p', ...MAIL }
  assert.equal(score(item('a', { unread: false, at: NOW }), s, R, NOW).score, 150 + 15)
  assert.equal(score(item('a', { unread: true, direct: true, at: NOW }), s, R, NOW).score, 150 + 15 + 10 + 20)
  assert.equal(score(item('a', { unread: false, at: NOW, dueAt: NOW + 47 * HOUR }), s, R, NOW).score, 165 + 25)
  assert.equal(score(item('a', { unread: false, at: NOW, dueAt: NOW + 49 * HOUR }), s, R, NOW).score, 165)
  assert.match(score(item('a', { unread: false, at: NOW, dueAt: NOW - HOUR }), s, R, NOW).why, /overdue \+25/)
  assert.equal(score(item('a', { unread: false, at: NOW - 3 * HOUR }), s, R, NOW).score, 165 - 15)
  assert.equal(score(item('a', { unread: false, at: NOW - 30 * HOUR }), s, R, NOW).score, 165 - 40)
  assert.match(score(item('a', { unread: false, at: NOW - 30 * HOUR }), s, R, NOW).why, /1 d −40/)
  // No time, or a time in the future: no age.
  assert.equal(score(item('a', { unread: false, at: null }), s, R, NOW).score, 165)
})

test('noise never shows; ties go to the newer item, then the key', () => {
  const { rows } = rank([src('m', MAIL, [item('n', { level: 'noise' }), item('old', { at: NOW - 10 * 60000, unread: false }), item('new', { at: NOW - 60000, unread: false })])], {}, NOW)
  assert.deepEqual(rows.map((r) => r.id), ['new', 'old'])
})

test('state: hidden items leave, a snooze that ended gets its bonus, a done item back is marked', () => {
  const k = (id) => keyOf('m', id)
  const state = {
    hidden: (key) => key === k('done'),
    extra: (key) => (key === k('woke') ? R.snoozeBack : 0),
    back: (key) => key === k('back'),
  }
  const { rows } = rank([src('m', MAIL, [item('done', { level: 'urgent' }), item('woke', { level: 'fyi' }), item('back')])], {}, NOW, state)
  assert.deepEqual(rows.map((r) => r.id), ['woke', 'back'])
  assert.match(rows[0].why, /snooze ended \+500/)
  assert.equal(rows[1].back, true)
})

test('dedupe: a mail about a listed issue is hidden and the issue counts it; off keeps both', () => {
  const sources = [src('j', JIRA, [item('APP-5')]), src('m', MAIL, [item('m1', { jiraKey: 'APP-5' }), item('m2', { jiraKey: 'APP-9' })])]
  const on = rank(sources, {}, NOW)
  assert.deepEqual(on.rows.map((r) => r.id).sort(), ['APP-5', 'm2'])
  assert.equal(on.rows.find((r) => r.id === 'APP-5').also, 1)
  assert.equal(on.hiddenByDedupe, 1)
  assert.equal(rank(sources, { dedupeJira: false }, NOW).rows.length, 3)
})

test('calendar pin: from 30 min before the start until the end, under the urgent items', () => {
  const ev = (start, o = {}) => ({ id: 'e1', title: 'Design review', start, end: start + 30 * 60000, allDay: false, response: 'accepted', meetUrl: 'https://meet.example.com/x', ...o })
  const sources = [src('c', CHAT, [item('u', { level: 'urgent' }), item('a', { level: 'action' })])]
  const pinned = (events, now = NOW) => rank(sources, {}, now, undefined, { position: 'inline', pinMinutes: 30, events }).rows.map((r) => r.id)
  assert.deepEqual(pinned([ev(NOW + 18 * 60000)]), ['u', 'e1', 'a'])
  assert.deepEqual(pinned([ev(NOW + 31 * 60000)]), ['u', 'a'])
  assert.deepEqual(pinned([ev(NOW - 10 * 60000)]), ['u', 'e1', 'a'])
  assert.deepEqual(pinned([ev(NOW - 31 * 60000)]), ['u', 'a'])
  assert.deepEqual(pinned([ev(NOW + 60000, { response: 'declined' })]), ['u', 'a'])
  assert.deepEqual(pinned([ev(NOW + 60000, { allDay: true })]), ['u', 'a'])
  const row = rank(sources, {}, NOW, undefined, { position: 'inline', pinMinutes: 30, events: [ev(NOW + 18 * 60000)] }).rows[1]
  assert.equal(row.title, 'Design review starts in 18 min')
  assert.equal(row.meetUrl, 'https://meet.example.com/x')
  // Any other position: no pin in the list.
  assert.deepEqual(rank(sources, {}, NOW, undefined, { position: 'top', pinMinutes: 30, events: [ev(NOW + 60000)] }).rows.map((r) => r.id), ['u', 'a'])
})
