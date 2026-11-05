'use strict'
// Jev rule conditions (design-v2 "Jev conditions"): the `jevAnswer(rule, item)` rules.js takes, with
// the cache, the batching and the "unavailable" handling behind it.
//
// - The answer is a `noul` score 0..1 for the rule's question over `title + "\n" + preview` (cut to
//   1500 characters), asked through `ctx.services.use('jev').grid(...)`, resolved on every call (the
//   app's rule: never a cached provider handle).
// - Cached in ctx.appStorage per question and item: `jv:<hash(question)>:<hash(pluginId, id)>` →
//   `{ rev, score, at, seen }`. The `rev` is the item's content version: a new rev (a reply, a new
//   comment) asks again, a read or label change does not touch rev and so does not. The threshold
//   is not in the key: changing `min` needs no new answer; editing the question text does (new hash).
//   `seen` is the "last used" date for the prune (Done's 14 days), bumped at most once a day: the
//   key is hashed, so the entry cannot be matched to a live item any other way.
// - `answer()` is synchronous (rules run in one pass): a cache hit is `{ score }`, a miss queues the
//   item and is `'pending'` (the rule does not hold, the row shows "Jev…"). Pending items are asked
//   in batches, one `grid` per question at a time and at most one every 2 s, 100 items a call. When
//   answers arrive `onAnswer(refs)` tells the host which items to place again: the item moves once,
//   then stays (its answer is cached).
// - Unavailable (no `jev` provider, a cap reached, a rejected call, a call past 45 s, a missing or
//   hostile answer): the rule does not hold, nothing is cached, and the item is not asked again for
//   10 minutes. Its refs go to `onAnswer` too (the row's reason changes from "Jev…" to "skipped: Jev
//   unavailable"), and again when the 10 minutes are up, so the host re-places it and it is asked
//   again (the host re-runs an item only on its own event or an answer, never on a timer).
// - No provider (or a full queue) parks the item: every minute a check (free, no call) looks whether
//   the `jev` service is there now and hands the parked refs to `onAnswer` (enabling the Jev plugin
//   makes the rules work within a minute, with no event to hear: `available` has none).
// - `sweep(run)` around a placement of every item: queued requests nothing in that pass asked for
//   (an item that left the feed, a question edited or deleted) are dropped, never asked.
// - `cachedAnswer()` is the settings page's "Test": cached answers only, never a request.
// - Two windows may both ask for an item before either wrote the cache: a duplicate request, the
//   same kind of answer, the last write wins (no compare-and-set in app storage, see state.js).

const crypto = require('node:crypto')

const PREFIX = 'jv:'
const TEXT_MAX = 1500
const BATCH = 100
const PACE_MS = 2000
const RETRY_MS = 10 * 60000
const { KEEP_MS, SEEN_EVERY_MS } = require('./util')
// The services layer sets no deadline ("a consumer races its own"): a grid that never settles would
// hold its lane's in-flight slot for good, so no further batch of that question would ever go.
const CALL_TIMEOUT_MS = 45000
// Per question: past this many waiting requests an item is parked, not queued (a bound on memory and
// on the calls one placement can start; the feed holds at most 500 items a source).
const QUEUE_MAX = 2000
const PARK_CHECK_MS = 60000
const QID = 'q'

const hash = (s, n) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n)

/** The cache key of one question over one item (52 characters, inside the store's key rule). */
function cacheKey(question, pluginId, id) {
  return `${PREFIX}${hash(String(question), 16)}:${hash(`${pluginId}\u0000${id}`, 32)}`
}

/** What Jev reads: the title, a newline and the preview, cut to 1500 characters (not mid-pair). */
function textOf(item) {
  const title = typeof item.title === 'string' ? item.title : ''
  const preview = typeof item.preview === 'string' && item.preview ? item.preview : ''
  let text = preview ? `${title}\n${preview}` : title
  if (text.length > TEXT_MAX) {
    text = text.slice(0, TEXT_MAX)
    // A cut between the halves of a surrogate pair would leave a lone half (an emoji in a title).
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
  }
  return text
}

const isScore = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const isEntry = (v) => typeof v === 'object' && v !== null && typeof v.rev === 'string' && isScore(v.score) && Number.isFinite(v.at)
const revOf = (item) => (typeof item.rev === 'string' ? item.rev : '')

/**
 * The score in one grid result, or null: `results[gid].answers.q.noul`, a number 0..1. Anything
 * else (an `{ error }`, no entry, a string score, a value out of range) is unavailable.
 */
function scoreOf(result, gid) {
  const results = result && typeof result === 'object' ? result.results : null
  const r = results && typeof results === 'object' && Object.prototype.hasOwnProperty.call(results, gid) ? results[gid] : null
  const a = r && typeof r === 'object' && r.answers && typeof r.answers === 'object' ? r.answers[QID] : null
  const v = a && typeof a === 'object' ? a.noul : undefined
  return isScore(v) ? v : null
}

/**
 * The Jev conditions over one app-wide store.
 * - `store`: ctx.appStorage; `services`: ctx.services (only `use('jev')` and `available('jev')`).
 * - `onAnswer(refs)`: `[{ pluginId, id }]` whose answer (or unavailability) just changed.
 * - `now`, `timers` (`{ set(fn, ms), clear(t) }`) and `log` for tests and the host.
 */
function createJev({ store, services, onAnswer = () => {}, now = () => Date.now(), timers, log } = {}) {
  const T = timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) }
  const warn = (msg) => {
    try {
      if (log && typeof log.warn === 'function') log.warn(msg)
    } catch {}
  }
  /** cache key → `{ rev, score, at, seen }`, as of the last load plus this window's own answers. */
  let cache = new Map()
  /** cache key → time before which it is not asked again (unavailable; a new rev waits too). */
  const blocked = new Map()
  /** question → `{ queue: Map(cacheKey → request), inFlight: Map(cacheKey → request), timer, callTimer, lastAt }`. */
  const lanes = new Map()
  /** The 10-minute retry timers of failed batches (cleared on dispose). */
  const retries = new Set()
  /** `pluginId \0 id` → ref of items refused for no provider or a full queue, for the minute check. */
  let parked = new Map()
  let parkTimer = null
  /** While `sweep` runs: `question \0 cacheKey` of every request a rule asked for, and the parked refs. */
  let marking = null
  let disposed = false

  function available() {
    try {
      if (!services) return false
      if (typeof services.available === 'function') return Boolean(services.available('jev'))
      return typeof services.use === 'function'
    } catch {
      return false
    }
  }

  async function load() {
    const started = now()
    const next = new Map()
    for (const k of await store.keys()) {
      if (!k.startsWith(PREFIX)) continue
      const v = await store.get(k)
      if (isEntry(v)) next.set(k, v)
    }
    // Answers this window got while the load ran stay (a slow load must not drop them).
    for (const [k, v] of cache) if (!next.has(k) && v.at >= started) next.set(k, v)
    cache = next
    return cache.size
  }

  /** A cached score for this rev, bumping `seen` at most once a day (best effort). */
  function hit(key, item) {
    const e = cache.get(key)
    if (!e || e.rev !== revOf(item)) return null
    const t = now()
    if (t - (e.seen || e.at) > SEEN_EVERY_MS) {
      const next = { rev: e.rev, score: e.score, at: e.at, seen: t }
      cache.set(key, next)
      // Read before writing: another window may have stored an answer for a newer rev meanwhile, and
      // writing the old rev back over it would cost that window a repeat request (a lost update).
      // Still not a compare-and-set (app storage has none), only a much shorter window.
      Promise.resolve()
        .then(() => store.get(key))
        .then((stored) => {
          if (isEntry(stored) && stored.rev !== next.rev) {
            if (cache.get(key) === next) cache.set(key, stored)
            return undefined
          }
          return store.set(key, next)
        })
        .catch(() => {})
    }
    return { score: e.score }
  }

  function notify(refs) {
    if (disposed || !refs.length) return
    try {
      onAnswer(refs)
    } catch {}
  }

  /** Park an item for the minute check (no provider, or its question's queue is full). */
  function park(item) {
    const k = `${item.source}\u0000${item.id}`
    const ref = { pluginId: item.source, id: item.id }
    parked.set(k, ref)
    if (marking) marking.parked.set(k, ref)
    armPark()
  }

  function armPark() {
    if (disposed || parkTimer !== null || !parked.size) return
    parkTimer = T.set(() => {
      parkTimer = null
      if (!available()) return armPark()
      const refs = [...parked.values()]
      parked = new Map()
      notify(refs)
    }, PARK_CHECK_MS)
  }

  function laneOf(question) {
    let lane = lanes.get(question)
    if (!lane) {
      lane = { queue: new Map(), inFlight: new Map(), timer: null, callTimer: null, lastAt: -Infinity }
      lanes.set(question, lane)
    }
    return lane
  }

  /** Arm the lane's timer: at once for a fresh lane, else 2 s after its last call; never beside a call in flight. */
  function arm(question, lane) {
    if (disposed || lane.timer !== null || lane.inFlight.size || !lane.queue.size) return
    const wait = Math.max(0, lane.lastAt + PACE_MS - now())
    lane.timer = T.set(() => {
      lane.timer = null
      flush(question, lane)
    }, wait)
  }

  async function flush(question, lane) {
    if (disposed) return
    const batch = [...lane.queue.values()].slice(0, BATCH)
    if (!batch.length) return
    for (const r of batch) {
      lane.queue.delete(r.key)
      lane.inFlight.set(r.key, r)
    }
    lane.lastAt = now()
    const grid = batch.map((r, i) => ({ id: String(i), text: r.text }))
    let result = null
    let failed = null
    try {
      const handle = services.use('jev')
      const timeout = new Promise((_, reject) => {
        lane.callTimer = T.set(() => reject(new Error(`no answer in ${CALL_TIMEOUT_MS / 1000} s`)), CALL_TIMEOUT_MS)
      })
      // A late answer or rejection of a timed-out call is dropped (race keeps it handled).
      result = await Promise.race([Promise.resolve(handle.grid(grid, { [QID]: { type: 'noul', instructions: question } })), timeout])
    } catch (e) {
      failed = e
      warn(`inbox: Jev unavailable for "${question.slice(0, 60)}": ${String((e && e.message) || e).slice(0, 200)}`)
    } finally {
      if (lane.callTimer !== null) T.clear(lane.callTimer)
      lane.callTimer = null
    }
    const t = now()
    const refs = []
    const retry = []
    const writes = []
    for (const [i, r] of batch.entries()) {
      lane.inFlight.delete(r.key)
      const ref = { pluginId: r.pluginId, id: r.id }
      refs.push(ref)
      const score = failed ? null : scoreOf(result, String(i))
      if (score === null) {
        blocked.set(r.key, t + RETRY_MS)
        retry.push(ref)
        continue
      }
      blocked.delete(r.key)
      const entry = { rev: r.rev, score, at: t, seen: t }
      cache.set(r.key, entry)
      // In parallel: a slow store must not hold the item's move for 100 serial writes.
      writes.push(
        Promise.resolve()
          .then(() => store.set(r.key, entry))
          .catch((e) => {
            // The answer still counts in this window; another window asks for itself.
            warn(`inbox: could not cache a Jev answer: ${String((e && e.message) || e).slice(0, 200)}`)
          }),
      )
    }
    await Promise.all(writes)
    if (disposed) return
    if (retry.length) {
      // When the 10 minutes are up, the host places these again and `answer` asks for them anew.
      const timer = T.set(() => {
        retries.delete(timer)
        notify(retry)
      }, RETRY_MS)
      retries.add(timer)
    }
    notify(refs)
    arm(question, lane)
  }

  /**
   * The `jevAnswer(rule, item)` of rules.js: `{ score }` when cached for this rev, `'unavailable'`
   * (no provider, or a failure in the last 10 minutes), else `'pending'` with the item queued.
   */
  function answer(rule, item) {
    const question = rule && rule.jev && rule.jev.question
    if (typeof question !== 'string' || !question) return 'unavailable'
    const key = cacheKey(question, item.source, item.id)
    const got = hit(key, item)
    if (got) return got
    if (!available()) {
      park(item)
      return 'unavailable'
    }
    const rev = revOf(item)
    const until = blocked.get(key)
    if (until !== undefined && now() < until) return 'unavailable'
    if (until !== undefined) blocked.delete(key)
    const lane = laneOf(question)
    const flying = lane.inFlight.get(key)
    if (flying && flying.rev === rev) {
      if (marking) marking.wanted.add(`${question}\u0000${key}`)
      return 'pending'
    }
    const queued = lane.queue.get(key)
    if (!queued && lane.queue.size >= QUEUE_MAX) {
      park(item)
      return 'unavailable'
    }
    // A newer rev replaces the queued one (only the latest content is worth asking about).
    if (!queued || queued.rev !== rev) lane.queue.set(key, { key, rev, pluginId: item.source, id: item.id, text: textOf(item) })
    if (marking) marking.wanted.add(`${question}\u0000${key}`)
    arm(question, lane)
    return 'pending'
  }

  /**
   * Run `run()` (a placement of every current item through `answer`) and then drop what it did not
   * ask for: queued requests of items that left the feed or of a question edited or deleted (never
   * asked: they would cost calls for nothing), and parked refs of items gone. Calls in flight finish.
   * A throw in `run` drops nothing. Returns what `run` returned.
   */
  function sweep(run) {
    const mark = { wanted: new Set(), parked: new Map() }
    const outer = marking
    marking = mark
    let out
    try {
      out = run()
    } finally {
      marking = outer
    }
    if (outer) {
      // A sweep inside a sweep: the outer one decides.
      for (const w of mark.wanted) outer.wanted.add(w)
      for (const [k, v] of mark.parked) outer.parked.set(k, v)
      return out
    }
    for (const [question, lane] of lanes) {
      for (const k of [...lane.queue.keys()]) if (!mark.wanted.has(`${question}\u0000${k}`)) lane.queue.delete(k)
      if (lane.queue.size || lane.inFlight.size) continue
      if (lane.timer !== null) T.clear(lane.timer)
      lanes.delete(question)
    }
    parked = mark.parked
    if (!parked.size && parkTimer !== null) {
      T.clear(parkTimer)
      parkTimer = null
    }
    return out
  }

  /**
   * Drop the queued requests and the parked ref of one item that left its feed. A full placement
   * does this in `sweep`; an incremental one (an `item`, `gone` or `sync` event) runs no sweep, so
   * without this a request queued for an item gone before its batch would still be asked. Calls in
   * flight finish (their answer is cached and costs nothing more).
   */
  function forget(pluginId, id) {
    for (const [question, lane] of lanes) {
      for (const [k, r] of [...lane.queue]) if (r.pluginId === pluginId && r.id === id) lane.queue.delete(k)
      if (lane.queue.size || lane.inFlight.size) continue
      if (lane.timer !== null) T.clear(lane.timer)
      lanes.delete(question)
    }
    for (const [k, v] of [...parked]) if (v.pluginId === pluginId && v.id === id) parked.delete(k)
  }

  /** "Test" on the settings page: the cached answer or `'pending'` (not asked yet); never a request. */
  function cachedAnswer(rule, item) {
    const question = rule && rule.jev && rule.jev.question
    if (typeof question !== 'string' || !question) return 'unavailable'
    const e = cache.get(cacheKey(question, item.source, item.id))
    if (e && e.rev === revOf(item)) return { score: e.score }
    return available() ? 'pending' : 'unavailable'
  }

  /** Drop answers not used for 14 days (with the Done entries, state.js `prune`). */
  async function prune() {
    const t = now()
    for (const [k, e] of [...cache]) {
      if (t - (e.seen || e.at) <= KEEP_MS) continue
      cache.delete(k)
      await store.delete(k)
    }
  }

  /** Stop every timer; answers that arrive later are dropped. */
  function dispose() {
    disposed = true
    for (const lane of lanes.values()) {
      if (lane.timer !== null) T.clear(lane.timer)
      if (lane.callTimer !== null) T.clear(lane.callTimer)
    }
    lanes.clear()
    for (const t of retries) T.clear(t)
    retries.clear()
    if (parkTimer !== null) T.clear(parkTimer)
    parkTimer = null
    parked.clear()
  }

  /** Requests waiting or in flight, for tests and the host's status. */
  const pending = () => [...lanes.values()].reduce((n, l) => n + l.queue.size + l.inFlight.size, 0)

  return { load, answer, cachedAnswer, sweep, forget, prune, dispose, pending, available }
}

module.exports = {
  createJev,
  cacheKey,
  textOf,
  scoreOf,
  PREFIX,
  TEXT_MAX,
  BATCH,
  PACE_MS,
  RETRY_MS,
  KEEP_MS,
  CALL_TIMEOUT_MS,
  QUEUE_MAX,
  PARK_CHECK_MS,
}
