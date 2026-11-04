'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { CAPS, describeOf, itemsOf, calDayOf, calUpcomingOf, featuresOf, httpsUrl } = require('../dist/lib/feed')
const { item, NOW, HOUR } = require('./fakes')

test('describeOf keeps a good answer and falls back on junk', () => {
  assert.deepEqual(describeOf({ label: 'Chat', badge: 'chat', color: 'green', kind: 'chat' }, 'bronos.chat'), { label: 'Chat', badge: 'CHAT', color: 'green', kind: 'chat' })
  assert.deepEqual(describeOf(null, 'acme.forge'), { label: 'forge', badge: 'FEED', color: 'grey', kind: 'other' })
  const odd = describeOf({ label: 'x'.repeat(100), badge: 'TOOLONG', color: 'url(javascript:1)', kind: 'weird' }, 'p')
  assert.equal(odd.label.length, CAPS.label)
  assert.equal(odd.badge.length, CAPS.badge)
  assert.equal(odd.color, 'grey')
  assert.equal(odd.kind, 'other')
})

test('itemsOf keeps valid items, caps strings and the list, drops junk and duplicates', () => {
  const many = Array.from({ length: 70 }, (_, i) => item(`i${i}`))
  const r = itemsOf({ items: [item('a', { title: 'x'.repeat(500), jiraKey: 'APP-1', dueAt: NOW + HOUR }), item('a'), null, { id: 'b', title: 'no level' }, ...many], asOf: NOW, state: 'ok' })
  assert.equal(r.items.length, CAPS.items - 4 + 1)
  assert.equal(r.items[0].title.length, CAPS.title)
  assert.equal(r.items[0].jiraKey, 'APP-1')
  assert.equal(r.items[0].dueAt, NOW + HOUR)
  assert.equal(r.asOf, NOW)
  assert.equal(r.state, 'ok')
})

test('itemsOf: wrong types become safe values; a bad jiraKey is dropped; newlines flattened', () => {
  const [it] = itemsOf({ items: [{ id: 'x', title: 'a\nb\u2028c', level: 'fyi', unread: 'yes', at: 'now', jiraKey: 'not a key', from: 5 }] }).items
  assert.equal(it.title, 'a b c')
  assert.equal(it.unread, false)
  assert.equal(it.at, null)
  assert.equal(it.from, '')
  assert.equal(it.jiraKey, undefined)
})

test('itemsOf: canUnread is kept only as an explicit false', () => {
  const its = itemsOf({ items: [{ id: 'a', title: 't', level: 'fyi', canUnread: false }, { id: 'b', title: 't', level: 'fyi', canUnread: 'no' }, { id: 'c', title: 't', level: 'fyi', canUnread: true }] }).items
  assert.deepEqual(its.map((i) => i.canUnread), [false, undefined, undefined])
})

test('itemsOf: a malformed answer is a source error; an unknown state reads ok; signedOut kept with its message', () => {
  assert.equal(itemsOf('junk').state, 'error')
  assert.equal(itemsOf({ items: 'no' }).state, 'error')
  assert.equal(itemsOf({ items: [], state: 'weird' }).state, 'ok')
  assert.deepEqual(itemsOf({ items: [], state: 'signedOut', message: 'sign in' }), { items: [], asOf: null, state: 'signedOut', message: 'sign in' })
})

test('prototype keys never reach the result', () => {
  const raw = JSON.parse('{"items":[{"id":"p","title":"t","level":"fyi","__proto__":{"unread":true},"constructor":"x"}]}')
  const [it] = itemsOf(raw).items
  assert.equal(it.unread, false)
  assert.equal(Object.hasOwn(it, 'constructor'), false)
  assert.equal({}.unread, undefined)
})

test('calendar: events checked, sorted, meet links https only', () => {
  const ev = (id, start, o = {}) => ({ id, title: id, start, end: start + HOUR, allDay: false, response: 'accepted', ...o })
  const d = calDayOf({
    date: '2026-11-03',
    events: [ev('b', NOW + 2 * HOUR, { meetUrl: 'https://meet.example.com/x' }), ev('a', NOW, { meetUrl: 'javascript:alert(1)' }), { id: 'bad', start: NOW, end: NOW - 1 }, ev('c', NOW, { response: 'maybe?', meetUrl: 'https://u:p@meet.example.com/' })],
    tomorrow: { count: 2, first: ev('t', NOW + 24 * HOUR) },
  })
  assert.deepEqual(d.events.map((e) => e.id), ['a', 'c', 'b'])
  assert.equal(d.events[0].meetUrl, undefined)
  assert.equal(d.events[1].response, null)
  assert.equal(d.events[1].meetUrl, undefined)
  assert.equal(d.events[2].meetUrl, 'https://meet.example.com/x')
  assert.equal(d.tomorrow.count, 2)
  assert.equal(d.tomorrow.first.id, 't')
  assert.equal(calDayOf(null).state, 'error')
  assert.equal(calDayOf({ events: [], date: '3 Nov' }).date, null)
})

test('calendar upcoming: capped at 20, junk is empty', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ id: `u${i}`, title: 't', start: NOW + i * HOUR, end: NOW + i * HOUR + 1 }))
  assert.equal(calUpcomingOf(list).length, CAPS.upcoming)
  assert.deepEqual(calUpcomingOf({ not: 'an array' }), [])
})

test('features and URLs', () => {
  assert.deepEqual([...featuresOf(['markRead', 'other'])], ['markRead'])
  assert.deepEqual([...featuresOf('x')], [])
  assert.equal(httpsUrl('http://example.com'), null)
  assert.equal(httpsUrl(`https://example.com/${'x'.repeat(2100)}`), null)
  assert.equal(httpsUrl('https://example.com/a b'), 'https://example.com/a%20b')
})
