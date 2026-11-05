'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { search } = require('../dist/lib/search')

const item = (id, o = {}) => ({ source: 'bronos.mail', id, title: `T ${id}`, preview: '', ...o })
const ids = (r) => r.map((x) => x.id)

test('matches each field, case-insensitively', () => {
  const items = [
    item('t', { title: 'Quarterly Report' }),
    item('p', { preview: 'see the INVOICE attached' }),
    item('fn', { from: { name: 'Ada Lovelace' } }),
    item('fa', { from: { address: 'lead@example.com' } }),
    item('pk', { place: { kind: 'space', name: 'Platform Team', status: 'Open' } }),
    item('l', { labels: ['Urgent', 'billing'] }),
    item('none'),
  ]
  assert.deepEqual(ids(search('REPORT', items)), ['t'])
  assert.deepEqual(ids(search('invoice', items)), ['p'])
  assert.deepEqual(ids(search('lovelace', items)), ['fn'])
  assert.deepEqual(ids(search('@example.com', items)), ['fa'])
  assert.deepEqual(ids(search('platform', items)), ['pk'])
  assert.deepEqual(ids(search('open', items)), ['pk'])
  assert.deepEqual(ids(search('urgent', items)), ['l'])
})

test('empty or blank query matches nothing; no regex', () => {
  assert.deepEqual(search('', [item('a')]), [])
  assert.deepEqual(search('   ', [item('a')]), [])
  assert.deepEqual(search('.*', [item('a', { title: 'abc' })]), [])
})

test('Done items are found and marked, live or stored-title only', () => {
  const items = [item('a', { title: 'Plan review' }), item('b', { title: 'Other' })]
  const done = [
    { pluginId: 'bronos.mail', id: 'a', title: 'Plan review', at: 2 },
    { pluginId: 'bronos.chat', id: 'gone', title: 'Old plan thread', at: 1 },
  ]
  const r = search('plan', items, done)
  assert.deepEqual(r.map((x) => [x.id, x.done, x.item !== null]), [['a', true, true], ['gone', true, false]])
  assert.equal(search('other', items, done)[0].done, false)
})
