'use strict'
// Done, snooze and undo (design "Done and snooze"), kept in ctx.appStorage: app-wide, so done in
// one window is done in all. App storage has no compare-and-set (each call is atomic, a get then a
// set is not, and nothing tells another window of a write), so there is no shared record to
// read-modify-write: **one key per item**. Two windows acting on different items never collide; on
// the same item the last write wins, which is the same intent either way. Another window's change
// is seen on the next `load()` (the host reloads every 60 s and when the panel comes into view).
//
// An entry: `{ pluginId, id, title, badge, kind: 'done' | 'snooze', rev, at, until (null: until it
// changes), seen, notified? }`. Rules:
// - done hides the item while its `rev` is the one stored; a new rev (a reply, a comment, a status
//   change) brings it back marked "back" until the person acts on it again or opens it;
// - snooze hides it until `until`, or until its rev changes ("until it changes", and a new reply
//   wakes any snooze early); once woken it gets the snooze-back bonus for the rest of that day;
// - an entry not seen for 14 days (its item gone from every feed) is dropped by `prune`.

const crypto = require('node:crypto')

const PREFIX = 'st:'
const KEEP_MS = 14 * 24 * 3600000
const SEEN_EVERY_MS = 24 * 3600000
// The store's key rule (`ccc guide api`): ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$.
const KEY_OK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PART_OK = /^[A-Za-z0-9._-]{1,200}$/

// The rank key of an item: one rule for both files.
const { keyOf: rankKey } = require('./rank')

/**
 * The storage key of an item: `st:<pluginId>:<id>` when that fits the store's rule, else
 * `st:h<hash>` (Chat message names have `/`, a long id or plugin id would pass 128 characters).
 * The entry itself carries the plugin id and the id, so a hashed key loses nothing.
 */
function storageKey(pluginId, id) {
  const plain = `${PREFIX}${pluginId}:${id}`
  if (PART_OK.test(pluginId) && PART_OK.test(id) && KEY_OK.test(plain)) return plain
  return `${PREFIX}h${crypto.createHash('sha256').update(`${pluginId}\u0000${id}`).digest('hex').slice(0, 40)}`
}

/** Local midnight that starts the day of `t` (DST-safe: built from the calendar date, not by subtracting hours). */
function startOfDay(t) {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** `hh:mm` on the day of `t` plus `addDays`, local time. */
function atTime(t, hhmm, addDays = 0) {
  const d = new Date(t)
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays, h, m).getTime()
}

/**
 * When a snooze choice ends: `1h`, `afternoon` (today at the afternoon time, or tomorrow's if that
 * has passed), `tomorrow` (the morning time tomorrow), `changes` (no time: until the item changes).
 */
function untilOf(choice, now, times = { afternoon: '14:00', morning: '09:00' }) {
  if (choice === '1h') return now + 3600000
  if (choice === 'afternoon') {
    const today = atTime(now, times.afternoon)
    return today > now ? today : atTime(now, times.afternoon, 1)
  }
  if (choice === 'tomorrow') return atTime(now, times.morning, 1)
  if (choice === 'changes') return null
  throw new Error(`inbox: unknown snooze "${choice}" (1h, afternoon, tomorrow or changes)`)
}

const isEntry = (v) =>
  typeof v === 'object' && v !== null && typeof v.pluginId === 'string' && typeof v.id === 'string' && (v.kind === 'done' || v.kind === 'snooze')

/** The state over one app-wide store. `store` is ctx.appStorage. */
function createState(store) {
  /** rank key -> entry, as of the last load (plus this window's own writes). */
  let entries = new Map()

  async function load() {
    const keys = (await store.keys()).filter((k) => k.startsWith(PREFIX))
    const next = new Map()
    for (const k of keys) {
      const v = await store.get(k)
      if (isEntry(v)) next.set(rankKey(v.pluginId, v.id), v)
    }
    entries = next
    return entries
  }

  async function write(entry) {
    const key = rankKey(entry.pluginId, entry.id)
    entries.set(key, entry)
    await store.set(storageKey(entry.pluginId, entry.id), entry)
  }

  async function remove(pluginId, id) {
    entries.delete(rankKey(pluginId, id))
    await store.delete(storageKey(pluginId, id))
  }

  /** What this entry says about the item now: hidden, its bonus, back with something new. */
  function judge(entry, item, now, bonus, doneReturns) {
    if (!entry) return { hidden: false, extra: 0, back: false }
    const changed = item.rev !== entry.rev
    if (entry.kind === 'done') return changed && doneReturns ? { hidden: false, extra: 0, back: true } : { hidden: true, extra: 0, back: false }
    // snooze
    const timeUp = entry.until !== null && entry.until !== undefined && now >= entry.until
    if (!changed && !timeUp) return { hidden: true, extra: 0, back: false }
    const wokeAt = timeUp ? entry.until : now
    const today = now < startOfDay(wokeAt) + 24 * 3600000 && now >= startOfDay(wokeAt)
    return { hidden: false, extra: today ? bonus : 0, back: changed }
  }

  /**
   * The `state` argument of rank.js for this moment. `doneReturns: false` (the setting "A done item
   * comes back when it changes" off) keeps a done item hidden whatever happens to it.
   */
  function view(now, bonus, { doneReturns = true } = {}) {
    const at = (key, item) => judge(entries.get(key), item, now, bonus, doneReturns)
    return { hidden: (k, it) => at(k, it).hidden, extra: (k, it) => at(k, it).extra, back: (k, it) => at(k, it).back }
  }

  /** Mark a row done (at its current rev). Returns the undo token: the entry it replaced, or none. */
  async function done(row, now) {
    const prev = entries.get(rankKey(row.pluginId, row.id)) || null
    await write({ pluginId: row.pluginId, id: row.id, title: row.title, badge: row.badge, kind: 'done', rev: row.rev, at: now, seen: now })
    return { pluginId: row.pluginId, id: row.id, prev }
  }

  /** Snooze a row until `until` (ms) or until it changes (`until` null). Returns the undo token. */
  async function snooze(row, until, now) {
    const prev = entries.get(rankKey(row.pluginId, row.id)) || null
    await write({ pluginId: row.pluginId, id: row.id, title: row.title, badge: row.badge, kind: 'snooze', rev: row.rev, at: now, until: until ?? null, seen: now })
    return { pluginId: row.pluginId, id: row.id, prev }
  }

  /** Put an item back in the inbox (the "Back to inbox" button, opening a "back" item). */
  async function restore(pluginId, id) {
    if (entries.has(rankKey(pluginId, id))) await remove(pluginId, id)
  }

  /** Undo a done or snooze: the entry before it comes back (or none). */
  async function undo(token) {
    if (!token) return
    if (token.prev) await write(token.prev)
    else await remove(token.pluginId, token.id)
  }

  /**
   * Snoozes whose time is up and that were not announced yet: the host notifies once per entry
   * (`notified` is written, so another window that also sees it reads it on its next load; a
   * second notification from a window that had not loaded yet is the accepted worst case).
   */
  function woken(now) {
    return [...entries.values()].filter((e) => e.kind === 'snooze' && e.until !== null && e.until !== undefined && now >= e.until && !e.notified)
  }
  async function markNotified(entry) {
    await write({ ...entry, notified: true })
  }

  /** Best-effort "last seen" bumps for listed items: at most one write a day per entry. */
  async function touch(items, now) {
    for (const { pluginId, id } of items) {
      const e = entries.get(rankKey(pluginId, id))
      if (e && now - (e.seen || 0) > SEEN_EVERY_MS) await write({ ...e, seen: now }).catch(() => {})
    }
  }

  /** Drop entries no feed has listed for 14 days. */
  async function prune(now) {
    for (const e of [...entries.values()]) if (now - (e.seen || e.at || 0) > KEEP_MS) await remove(e.pluginId, e.id)
  }

  /** Today's done and snoozed items, newest first (the "Done & snoozed" view). */
  function today(now) {
    const from = startOfDay(now)
    return [...entries.values()]
      .filter((e) => e.at >= from || (e.kind === 'snooze' && (e.until === null || e.until === undefined || e.until > now)))
      .sort((a, b) => b.at - a.at)
  }

  return { load, view, done, snooze, restore, undo, woken, markNotified, touch, prune, today, entries: () => entries }
}

module.exports = { createState, storageKey, untilOf, startOfDay, rankKey, KEEP_MS }
