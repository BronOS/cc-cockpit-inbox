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
// - Unavailable (no `jev` provider, a cap reached, a rejected call, a missing or hostile answer): the
//   rule does not hold, nothing is cached, and the item is not asked again for 10 minutes. Its refs go
//   to `onAnswer` too (the row's reason changes from "Jev…" to "skipped: Jev unavailable").
// - `cachedAnswer()` is the settings page's "Test": cached answers only, never a request.
// - Two windows may both ask for an item before either wrote the cache: a duplicate request, the
//   same kind of answer, the last write wins (no compare-and-set in app storage, see state.js).

const crypto = require('node:crypto')

const PREFIX = 'jv:'
const TEXT_MAX = 1500
const BATCH = 100
const PACE_MS = 2000
const RETRY_MS = 10 * 60000
const KEEP_MS = 14 * 24 * 3600000
const SEEN_EVERY_MS = 24 * 3600000
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
  /** question → `{ queue: Map(cacheKey → request), inFlight: Map(cacheKey → request), timer, lastAt }`. */
  const lanes = new Map()
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
      Promise.resolve()
        .then(() => store.set(key, next))
        .catch(() => {})
    }
    return { score: e.score }
  }

  function laneOf(question) {
    let lane = lanes.get(question)
    if (!lane) {
      lane = { queue: new Map(), inFlight: new Map(), timer: null, lastAt: -Infinity }
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
      result = await handle.grid(grid, { [QID]: { type: 'noul', instructions: question } })
    } catch (e) {
      failed = e
      warn(`inbox: Jev unavailable for "${question.slice(0, 60)}": ${String((e && e.message) || e).slice(0, 200)}`)
    }
    const t = now()
    const refs = []
    for (const [i, r] of batch.entries()) {
      lane.inFlight.delete(r.key)
      refs.push({ pluginId: r.pluginId, id: r.id })
      const score = failed ? null : scoreOf(result, String(i))
      if (score === null) {
        blocked.set(r.key, t + RETRY_MS)
        continue
      }
      blocked.delete(r.key)
      const entry = { rev: r.rev, score, at: t, seen: t }
      cache.set(r.key, entry)
      try {
        await store.set(r.key, entry)
      } catch (e) {
        // The answer still counts in this window; another window asks for itself.
        warn(`inbox: could not cache a Jev answer: ${String((e && e.message) || e).slice(0, 200)}`)
      }
    }
    if (disposed) return
    try {
      onAnswer(refs)
    } catch {}
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
    if (!available()) return 'unavailable'
    const rev = revOf(item)
    const until = blocked.get(key)
    if (until !== undefined && now() < until) return 'unavailable'
    if (until !== undefined) blocked.delete(key)
    const lane = laneOf(question)
    const flying = lane.inFlight.get(key)
    if (flying && flying.rev === rev) return 'pending'
    const queued = lane.queue.get(key)
    // A newer rev replaces the queued one (only the latest content is worth asking about).
    if (!queued || queued.rev !== rev) lane.queue.set(key, { key, rev, pluginId: item.source, id: item.id, text: textOf(item) })
    arm(question, lane)
    return 'pending'
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
    for (const lane of lanes.values()) if (lane.timer !== null) T.clear(lane.timer)
    lanes.clear()
  }

  /** Requests waiting or in flight, for tests and the host's status. */
  const pending = () => [...lanes.values()].reduce((n, l) => n + l.queue.size + l.inFlight.size, 0)

  return { load, answer, cachedAnswer, prune, dispose, pending, available }
}

module.exports = { createJev, cacheKey, textOf, scoreOf, PREFIX, TEXT_MAX, BATCH, PACE_MS, RETRY_MS, KEEP_MS }
