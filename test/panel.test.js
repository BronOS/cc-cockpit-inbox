'use strict'
// The panel v2's pure parts (panels/rowlogic.js) over the host's `state` v2 shape, and a guard on
// main.js: provider text only ever goes in through textContent. Local time is Berlin so the clocks
// are checkable.
process.env.TZ = 'Europe/Berlin'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const R = require('../panels/rowlogic')

const NOW = Date.parse('2026-11-03T13:42:00+01:00')
const MIN = 60000
const HOUR = 60 * MIN

/** A row as dist/host.js `rowOut` sends it. */
const row = (id, o = {}) => ({
  key: `p.${o.src || 'chat'}\u0000${id}`,
  source: `p.${o.src || 'chat'}`,
  id,
  title: `T ${id}`,
  preview: 'first line',
  time: NOW - 4 * MIN,
  from: { name: 'Ann Example', address: 'ann@example.com' },
  place: { kind: 'channel', name: 'general' },
  labels: [],
  read: false,
  actions: [{ id: 'markRead', label: 'Mark read' }],
  canOpen: true,
  badge: 'CHAT',
  color: 'green',
  label: 'Chat',
  reason: 'rule 4: sourceKind is chat',
  jev: null,
  ...o,
})
const source = (pluginId, o = {}) => ({ pluginId, label: pluginId.slice(2), badge: 'X', color: 'blue', kind: 'other', state: 'ok', message: null, error: null, stale: false, asOf: null, loaded: true, refused: 0, overCap: 0, count: 0, shown: 0, ...o })
const group = (id, rows, o = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), collapsed: false, badge: true, count: rows.length, unread: 0, rows, ...o })
const stateOf = (o = {}) => ({ type: 'state', version: 2, now: NOW, groups: [], sources: [], done: { count: 0, rows: [] }, search: null, undo: null, agenda: 'top', ...o })

test('rows: badge, title, from · place (no time), the preview first line, three labels, the reason, the time column', () => {
  const m = R.rowModel(row('c1', { kind: 'mail', preview: 'hello there\nsecond line', labels: ['alert', 'mention:all', 'jira:PROJ-12', 'fourth'] }), NOW)
  assert.equal(m.badge, 'CHAT')
  assert.equal(m.color, 'green')
  assert.equal(m.source, 'Chat')
  assert.equal(m.title, 'T c1')
  assert.equal(m.head, null, 'not a chat source: no chat head')
  assert.equal(m.message, '')
  assert.equal(m.meta, 'Ann Example · general')
  assert.equal(m.when, '4m')
  assert.equal(m.whenTitle, 'Tue 3 Nov 2026, 13:38')
  assert.equal(m.preview, 'hello there')
  assert.deepEqual(m.labels, ['alert', 'mention:all', 'jira:PROJ-12'])
  assert.equal(m.reason, 'rule 4: sourceKind is chat')
  assert.equal(m.unread, true)
  assert.equal(m.canOpen, true)
  // A project with a status, an address-only sender, read state null (no read state: not unread).
  const j = R.rowModel(row('PROJ-12', { kind: 'issues', from: { address: 'lead@example.com' }, place: { kind: 'project', name: 'PROJ', status: 'In review' }, read: null, time: NOW - 3 * HOUR }), NOW)
  assert.equal(j.meta, 'lead@example.com · PROJ · In review')
  assert.equal(j.when, '3h')
  assert.equal(j.unread, false)
  // Nothing but a title.
  const bare = R.rowModel({ key: 'k', title: 'Only', actions: [] }, NOW)
  assert.deepEqual([bare.meta, bare.preview, bare.labels, bare.reason, bare.badge, bare.color, bare.canOpen, bare.when, bare.whenTitle], ['', '', [], '', 'FEED', 'grey', false, '', ''])
})

test('a mail row: the subject, the sender and folder in the meta, the snippet, the time on the right', () => {
  const m = R.rowModel(row('t1', { kind: 'mail', src: 'mail', badge: 'MAIL', title: 'Release 1.7.10 upgrade', preview: 'Good morning team, it is ready for testing.', from: { name: 'Ann Example', address: 'ann@example.com' }, place: { kind: 'folder', name: 'Inbox' }, time: NOW - HOUR, reason: 'rule 5: sourceKind is mail' }), NOW)
  assert.deepEqual([m.title, m.head, m.meta, m.preview, m.when, m.reason], ['Release 1.7.10 upgrade', null, 'Ann Example · Inbox', 'Good morning team, it is ready for testing.', '1h', 'rule 5: sourceKind is mail'])
  assert.deepEqual(m.marks, [], 'mentionsMe is a mark of chat rows only (Jira says it with its own label)')
})

test('a chat row: place · sender on the first line, the message under it, the meta without them', () => {
  const chat = (o) => R.rowModel(row('spaces/S', { kind: 'chat', ...o }), NOW)
  // A space (flat): bronos.chat's title is the space, the place too; the message is the preview.
  const sp = chat({ title: 'Acme Team', preview: 'Thank you', from: { name: 'Max Example' }, place: { kind: 'channel', name: 'Acme Team' }, to: 'group' })
  assert.deepEqual(sp.head, { dm: false, place: 'Acme Team', thread: '', from: 'Max Example' })
  assert.equal(sp.message, 'Thank you')
  assert.equal(sp.meta, '', 'where and who are in the head, not repeated in the meta')
  assert.equal(sp.preview, '', 'the message is not drawn twice')
  assert.equal(sp.reason, 'rule 4: sourceKind is chat')
  assert.equal(sp.title, 'Acme Team', 'the model keeps the title as sent')
  // A mention is a mark, before the reason.
  assert.deepEqual(chat({ mentionsMe: true }).marks, ['mentions you'])
  // A thread whose latest is a reply: its start (the title) is the thread's name.
  const th = chat({ title: '@Oleg can you look at the failover alerts?', preview: 'the second spike is at 08:12', from: { name: 'Ann Example' }, place: { kind: 'channel', name: 'Alerts' }, to: 'group' })
  assert.deepEqual(th.head, { dm: false, place: 'Alerts', thread: '@Oleg can you look at the failover alerts?', from: 'Ann Example' })
  assert.equal(th.message, 'the second spike is at 08:12')
  // A thread whose start is the latest message (the title cut with an ellipsis): no thread name, it would repeat the message.
  const one = chat({ title: '@Oleg can you look at the failover…', preview: '@Oleg can you look at the failover alerts before the call?', place: { kind: 'channel', name: 'Alerts' }, to: 'group' })
  assert.equal(one.head.thread, '')
  assert.equal(one.message, '@Oleg can you look at the failover alerts before the call?')
  // No preview: the title is the message.
  const bare = chat({ title: 'Lunch?', preview: undefined, place: { kind: 'channel', name: 'Acme Team' } })
  assert.equal(bare.message, 'Lunch?')
  assert.equal(bare.head.thread, '')
  // No place: the title leads, the sender not said twice.
  assert.deepEqual(chat({ title: 'Ann Example', place: undefined, from: { name: 'Ann Example' } }).head, { dm: false, place: 'Ann Example', thread: '', from: '' })
})

test('a DM row: the person with a DM tag (to: direct), never "Direct message" or "you"', () => {
  const dm = (o) => R.rowModel(row('spaces/D', { kind: 'chat', to: 'direct', place: { kind: 'channel', name: 'Direct message' }, ...o }), NOW)
  // bronos.chat: the DM's title is the other person; the latest sender may be the person ("you").
  const a = dm({ title: 'Bob Example', preview: 'ok, merged', from: { name: 'you' } })
  assert.deepEqual(a.head, { dm: true, place: 'Bob Example', thread: '', from: '' })
  assert.equal(a.message, 'ok, merged')
  assert.equal(a.meta, '')
  // A source whose DM title is the message itself: the sender is the person.
  const b = dm({ title: 'ok, merged', preview: undefined, from: { name: 'Bob Example' } })
  assert.deepEqual([b.head.place, b.message], ['Bob Example', 'ok, merged'])
})

test('row actions: the source actions without open, then Done and Snooze; marks for back and search hits', () => {
  const m = R.rowModel(row('c1', { actions: [{ id: 'open', label: 'Open' }, { id: 'markRead', label: 'Mark read' }, { id: 'done', label: 'Archive' }] }), NOW)
  assert.deepEqual(m.actions.map((a) => [a.id, a.label, a.own]), [
    ['markRead', 'Mark read', false],
    ['done', 'Archive', false],
    ['done', 'Done', true],
    ['snooze', 'Snooze', true],
  ])
  assert.deepEqual(R.rowModel(row('b', { back: true }), NOW).marks, ['back: new activity'])
  const hit = R.rowModel(row('d', { done: true }), NOW)
  assert.deepEqual(hit.marks, ['done'])
  assert.deepEqual(hit.actions.map((a) => a.id), ['markRead'], 'a done hit has no Done or Snooze')
  assert.deepEqual(R.rowModel(row('s', { snoozed: true }), NOW).marks, ['snoozed'])
  // A pending Jev answer shows in the reason the rules wrote.
  assert.match(R.rowModel(row('j', { jev: 'pending', reason: 'rule 6: sourceKind is chat · rule 2: Jev…' }), NOW).reason, /Jev…/)
})

test('groups: counts, Rest collapsed unless opened, the remembered open state, empty groups left out', () => {
  const s = stateOf({
    groups: [group('now', [row('a')]), group('chat', []), group('rest', [row('r1'), row('r2')], { collapsed: true, badge: false })],
    sources: [source('p.chat', { shown: 3 })],
  })
  const m = R.viewModel(s, { filter: 'all', open: {} })
  assert.equal(m.kind, 'groups')
  assert.deepEqual(m.groups.map((g) => [g.id, g.count, g.open]), [['now', 1, true], ['rest', 2, false]])
  assert.equal(m.empty, null)
  // Rest's rows are not on the keyboard's way while it is closed.
  assert.deepEqual(R.selectableKeys(m), ['p.chat\u0000a'])
  const opened = R.viewModel(s, { filter: 'all', open: { rest: true, now: false } })
  assert.deepEqual(opened.groups.map((g) => g.open), [false, true])
  assert.deepEqual(R.selectableKeys(opened), ['p.chat\u0000r1', 'p.chat\u0000r2'])
  // The host's memory (another window, the last start) applies; this page's own click wins over it.
  const remembered = { ...s, groupsOpen: { rest: true, now: false } }
  assert.deepEqual(R.viewModel(remembered, { filter: 'all', open: {} }).groups.map((g) => g.open), [false, true])
  assert.deepEqual(R.viewModel(remembered, { filter: 'all', open: { now: true } }).groups.map((g) => g.open), [true, true])
  assert.deepEqual(R.viewModel({ ...s, groupsOpen: ['junk'] }, { filter: 'all', open: {} }).groups.map((g) => g.open), [true, false])
  // The host sends 200 rows a group: the rest is counted.
  const big = R.viewModel(stateOf({ groups: [group('mail', [row('m1')], { count: 250 })], sources: [source('p.chat')] }), { filter: 'all' })
  assert.equal(big.groups[0].more, 249)
})

test('chips: All, one per source with its shown count and a problem mark, Done; a source filter', () => {
  const s = stateOf({
    groups: [group('now', [row('a'), row('m', { src: 'mail' })]), group('rest', [row('r')], { count: 5 })],
    sources: [source('p.chat', { label: 'Chat', color: 'green', shown: 2 }), source('p.mail', { label: 'Mail', color: 'violet; x', shown: 1, state: 'signedOut' })],
    done: { count: 3, rows: [] },
  })
  assert.deepEqual(R.chipsModel(s, 'p.mail'), [
    { filter: 'all', label: 'All', count: 7, on: false },
    { filter: 'p.chat', label: 'Chat', count: 2, color: 'green', problem: false, on: false },
    { filter: 'p.mail', label: 'Mail', count: 1, color: 'grey', problem: true, on: true },
    { filter: 'done', label: 'Done', count: 3, on: false },
  ])
  const m = R.viewModel(s, { filter: 'p.mail' })
  assert.deepEqual(m.groups.map((g) => [g.id, g.count, g.rows.map((r) => r.id)]), [['now', 1, ['m']]])
  assert.equal(R.chipFilter('all', 'done'), 'done')
  assert.equal(R.chipFilter('done', 'done'), 'all')
  assert.equal(R.chipFilter('p.chat', 'p.chat'), 'all')
  assert.equal(R.chipFilter('done', 'p.chat'), 'p.chat')
  assert.equal(R.chipFilter('all', 'all'), 'all')
  // A filter on a source that left goes back to All.
  assert.equal(R.validFilter(s, 'p.gone'), 'all')
  assert.equal(R.validFilter(s, 'p.chat'), 'p.chat')
  assert.equal(R.validFilter(s, 'done'), 'done')
})

test('source error lines: not ok, a failed snapshot, refused and over-cap counts, stale since when', () => {
  const asOf = Date.parse('2026-11-03T12:58:00+01:00')
  assert.equal(R.sourceLine(source('p.mail', { label: 'Mail' })), null)
  assert.equal(R.sourceLine(source('p.mail', { label: 'Mail', state: 'signedOut', stale: true, asOf })), 'Mail: signed out, showing items from 12:58')
  assert.equal(R.sourceLine(source('p.mail', { label: 'Mail', state: 'error', message: 'quota exceeded' })), 'Mail: quota exceeded')
  assert.equal(R.sourceLine(source('p.jira', { label: 'Jira', error: 'Jira: did not answer in 10 s', stale: true, asOf })), 'Jira: did not answer in 10 s, showing items from 12:58')
  assert.equal(R.sourceLine(source('p.mail', { label: 'Mail', refused: 2 })), 'Mail: some items were left out · 2 items refused')
  assert.equal(
    R.sourceLine(source('p.mail', { label: 'Mail', state: 'signedOut', refused: 1, overCap: 40 })),
    'Mail: signed out · 1 item refused · 40 older items left out (over 1000)'
  )
  const s = stateOf({ sources: [source('p.mail', { label: 'Mail', state: 'signedOut' }), source('p.chat', { label: 'Chat' }), source('p.jira', { label: 'Jira', overCap: 1 })] })
  assert.deepEqual(R.sourceLines(s, 'all'), ['Mail: signed out', 'Jira: some items were left out · 1 older item left out (over 1000)'])
  assert.deepEqual(R.sourceLines(s, 'p.jira'), ['Jira: some items were left out · 1 older item left out (over 1000)'])
  assert.deepEqual(R.sourceLines(s, 'p.chat'), [])
})

test('the Done view: newest first as the host sends it, live or gone, Back to Inbox, empty', () => {
  const done = { count: 2, rows: [
    { key: 'p.chat\u0000a', source: 'p.chat', id: 'a', title: 'Lunch?', at: NOW - HOUR, live: true, badge: 'CHAT', color: 'green', label: 'Chat' },
    { key: 'p.mail\u0000b', source: 'p.mail', id: 'b', title: '', at: NOW - 2 * HOUR, live: false, badge: 'MAIL', color: 'violet', label: 'Mail' },
  ] }
  const s = stateOf({ done, sources: [source('p.chat'), source('p.mail')] })
  const m = R.viewModel(s, { filter: 'done' })
  assert.equal(m.kind, 'done')
  assert.deepEqual(m.done.map((e) => e.id), ['a', 'b'])
  assert.deepEqual(R.selectableKeys(m), ['p.chat\u0000a', 'p.mail\u0000b'])
  assert.deepEqual(R.doneRowModel(done.rows[0]), { key: 'p.chat\u0000a', badge: 'CHAT', color: 'green', source: 'Chat', title: 'Lunch?', meta: 'done 12:42', canOpen: true })
  assert.deepEqual(R.doneRowModel(done.rows[1]), { key: 'p.mail\u0000b', badge: 'MAIL', color: 'violet', source: 'Mail', title: '(no title)', meta: 'done 11:42 · no longer in the source', canOpen: false })
  assert.match(R.viewModel(stateOf({ sources: [source('p.chat')] }), { filter: 'done' }).empty, /^Nothing marked done/)
})

test('search results: grouped as the list, every group open, Done hits marked, the Done chip, no match', () => {
  const search = {
    query: 'lunch',
    count: 3,
    groups: [{ id: 'chat', name: 'Chat', rows: [row('a'), row('d', { done: true })] }, { id: 'rest', name: 'Rest', rows: [row('m', { src: 'mail' })] }],
    done: [{ key: 'p.mail\u0000old', source: 'p.mail', id: 'old', title: 'Lunch last week', done: true }],
  }
  const s = stateOf({ search, groups: [group('rest', [], { collapsed: true })], sources: [source('p.chat'), source('p.mail')] })
  const m = R.viewModel(s, { filter: 'all', open: { rest: false } })
  assert.equal(m.kind, 'search')
  assert.deepEqual(m.groups.map((g) => [g.id, g.open, g.rows.map((r) => r.id)]), [['chat', true, ['a', 'd']], ['rest', true, ['m']]])
  assert.deepEqual(m.done.map((e) => e.id), ['old'])
  assert.deepEqual(R.selectableKeys(m), ['p.chat\u0000a', 'p.chat\u0000d', 'p.mail\u0000m', 'p.mail\u0000old'])
  // A bare Done hit takes its source's badge, colour and label; the header counts what is drawn.
  assert.deepEqual(R.doneRowModel(m.done[0]).badge, 'X')
  assert.equal(R.doneRowModel(m.done[0]).source, 'mail')
  assert.equal(R.searchHeader(m), '4 found for “lunch”')
  assert.equal(R.searchHeader(R.viewModel(s, { filter: 'p.mail' })), '2 found for “lunch”')
  assert.equal(R.searchHeader({ drawn: 4, query: 'q', cut: 6 }), '4 found for “q”, 6 more not shown: narrow the search')
  assert.deepEqual(R.viewModel(s, { filter: 'p.mail' }).groups.map((g) => g.id), ['rest'])
  const doneOnly = R.viewModel(s, { filter: 'done' })
  assert.deepEqual(doneOnly.groups.map((g) => g.rows.map((r) => r.id)), [['d']])
  assert.deepEqual(doneOnly.done.map((e) => e.id), ['old'])
  const none = R.viewModel(stateOf({ search: { query: 'zzz', count: 0, groups: [], done: [] }, sources: [source('p.chat')] }), { filter: 'all' })
  assert.equal(none.empty, 'No match for “zzz”.')
})

test('empty states: no source, loading, inbox zero, nothing from one source', () => {
  assert.match(R.viewModel(stateOf(), { filter: 'all' }).empty, /^No source yet/)
  assert.equal(R.viewModel(stateOf({ sources: [source('p.chat', { loaded: false })] }), { filter: 'all' }).empty, 'loading')
  assert.equal(R.viewModel(stateOf({ sources: [source('p.chat')] }), { filter: 'all' }).empty, 'Inbox zero: nothing needs you.')
  const s = stateOf({ groups: [group('now', [row('a')])], sources: [source('p.chat'), source('p.mail', { label: 'Mail' })] })
  assert.equal(R.viewModel(s, { filter: 'p.mail' }).empty, 'Nothing from Mail.')
  assert.equal(R.viewModel(s, { filter: 'all' }).empty, null)
})

test('keys: j/k move, Enter opens, e done, s menu then 1-4, Esc, u undo, / search', () => {
  const keys = ['a', 'gone', 'b', 'nope']
  const rowOf = (k) => (k === 'gone' ? { done: true, canOpen: false } : k === 'nope' ? { canOpen: false } : { canOpen: true })
  const A = (ui, key, mods) => R.keyAction({ menu: null, searching: false, ...ui }, key, keys, rowOf, mods)
  assert.deepEqual(A({ sel: 'a' }, 'j'), { type: 'select', key: 'gone' })
  assert.deepEqual(A({ sel: 'a' }, 'ArrowDown'), { type: 'select', key: 'gone' })
  assert.deepEqual(A({ sel: 'nope' }, 'j'), { type: 'select', key: 'nope' })
  assert.deepEqual(A({ sel: 'a' }, 'k'), { type: 'select', key: 'a' })
  assert.deepEqual(A({ sel: null }, 'j'), { type: 'select', key: 'a' })
  assert.deepEqual(A({ sel: 'b' }, 'Enter'), { type: 'open', key: 'b' })
  assert.equal(A({ sel: 'nope' }, 'Enter'), null, 'an item with no open action does not open')
  assert.deepEqual(A({ sel: 'b' }, 'e'), { type: 'done', key: 'b' })
  assert.deepEqual(A({ sel: 'b' }, 's'), { type: 'menu', key: 'b' })
  assert.equal(A({ sel: 'gone' }, 'e'), null, 'a Done entry is not done again')
  assert.equal(A({ sel: 'gone' }, 's'), null)
  assert.deepEqual(A({ sel: 'b', menu: 'b' }, '3'), { type: 'snooze', key: 'b', choice: 'tomorrow' })
  assert.deepEqual(A({ sel: 'b', menu: 'b' }, '1'), { type: 'snooze', key: 'b', choice: '1h' })
  assert.deepEqual(A({ sel: 'b', menu: 'b' }, 'Escape'), { type: 'closeMenu' })
  assert.equal(A({ sel: 'b', menu: 'b' }, 'e'), null)
  assert.deepEqual(A({ sel: 'b' }, 'u'), { type: 'undo' })
  assert.deepEqual(A({ sel: 'b' }, '/'), { type: 'search' })
  assert.deepEqual(A({ sel: 'b', searching: true }, 'Escape'), { type: 'leaveSearch' })
  assert.equal(A({ sel: 'b' }, 'Escape'), null)
  assert.equal(A({ sel: 'b' }, 'e', { ctrl: true }), null)
  assert.equal(A({ sel: 'b' }, '/', { meta: true }), null)
  assert.equal(R.keyAction({ sel: null, menu: null }, 'j', [], rowOf), null)
  // After a row leaves, the one now at its place.
  assert.equal(R.nextSelection(['a', 'b', 'c'], 'b', ['a', 'c']), 'c')
  assert.equal(R.nextSelection(['a', 'b', 'c'], 'c', ['a', 'b']), 'b')
  assert.equal(R.nextSelection(['a'], 'a', []), null)
})

test('the snooze menu: v1 choices, the afternoon one says tomorrow once passed', () => {
  assert.deepEqual(R.snoozeChoices(NOW).map((c) => [c.key, c.choice, c.label]), [
    ['1', '1h', '1 hour'],
    ['2', 'afternoon', 'This afternoon, 14:00'],
    ['3', 'tomorrow', 'Tomorrow 9:00'],
    ['4', 'changes', 'Until it changes'],
  ])
  assert.equal(R.snoozeChoices(Date.parse('2026-11-03T15:00:00+01:00'))[1].label, 'Tomorrow afternoon, 14:00')
})

test('the time column: now, minutes, hours the same day, Yesterday, the weekday, the date, another year', () => {
  // NOW is Tue 3 Nov 2026, 13:42 in Berlin (process TZ above): every boundary in local time.
  const at = (s) => Date.parse(s)
  const W = (s) => R.whenText(at(s), NOW)
  assert.equal(R.whenText(NOW, NOW), 'now')
  assert.equal(R.whenText(NOW - 59 * 1000, NOW), 'now')
  assert.equal(R.whenText(NOW - MIN, NOW), '1m')
  assert.equal(R.whenText(NOW - 59 * MIN, NOW), '59m')
  assert.equal(R.whenText(NOW - HOUR, NOW), '1h')
  assert.equal(W('2026-11-03T00:00:00+01:00'), '13h', 'local midnight is still today')
  assert.equal(W('2026-11-02T23:59:00+01:00'), 'Yesterday', 'one minute before local midnight')
  assert.equal(W('2026-11-02T00:00:00+01:00'), 'Yesterday')
  assert.equal(W('2026-11-01T23:59:00+01:00'), 'Sun')
  assert.equal(W('2026-10-28T00:00:00+01:00'), 'Wed', '6 days back: a weekday')
  assert.equal(W('2026-10-27T23:59:00+01:00'), '27 Oct', '7 days back: the date (the same weekday would repeat)')
  // Over the DST change (25 Oct, a 25 hour day): still counted in calendar days.
  assert.equal(W('2026-10-25T01:00:00+02:00'), '25 Oct')
  assert.equal(R.whenText(at('2026-10-29T12:00:00+01:00'), at('2026-10-30T00:30:00+01:00')), 'Yesterday', 'at 00:30 a message of noon is Yesterday, not 12h')
  assert.equal(R.whenText(at('2026-10-29T23:50:00+01:00'), at('2026-10-30T00:30:00+01:00')), '40m')
  assert.equal(W('2026-01-01T00:00:00+01:00'), '1 Jan')
  assert.equal(W('2025-12-31T23:59:00+01:00'), '31 Dec 2025')
  assert.equal(R.whenText(at('2025-11-03T10:00:00+01:00'), NOW), '3 Nov 2025')
  // A time ahead (a clock a little off): now today, else its date.
  assert.equal(R.whenText(NOW + 5 * MIN, NOW), 'now')
  assert.equal(W('2026-11-05T10:00:00+01:00'), '5 Nov')
  for (const bad of [null, undefined, NaN, Infinity, '1']) assert.equal(R.whenText(bad, NOW), '')
})

test('the time column\'s hover and the clocks', () => {
  assert.equal(R.fullTimeText(Date.parse('2026-11-06T09:21:00+01:00')), 'Fri 6 Nov 2026, 09:21')
  assert.equal(R.fullTimeText(Date.parse('2025-03-01T00:05:00+01:00')), 'Sat 1 Mar 2025, 00:05')
  assert.equal(R.fullTimeText(null), '')
  assert.equal(R.clockText(NOW), '13:42')
})

test('hostile text stays plain strings; colours outside the palette become grey; no markup sink in the page', () => {
  const evil = '<img src=x onerror=alert(1)>'
  const m = R.rowModel(row('x', { title: evil, from: { name: evil }, preview: evil, labels: [evil], reason: evil, actions: [{ id: 'x', label: evil }], badge: evil }), NOW)
  assert.equal(m.title, evil)
  assert.ok(m.meta.startsWith(evil))
  assert.equal(m.preview, evil)
  assert.deepEqual(m.labels, [evil])
  assert.equal(m.actions[0].label, evil)
  assert.equal(R.colorName('red'), 'red')
  assert.equal(R.colorName('red; background:url(x)'), 'grey')
  assert.equal(R.colorName(undefined), 'grey')
  // Odd shapes from an older or broken host do not throw.
  assert.doesNotThrow(() => R.viewModel({ groups: 'x', sources: null, done: null }, { filter: 'all' }))
  assert.doesNotThrow(() => R.rowModel({ labels: 'x', actions: [null, 3, { id: 1 }], from: 'x', place: 7 }, NOW))
  // main.js builds every element with textContent: no markup sinks at all.
  const src = fs.readFileSync(path.join(__dirname, '..', 'panels', 'main.js'), 'utf8')
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  // Only the panel's own two scripts after the SDK; the v1 pieces are gone.
  const html = fs.readFileSync(path.join(__dirname, '..', 'panels', 'main.html'), 'utf8')
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1]), ['/__sdk/panel.js', 'rowlogic.js', 'main.js'])
  for (const gone of ['timeline.js', 'settings.js', 'settingslogic.js']) assert.equal(fs.existsSync(path.join(__dirname, '..', 'panels', gone)), false)
})

test('the components: the page uses the stylesheet classes and draws no control of its own where one fits', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'panels', 'main.js'), 'utf8')
  for (const cls of ['cc-row', 'cc-row-main', 'cc-row-title', 'cc-row-meta', 'cc-row-actions', 'cc-group', 'cc-group-title', 'cc-count', 'cc-chip', 'cc-badge', 'cc-error-line', 'cc-empty', 'cc-list', 'cc-spinner', 'cc-kbd']) {
    assert.ok(js.includes(cls), `${cls} used`)
  }
  assert.match(js, /el\('details', \{ class: 'cc-group'/)
  const html = fs.readFileSync(path.join(__dirname, '..', 'panels', 'main.html'), 'utf8')
  // No hard-coded colours: the theme tokens only.
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  assert.doesNotMatch(html, /!important/)
})

test('redraws wait while a mouse button is down, then run once after the click', () => {
  let draws = 0
  const later = []
  const g = R.createRenderGate(() => draws++, (fn) => later.push(fn))
  g.request()
  assert.equal(draws, 1)
  g.down()
  g.request()
  g.request()
  assert.equal(draws, 1, 'nothing replaced under the pointer')
  g.up()
  assert.equal(draws, 1, 'not before the click has run')
  later.shift()()
  assert.equal(draws, 2, 'one redraw for both requests')
  g.down()
  g.up()
  later.shift()()
  assert.equal(draws, 2, 'a press with no request draws nothing')
})
