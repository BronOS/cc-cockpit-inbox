'use strict'
// The source store (design-v2 "How it rides on the services mechanism"): one record per `inbox-feed`
// provider, kept in line with the provider set and the `item` / `gone` / `sync` events they emit.
//
// - A source is keyed by the `pluginId` the registry passes with every event and every provider
//   entry, never by a field in the data: a provider cannot place items under another source. Each
//   stored item gets `source` set from that id (`itemOf` drops any `source` the data carried).
// - `describe()` and `features()` are asked once per provider instance: from the moment a plugin id
//   joins the set until it leaves. A plugin that leaves and rejoins (disabled, reloaded, updated) is a
//   new instance, described again. A failed describe falls back to a name built from the id and is
//   asked again with the next `snapshot()` of that source.
// - `snapshot()` is asked when the store starts and for every provider that joins (`onChange`). While
//   a source's snapshot is pending its events are buffered and applied after it, in emit order, so an
//   older snapshot never overwrites a newer `item`. A throwing or late snapshot is that source's error
//   line only; the buffered events are still applied (they are newer than anything Inbox has).
// - `item` replaces the whole item, `gone` removes ids, `sync` replaces the set. A non-ok `sync`
//   (signedOut, error) keeps the last list, marked stale, with its message.
// - Everything coming in is checked by `feed.js` (`itemOf`, `goneOf`, `syncOf`); what they refuse
//   is counted on the source (`refused`, `overCap`), so a refusal shows on its line.
// Nothing here throws on a hostile provider: a bad answer is a state on that source.

const { CAPS, describeOf, featuresOf, itemOf, goneOf, syncOf } = require('./feed')
const { why, withTimeout } = require('./util')

const CALL_MS = 10000
// Events buffered for one source while its snapshot is pending. A provider that emits past this
// before answering its snapshot gets its buffer dropped and a second snapshot (bounded memory; the
// second snapshot is newer than every dropped event, so nothing is lost).
const MAX_BUFFER = 2000
const EVENTS = ['item', 'gone', 'sync']

/**
 * The store over `set` (`ctx.services.useAll('inbox-feed')`). `opts`: `log` ({ warn }), `onChange(pluginId)`
 * (after any change to a source: an event applied, a snapshot or describe answered, a source left), `callMs`
 * (per-call limit, default 10 s). Call `start()` once; `dispose()` unsubscribes.
 */
function createSources(set, opts = {}) {
  const log = opts.log || { warn() {} }
  const onChange = opts.onChange || (() => {})
  const callMs = opts.callMs ?? CALL_MS
  /** pluginId -> record (see `newRecord`) */
  const sources = new Map()
  const disposers = []
  let disposed = false

  const changed = (pluginId) => {
    if (disposed) return
    try {
      onChange(pluginId)
    } catch (e) {
      log.warn(`sources: change callback: ${why(e)}`)
    }
  }

  function newRecord(p) {
    return {
      pluginId: p.pluginId,
      handle: p.handle,
      desc: describeOf(undefined, p.pluginId),
      described: false,
      describing: null,
      features: new Set(),
      /** id -> item, each with `source` = pluginId */
      items: new Map(),
      state: 'ok',
      message: null,
      error: null,
      asOf: null,
      loaded: false,
      refused: 0,
      overCap: 0,
      /** null when no snapshot is pending, else the events that came meanwhile */
      buffer: null,
      overflow: false,
      pending: null,
    }
  }

  const live = (r) => !disposed && sources.get(r.pluginId) === r

  /** describe + features once per instance; a failure keeps the fallback and is asked again next snapshot. */
  function describeRecord(r) {
    if (r.described || r.describing) return r.describing || Promise.resolve()
    r.describing = Promise.all([
      withTimeout(r.handle.describe(), callMs, `${r.pluginId} describe`),
      withTimeout(r.handle.features(), callMs, `${r.pluginId} features`).catch(() => []),
    ]).then(
      ([d, f]) => {
        r.describing = null
        if (!live(r)) return
        r.desc = describeOf(d, r.pluginId)
        r.features = featuresOf(f)
        r.described = true
        changed(r.pluginId)
      },
      (e) => {
        r.describing = null
        if (live(r)) log.warn(`source ${r.pluginId} describe: ${why(e)}`)
      }
    )
    return r.describing
  }

  /** Keep at most CAPS.perSource items, the newest by `time`; the rest count in `overCap`. */
  function capItems(r) {
    if (r.items.size <= CAPS.perSource) return
    const keep = [...r.items.values()].sort((a, b) => b.time - a.time).slice(0, CAPS.perSource)
    r.overCap += r.items.size - keep.length
    r.items = new Map(keep.map((it) => [it.id, it]))
  }

  /** A checked Sync (from `syncOf`) applied to the record. */
  function applySync(r, s) {
    r.loaded = true
    r.state = s.state
    r.message = s.state === 'ok' ? null : s.message || null
    r.refused = s.refused
    r.overCap = s.overCap
    // A non-ok sync carries the last known list; an empty one keeps the list Inbox already has.
    if (s.state === 'ok' || s.items.length > 0) {
      r.items = new Map(s.items.map((it) => [it.id, { ...it, source: r.pluginId }]))
      if (s.asOf !== null) r.asOf = s.asOf
    }
    // An answer came: the error line was about a call that failed, this one did not.
    r.error = null
  }

  /** One event's raw data applied to the record (the record has no snapshot pending). */
  function applyEvent(r, event, data) {
    if (event === 'item') {
      const { item, refused } = itemOf(data)
      r.refused += refused
      if (!item) return
      r.items.set(item.id, { ...item, source: r.pluginId })
      capItems(r)
    } else if (event === 'gone') {
      const g = goneOf(data)
      // Ids past the 500 of one event are not applied: refused, like any part of an event Inbox cannot use.
      r.refused += g.refused + g.overCap
      for (const id of g.ids) r.items.delete(id)
    } else if (event === 'sync') {
      applySync(r, syncOf(data))
    }
  }

  /**
   * Ask the source's `snapshot()`; events meanwhile are buffered, then applied in order. One snapshot
   * per source at a time (a second call while one is pending shares it). Never rejects.
   */
  function snapshot(pluginId) {
    const r = sources.get(pluginId)
    if (!r || disposed) return Promise.resolve()
    if (r.pending) return r.pending
    r.buffer = []
    r.overflow = false
    const describing = describeRecord(r)
    r.pending = (async () => {
      let answer
      let failed = null
      try {
        answer = syncOf(await withTimeout(r.handle.snapshot(), callMs, `${pluginId} snapshot`))
      } catch (e) {
        failed = e
      }
      // The error line names the source by its described label, so wait for describe first.
      await describing
      if (!live(r)) return
      if (answer) applySync(r, answer)
      else {
        r.error = `${r.desc.label}: ${why(failed)}`
        log.warn(`source ${pluginId} snapshot: ${why(failed)}`)
      }
      const buffered = r.buffer
      const again = r.overflow
      r.buffer = null
      r.pending = null
      for (const [event, data] of buffered) applyEvent(r, event, data)
      changed(pluginId)
      if (again) await snapshot(pluginId)
    })()
    return r.pending
  }

  function onEvent(event, data, pluginId) {
    if (disposed || typeof pluginId !== 'string') return
    let r = sources.get(pluginId)
    if (!r) {
      // An event before the onChange that announces its provider: join it now (its snapshot covers
      // anything it emitted before Inbox subscribed), and buffer this event behind that snapshot.
      const p = providers().find((x) => x.pluginId === pluginId)
      if (!p) return
      r = join(p)
    }
    if (r.buffer) {
      if (r.buffer.length >= MAX_BUFFER) {
        r.buffer = []
        r.overflow = true
      }
      // `data` is the registry's own structured clone, so holding it is safe.
      r.buffer.push([event, data])
      return
    }
    applyEvent(r, event, data)
    changed(pluginId)
  }

  function providers() {
    try {
      const list = set.providers()
      return Array.isArray(list) ? list.filter((p) => p && typeof p.pluginId === 'string') : []
    } catch (e) {
      log.warn(`sources: providers: ${why(e)}`)
      return []
    }
  }

  function join(p) {
    const r = newRecord(p)
    sources.set(p.pluginId, r)
    void snapshot(p.pluginId)
    return r
  }

  /** Bring the records in line with the providers now; resolves once the joined ones answered their snapshot. */
  async function sync() {
    if (disposed) return
    const list = providers()
    const ids = new Set(list.map((p) => p.pluginId))
    for (const id of [...sources.keys()]) {
      if (ids.has(id)) continue
      // A leaving provider takes its items with it; a late answer to its snapshot is dropped (`live`).
      sources.delete(id)
      changed(id)
    }
    const pending = []
    for (const p of list) {
      if (!sources.has(p.pluginId)) join(p)
      const r = sources.get(p.pluginId)
      if (r.pending) pending.push(r.pending)
    }
    await Promise.all(pending)
  }

  /** A plain view of one record, items newest first. */
  function view(r) {
    return {
      pluginId: r.pluginId,
      desc: { ...r.desc },
      features: new Set(r.features),
      items: [...r.items.values()].sort((a, b) => b.time - a.time),
      state: r.state,
      message: r.message,
      error: r.error,
      // A list Inbox cannot vouch for: the source is not ok, or its last snapshot failed.
      stale: r.items.size > 0 && (r.state !== 'ok' || r.error !== null),
      asOf: r.asOf,
      loaded: r.loaded,
      pending: r.pending !== null,
      refused: r.refused,
      overCap: r.overCap,
    }
  }

  return {
    /** Subscribe and read every provider now; resolves once their snapshots answered. */
    start() {
      if (disposers.length || disposed) return sync()
      for (const event of EVENTS) disposers.push(set.on(event, (data, pluginId) => onEvent(event, data, pluginId)))
      disposers.push(set.onChange(() => void sync().catch((e) => log.warn(`sources: sync: ${why(e)}`))))
      return sync()
    },
    sync,
    snapshot,
    /** The handle to call `act` on, or null when the source is not in the set. */
    handle: (pluginId) => (sources.has(pluginId) ? sources.get(pluginId).handle : null),
    get: (pluginId) => (sources.has(pluginId) ? view(sources.get(pluginId)) : null),
    list: () => [...sources.values()].map(view),
    dispose() {
      disposed = true
      for (const d of disposers.splice(0)) {
        try {
          if (typeof d === 'function') d()
        } catch {}
      }
      sources.clear()
    },
  }
}

module.exports = { createSources, MAX_BUFFER }
