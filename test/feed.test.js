'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { CAPS, describeOf, itemOf, syncOf, goneOf, itemsOf, calDayOf, calUpcomingOf, featuresOf, actReplyOf, httpsUrl } = require('../dist/lib/feed')
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
  assert.deepEqual([...featuresOf(['markRead', 'other', 5, '', 'markRead', 'a\nb'])], ['markRead', 'other', 'a b'])
  assert.equal(featuresOf(Array.from({ length: 100 }, (_, i) => `f${i}`)).size, 32)
  assert.equal([...featuresOf(['x'.repeat(100)])][0].length, CAPS.labelLen)
  assert.deepEqual([...featuresOf('x')], [])
  assert.equal(httpsUrl('http://example.com'), null)
  assert.equal(httpsUrl(`https://example.com/${'x'.repeat(2100)}`), null)
  assert.equal(httpsUrl('https://example.com/a b'), 'https://example.com/a%20b')
})

// ---- feed v2 ----
const v2 = (id, extra = {}) => ({ id, rev: 'r1', title: `title ${id}`, time: NOW, read: false, actions: [{ id: 'open', label: 'Open' }], ...extra })

test('describeOf: scope is cut to 120 and left out when absent or not a string', () => {
  assert.equal(describeOf({ label: 'Mail', scope: 'unread + read of the last 14 days' }, 'p').scope, 'unread + read of the last 14 days')
  assert.equal(describeOf({ label: 'Mail', scope: 'x'.repeat(300) }, 'p').scope.length, CAPS.scope)
  assert.equal('scope' in describeOf({ label: 'Mail', scope: 5 }, 'p'), false)
})

test('itemOf keeps a full valid item', () => {
  const { item, refused } = itemOf(v2('a', { preview: 'p', from: { name: 'N', address: 'n@example.com' }, to: 'direct', mentionsMe: true, place: { kind: 'project', name: 'APP', status: 'Open' }, labels: ['assigned'], read: true }))
  assert.equal(refused, 0)
  assert.deepEqual(item, { id: 'a', rev: 'r1', title: 'title a', time: NOW, mentionsMe: true, read: true, preview: 'p', from: { name: 'N', address: 'n@example.com' }, to: 'direct', place: { kind: 'project', name: 'APP', status: 'Open' }, labels: ['assigned'], actions: [{ id: 'open', label: 'Open' }] })
})

test('itemOf: titles and previews are cut and flattened to one line; names and places are cut', () => {
  const { item } = itemOf(v2('a', { title: `a\n\n  b\t${'x'.repeat(400)}`, preview: `${'y '.repeat(800)}`, from: { name: 'n'.repeat(500), address: 'a'.repeat(500) }, place: { kind: 'channel', name: 'c'.repeat(500), status: 's'.repeat(500) } }))
  assert.equal(item.title.length, CAPS.title)
  assert.ok(item.title.startsWith('a b '))
  assert.equal(item.preview.length, CAPS.preview)
  assert.equal(item.from.name.length, CAPS.name)
  assert.equal(item.from.address.length, CAPS.address)
  assert.equal(item.place.name.length, CAPS.name)
  assert.equal(item.place.status.length, CAPS.placeStatus)
})

test('itemOf: bad or missing id, rev, title or time refuses the item', () => {
  for (const bad of [null, 5, [], {}, v2('a', { id: '' }), v2('a', { id: 'x'.repeat(201) }), v2('a', { id: 'a\nb' }), v2('a', { id: 7 }), v2('a', { rev: '' }), v2('a', { rev: undefined }), v2('a', { title: '  ' }), v2('a', { title: 3 }), v2('a', { time: 0 }), v2('a', { time: -1 }), v2('a', { time: NaN }), v2('a', { time: Infinity }), v2('a', { time: '5' })]) {
    assert.deepEqual(itemOf(bad), { item: null, refused: 1 })
  }
  assert.equal(itemOf(v2('a', { id: 'x'.repeat(200) })).refused, 0)
  assert.equal(itemOf(v2('a', { rev: 'r'.repeat(300) })).item.rev.length, CAPS.rev)
})

test('itemOf: read is boolean or null; optional fields of the wrong type are left out; unknown fields dropped', () => {
  assert.equal(itemOf(v2('a', { read: 'yes' })).item.read, null)
  assert.equal(itemOf(v2('a', { read: null })).item.read, null)
  const { item } = itemOf(v2('a', { to: 'everyone', mentionsMe: 'yes', from: 5, place: { kind: 'planet', name: 'x' }, preview: 7, level: 'urgent', extra: { a: 1 } }))
  assert.equal(item.to, undefined)
  assert.equal(item.mentionsMe, false)
  assert.equal(item.from, undefined)
  assert.equal(item.place, undefined)
  assert.equal(item.preview, undefined)
  assert.equal('level' in item, false)
  assert.equal('extra' in item, false)
})

test('itemOf: labels are capped at 20, compared case-insensitively, one line each', () => {
  const labels = ['Alert', 'alert', 'x'.repeat(100), '', 5, ...Array.from({ length: 40 }, (_, i) => `l${i}`)]
  const { item } = itemOf(v2('a', { labels }))
  assert.equal(item.labels.length, CAPS.labels)
  assert.equal(item.labels[0], 'Alert')
  assert.equal(item.labels[1].length, CAPS.labelLen)
  assert.equal(item.labels.filter((l) => l.toLowerCase() === 'alert').length, 1)
  assert.deepEqual(itemOf(v2('a', { labels: 'alert' })).item.labels, [])
})

test('itemOf: actions are capped at 8, ids match the pattern, labels 1-40, duplicates dropped', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `act${i}`, label: `Act ${i}` }))
  assert.equal(itemOf(v2('a', { actions: many })).item.actions.length, CAPS.actions)
  const { item } = itemOf(v2('a', { actions: [{ id: 'Open', label: 'x' }, { id: '1a', label: 'x' }, { id: 'a_b', label: 'x' }, { id: 'a'.repeat(41), label: 'x' }, { id: 'ok-1', label: '' }, { id: 'ok-2', label: 'y'.repeat(80) }, { id: 'ok-2', label: 'dup' }, { id: 'markRead', label: 'Read' }, null, 'open'] }))
  assert.deepEqual(item.actions.map((a) => a.id), ['ok-2', 'markRead'])
  assert.equal(item.actions[0].label.length, CAPS.actionLabel)
  assert.deepEqual(itemOf(v2('a', { actions: undefined })).item.actions, [])
})

test('itemOf: prototype keys never reach the result', () => {
  const raw = JSON.parse('{"id":"p","rev":"r","title":"t","time":5,"__proto__":{"to":"cc"},"constructor":"x","from":{"__proto__":{"name":"evil"}},"labels":["__proto__","constructor"],"actions":[{"id":"open","label":"Open","__proto__":{"x":1}}]}')
  const { item } = itemOf(raw)
  assert.equal(item.to, undefined)
  assert.equal(item.from, undefined)
  assert.equal(Object.getPrototypeOf(item), Object.prototype)
  assert.equal(({}).to, undefined)
  assert.deepEqual(item.labels, ['__proto__', 'constructor'])
  assert.deepEqual(item.actions, [{ id: 'open', label: 'Open' }])
})

test('syncOf: items, state, message and asOf; unknown state reads ok; message cut', () => {
  const r = syncOf({ items: [v2('a'), v2('b')], state: 'signedOut', message: 'm'.repeat(500), asOf: NOW })
  assert.deepEqual(r.items.map((i) => i.id), ['a', 'b'])
  assert.equal(r.state, 'signedOut')
  assert.equal(r.message.length, CAPS.message)
  assert.equal(r.asOf, NOW)
  assert.equal(r.refused, 0)
  assert.equal(r.overCap, 0)
  assert.equal(syncOf({ items: [], state: 'weird' }).state, 'ok')
  assert.equal(syncOf({ items: [] }).asOf, null)
  assert.equal('message' in syncOf({ items: [] }), false)
})

test('syncOf: a malformed answer is a source error with no items', () => {
  for (const bad of [null, 'junk', 5, [], {}, { items: 'no' }, { items: {} }]) {
    const r = syncOf(bad)
    assert.equal(r.state, 'error')
    assert.deepEqual(r.items, [])
    assert.ok(r.message)
  }
})

test('syncOf: refused items and duplicate ids are counted; the first duplicate wins', () => {
  const r = syncOf({ items: [v2('a', { title: 'first' }), v2('a', { title: 'second' }), null, { id: 'b' }, v2('c')] })
  assert.deepEqual(r.items.map((i) => i.title), ['first', 'title c'])
  assert.equal(r.refused, 3)
})

test('syncOf: past 1000 items the newest by time stay and the rest are counted', () => {
  const items = Array.from({ length: 1005 }, (_, i) => v2(`i${i}`, { time: 1000 + i }))
  const r = syncOf({ items })
  assert.equal(r.items.length, CAPS.perSource)
  assert.equal(r.overCap, 5)
  assert.equal(Math.min(...r.items.map((i) => i.time)), 1005)
  assert.equal(r.items[0].id, 'i1004')
})

test('syncOf: a huge array is bounded, not fully parsed', () => {
  const items = Array.from({ length: 5000 }, (_, i) => v2(`i${i}`, { time: 1 + i }))
  const r = syncOf({ items })
  assert.equal(r.items.length, CAPS.perSource)
  assert.equal(r.overCap, 4000)
})

test('syncOf: prototype keys in the answer and items do not leak', () => {
  const r = syncOf(JSON.parse('{"items":[{"id":"a","rev":"r","title":"t","time":5,"__proto__":{"read":true}}],"__proto__":{"state":"error"},"constructor":{}}'))
  assert.equal(r.state, 'ok')
  assert.equal(r.items[0].read, null)
  assert.deepEqual(syncOf(JSON.parse('{"__proto__":{"items":[]}}')).state, 'error')
})

test('goneOf: ids are validated, deduplicated and capped at 500, with counts', () => {
  assert.deepEqual(goneOf({ ids: ['a', 'b', 'a'] }), { ids: ['a', 'b'], refused: 0, overCap: 0 })
  assert.deepEqual(goneOf({ ids: ['a', '', 5, 'x\ny', 'x'.repeat(201), null] }), { ids: ['a'], refused: 5, overCap: 0 })
  const many = goneOf({ ids: Array.from({ length: 520 }, (_, i) => `i${i}`) })
  assert.equal(many.ids.length, CAPS.gone)
  assert.equal(many.overCap, 20)
  for (const bad of [null, 'a', 5, {}, { ids: 'a' }]) assert.deepEqual(goneOf(bad), { ids: [], refused: 1, overCap: 0 })
  assert.deepEqual(goneOf(JSON.parse('{"__proto__":{"ids":["a"]}}')).ids, [])
})

test('goneOf: empty list refused, over-cap counts only valid unique ids, scan is bounded', () => {
  assert.deepEqual(goneOf({ ids: [] }), { ids: [], refused: 1, overCap: 0 })
  const mixed = goneOf({ ids: [...Array.from({ length: 500 }, (_, i) => `i${i}`), '', 5, 'i0', 'i499', 'extra'] })
  assert.equal(mixed.ids.length, 500)
  assert.deepEqual([mixed.refused, mixed.overCap], [2, 1])
  const huge = goneOf({ ids: Array.from({ length: 5000 }, (_, i) => `i${i % 600}`) })
  assert.equal(huge.ids.length, 500)
  assert.equal(huge.overCap, 100)
  assert.equal(huge.refused, 3000)
})

test('actReplyOf: ok, failure message capped to one line of 300, junk is a failure', () => {
  assert.deepEqual(actReplyOf({ ok: true, extra: 1 }), { ok: true })
  assert.deepEqual(actReplyOf({ ok: false }), { ok: false })
  const r = actReplyOf({ ok: false, message: `a\nb${'x'.repeat(400)}` })
  assert.equal(r.ok, false)
  assert.equal(r.message.length, CAPS.message)
  assert.ok(!r.message.includes('\n'))
  for (const bad of [null, 'ok', { ok: 'yes' }, [], {}]) assert.equal(actReplyOf(bad).ok, false)
})
