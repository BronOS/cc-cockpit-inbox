'use strict'
// Inbox (bronos.inbox) 0.2.0: one list of every `inbox-feed` v2 provider, placed by the person's rules
// (docs/design-v2.md). The host wires the pieces and owns no logic of its own beyond that:
//
//   sources (lib/sources.js: snapshot, item / gone / sync events)
//     → rules (lib/rules.js, Jev answers from lib/jev.js) → groups → one `state` message to the panel
//   Done and snooze (lib/state.js), search (lib/search.js), settings (lib/settings.js), `ccc inbox` (lib/cli.js)
//
// Placement: an item keeps its placement until something about it changes, so the list does not move
// under the person's hand. Rules re-run for one item when its source sends a new copy of it (`item`, or
// a `sync` that replaces the set) and when its Jev answer comes in (`onAnswer`: an answer, the
// 10-minute retry of an unavailable one, a `jev` provider appearing). Every item is placed again only
// when the rules change or a source joins or leaves, and that full placement runs inside `jev.sweep`
// so Jev requests still queued for items gone or questions edited are dropped, never asked.
//
// Done is Inbox's own memory and never calls the source (design-v2 "Inbox's own memory"): marking read
// is the source's action, offered beside it. Every other action, `open` included, goes back to the
// source as `act(id, action)` on the `useAll` handle of the item's own plugin; the host checks the
// action is one the item lists and shows the source's `message` when it refuses.
//
// Actions from the panel and the overlay toolbar name an item by its key (`pluginId \0 id`); the host
// looks it up in what the sources gave and never takes an id, a rev or an action list from a page.

const { actReplyOf } = require('./lib/feed')
const { createSources } = require('./lib/sources')
const { createJev } = require('./lib/jev')
const { createState, untilOf } = require('./lib/state')
const { placeItem, keyOf, byTime, REST } = require('./lib/rules')
const { search } = require('./lib/search')
const S = require('./lib/settings')
const CLI = require('./lib/cli')

const PANEL = 'main'
const FEED = 'inbox-feed'
const ITEM_TYPE = 'inbox-item'
const DONE_BUTTON = 'inbox-done'
const CALL_MS = 10000
// How long `ccc inbox` waits for the first read (the plugin command limit is 30 s).
const CLI_WAIT_MS = 20000
const REFRESH_S = 60
const UNDO_MS = 6000
// Jev answers of other windows are read this often (every answer is its own key: a full read is one
// call per cached answer, so not every minute like the Done entries). A missed one costs a duplicate
// request, never a different order.
const JEV_LOAD_MS = 10 * 60000
const AGENDA_HEIGHT = 140
// The panel message stays well under the 1 MiB post limit with 1000 items per source: rows per
// group, Done entries and search results are capped (the counts go with them), previews cut.
const ROWS_SHOWN = 200
const PREVIEW_SHOWN = 200
const MAX_QUERY = 200
// A snooze that ended while the app was closed is not announced when it opens: only one that ended
// in the last 15 minutes, and at most 3 a refresh (the app caps notifications at 10 a minute).
const NOTIFY_WITHIN_MS = 15 * 60000
const NOTIFY_MAX = 3
const SNOOZES = new Set(['1h', 'afternoon', 'tomorrow', 'changes'])
// v1's default times (v1 had a setting for them; v2's settings hold groups, rules and the agenda only).
const SNOOZE_TIMES = { afternoon: '14:00', morning: '09:00' }
const OLD_APP = 'Inbox 0.2.0 needs cc-cockpit 0.10.0 or newer (slots, overlay buttons and the services collector). Update the app.'

// What a failed panel action is called in its notice: the button's words, not the message type.
const ACTION_NAMES = { open: 'Open', done: 'Done', snooze: 'Snooze', undo: 'Undo', restore: 'Back to Inbox', refresh: 'Refresh', act: 'That action' }

const why = (e) => String((e && e.message) || e || 'failed').slice(0, 300)
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const cut = (s, max) => (typeof s === 'string' && s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** `p`, or a rejection after `ms` (a provider that never answers must not hold an action). */
function withTimeout(p, ms, what) {
  let t
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms)
    }),
  ])
}

/** Does this app have what Inbox 0.2.0 builds on (0.10.0: the collector, slots, overlay type buttons)? */
function appIsNew(ctx) {
  return (
    typeof (ctx.services && ctx.services.useAll) === 'function' &&
    typeof ctx.slots === 'object' &&
    ctx.slots !== null &&
    typeof (ctx.overlay && ctx.overlay.buttons) === 'function'
  )
}

/**
 * The Inbox host. `opts` exists for tests: `now` (clock), `callMs` (per-call limit of the sources and
 * of `act`), `jevTimers` (`{ set, clear }` for lib/jev.js), `cliWaitMs`.
 */
function createInbox(ctx, opts = {}) {
  const now = opts.now || Date.now
  const callMs = opts.callMs ?? CALL_MS
  const disposers = []
  let disposed = false

  if (!appIsNew(ctx)) {
    // An older app may still load Inbox (it ignores manifest keys it does not know): say what to do.
    ctx.log.warn(OLD_APP)
    const fatal = () => ctx.panels.post(PANEL, { type: 'state', version: 2, fatal: OLD_APP })
    disposers.push(ctx.panels.onMessage(PANEL, fatal))
    try {
      fatal()
    } catch {}
    const nothing = async () => {}
    return { first: Promise.resolve(), tick: nothing, refresh: nothing, act: nothing, saveSettings: nothing, dispose: () => disposers.forEach((d) => typeof d === 'function' && d()) }
  }

  const call = (p, what) => withTimeout(p, callMs, what)
  const state = createState(ctx.appStorage)
  let settings = S.defaults()
  let settingsJson = JSON.stringify(settings)

  /** key → `{ item, placement }` of every visible item; an entry stays while its item object does. */
  const placed = new Map()
  /** Keys to place again on the next build (Jev answers). */
  const dirty = new Set()
  /** Place every item on the next build (start, rules change, a source joining or leaving). */
  let needFull = true
  let sourceIds = null
  /** The last build: groups of rows, every live item by key, the sources' views and descriptions. */
  let view = { groups: [], live: new Map(), list: [], descs: new Map() }
  let started = false
  let updatedAt = null
  let lastUndo = null
  let lastBadge
  let lastHeader = ''
  let lastAgenda
  let query = ''
  let jevLoadedAt = -Infinity
  let publishQueued = false
  let ticking = null

  const sources = createSources(ctx.services.useAll(FEED), {
    log: ctx.log,
    callMs,
    onChange: () => {
      updatedAt = now()
      schedulePublish()
    },
  })
  const jev = createJev({
    store: ctx.appStorage,
    services: ctx.services,
    now,
    timers: opts.jevTimers,
    log: ctx.log,
    onAnswer: (refs) => {
      for (const r of refs) dirty.add(keyOf(r.pluginId, r.id))
      schedulePublish()
    },
  })

  // ---- placement ----

  /**
   * Bring `view` in line with the sources, the Done memory and the rules. Visible items keep their
   * placement unless their object changed (a new copy from the source) or they are dirty; a full
   * placement drops them all and runs inside `jev.sweep`.
   */
  function build(t) {
    const list = sources.list()
    const descs = new Map(list.map((s) => [s.pluginId, s.desc]))
    const ids = list.map((s) => s.pluginId).sort().join('\u0000')
    if (ids !== sourceIds) {
      sourceIds = ids
      needFull = true
    }
    const live = new Map()
    for (const s of list) for (const it of s.items) live.set(keyOf(s.pluginId, it.id), it)
    const o = { now: t, kindOf: (id) => (descs.get(id) || {}).kind, jevAnswer: jev.answer }
    const full = needFull
    const run = () => {
      if (full) placed.clear()
      for (const k of dirty) placed.delete(k)
      const visible = []
      for (const [key, item] of live) {
        const st = state.status(item, t)
        if (st.hidden) {
          // Placed again when it comes back (a woken snooze, an undo): the rules decide where.
          placed.delete(key)
          continue
        }
        let p = placed.get(key)
        if (!p || p.item !== item) {
          p = { item, placement: placeItem(settings, item, o) }
          placed.set(key, p)
        }
        visible.push({ key, item, placement: p.placement, back: st.back })
      }
      for (const key of [...placed.keys()]) if (!live.has(key)) placed.delete(key)
      return visible
    }
    const visible = full ? jev.sweep(run) : run()
    needFull = false
    dirty.clear()
    const groups = settings.groups.map((g) => ({ ...g, rows: [] }))
    if (!groups.some((g) => g.id === REST)) groups.push({ id: REST, name: 'Rest', collapsed: true, badge: false, rows: [] })
    const at = new Map(groups.map((g) => [g.id, g]))
    for (const r of visible) (at.get(r.placement.group) || at.get(REST)).rows.push(r)
    for (const g of groups) g.rows.sort(byTime)
    view = { groups, live, list, descs }
    return view
  }

  const descOf = (pluginId) => view.descs.get(pluginId) || { label: pluginId, badge: 'FEED', color: 'grey', kind: 'other' }

  /** One row as the panel draws it: plain data, text only, the actions minus `open` (the row click). */
  function rowOut(key, item, extra) {
    const d = descOf(item.source)
    const actions = item.actions || []
    return {
      key,
      source: item.source,
      id: item.id,
      title: item.title,
      ...(item.preview ? { preview: cut(item.preview, PREVIEW_SHOWN) } : {}),
      time: item.time,
      ...(item.from ? { from: item.from } : {}),
      ...(item.to ? { to: item.to } : {}),
      ...(item.place ? { place: item.place } : {}),
      labels: item.labels || [],
      read: item.read,
      mentionsMe: item.mentionsMe === true,
      actions: actions.filter((a) => a.id !== 'open'),
      canOpen: actions.some((a) => a.id === 'open'),
      badge: d.badge,
      color: d.color,
      label: d.label,
      ...extra,
    }
  }

  /** Search results grouped as the list is; Done and snoozed items marked, Done entries with no live item last. */
  function searchOut(t) {
    if (!query) return null
    const hits = search(query, [...view.live.values()], state.doneList(view.live))
    const groups = view.groups.map((g) => ({ id: g.id, name: g.name, rows: [] }))
    const at = new Map(groups.map((g) => [g.id, g]))
    const o = { now: t, kindOf: (id) => descOf(id).kind, jevAnswer: jev.cachedAnswer }
    const done = []
    for (const h of hits) {
      const key = keyOf(h.pluginId, h.id)
      if (!h.item) {
        done.push({ key, source: h.pluginId, id: h.id, title: h.title, done: true })
        continue
      }
      const p = placed.get(key)
      // A hidden item has no placement (Jev is never asked for it): placed here from cached answers only.
      const placement = p ? p.placement : placeItem(settings, h.item, o)
      const hidden = state.status(h.item, t).hidden
      ;(at.get(placement.group) || at.get(REST)).rows.push({ key, item: h.item, placement, done: h.done, snoozed: hidden && !h.done })
    }
    let shown = 0
    for (const g of groups) {
      g.rows.sort(byTime)
      g.rows = g.rows.slice(0, Math.max(0, ROWS_SHOWN - shown)).map((r) => rowOut(r.key, r.item, { reason: r.placement.reason, jev: r.placement.jev, done: r.done, snoozed: r.snoozed }))
      shown += g.rows.length
    }
    return { query, count: hits.length, groups: groups.filter((g) => g.rows.length), done: done.slice(0, Math.max(0, ROWS_SHOWN - shown)) }
  }

  /** The panel's whole state: groups, source lines, Done view, search, undo. */
  function snapshot(t) {
    const groups = view.groups.map((g) => ({
      id: g.id,
      name: g.name,
      collapsed: g.collapsed,
      badge: g.badge,
      count: g.rows.length,
      unread: g.rows.filter((r) => r.item.read === false).length,
      rows: g.rows.slice(0, ROWS_SHOWN).map((r) => rowOut(r.key, r.item, { reason: r.placement.reason, jev: r.placement.jev, back: r.back })),
    }))
    const shownBy = new Map()
    for (const g of view.groups) for (const r of g.rows) shownBy.set(r.item.source, (shownBy.get(r.item.source) || 0) + 1)
    const doneAll = state.doneList(view.live)
    return {
      type: 'state',
      version: 2,
      now: t,
      updatedAt,
      groups,
      sources: view.list.map((s) => ({
        pluginId: s.pluginId,
        label: s.desc.label,
        badge: s.desc.badge,
        color: s.desc.color,
        kind: s.desc.kind,
        ...(s.desc.scope ? { scope: s.desc.scope } : {}),
        state: s.state,
        message: s.message,
        error: s.error,
        stale: s.stale,
        asOf: s.asOf,
        loaded: s.loaded,
        refused: s.refused,
        overCap: s.overCap,
        count: s.items.length,
        shown: shownBy.get(s.pluginId) || 0,
      })),
      done: {
        count: doneAll.length,
        rows: doneAll.slice(0, ROWS_SHOWN).map((e) => {
          const d = descOf(e.pluginId)
          return { key: keyOf(e.pluginId, e.id), source: e.pluginId, id: e.id, title: e.title, at: e.at, live: e.live, badge: d.badge, color: d.color, label: d.label }
        }),
      },
      search: searchOut(t),
      undo: lastUndo && t < lastUndo.until ? { label: lastUndo.label, until: lastUndo.until } : null,
      agenda: settings.agenda,
    }
  }

  /** The panel badge: unread items in the groups marked `badge` (`read: null`, no read state, does not count). */
  function badgeOf() {
    let n = 0
    for (const g of view.groups) if (g.badge) for (const r of g.rows) if (r.item.read === false) n++
    return n > 0 ? n : null
  }

  /** The app's title bar of the panel: when a source last changed, and refresh (the app's gear opens the settings page). */
  function header() {
    if (typeof ctx.panels.header !== 'function') return
    const d = updatedAt ? new Date(updatedAt) : null
    const spec = {
      meta: d ? `updated ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'loading…',
      actions: [{ id: 'refresh', icon: 'refresh', title: 'Refresh every source' }],
    }
    const json = JSON.stringify(spec)
    if (json === lastHeader) return
    lastHeader = json
    try {
      ctx.panels.header(PANEL, spec)
    } catch (e) {
      ctx.log.warn(`panel header: ${why(e)}`)
    }
  }

  /** The agenda slot from the setting; placed again only when the setting changes. Inbox never reads the calendar. */
  function placeAgenda() {
    if (typeof ctx.panels.slots !== 'function') return
    const pos = settings.agenda
    if (pos === lastAgenda) return
    try {
      ctx.panels.slots(PANEL, pos === 'off' ? null : [{ type: 'agenda', position: pos, height: AGENDA_HEIGHT }])
      lastAgenda = pos
    } catch (e) {
      ctx.log.warn(`agenda slot: ${why(e)}`)
    }
  }

  function publish() {
    if (disposed || !started) return
    const t = now()
    build(t)
    header()
    try {
      ctx.panels.post(PANEL, snapshot(t))
    } catch (e) {
      ctx.log.error(`post: ${why(e)}`)
    }
    const b = badgeOf()
    if (b !== lastBadge) {
      lastBadge = b
      try {
        ctx.badge(PANEL, b)
      } catch (e) {
        ctx.log.warn(`badge: ${why(e)}`)
      }
    }
  }

  /** One publish for a burst of events and answers (each `item` of a burst would be one otherwise). */
  function schedulePublish() {
    if (publishQueued || disposed) return
    publishQueued = true
    queueMicrotask(() => {
      publishQueued = false
      publish()
    })
  }

  // ---- settings and shared state ----

  /** Settings that differ from the current ones: every item placed again, the agenda moved. */
  function applySettings(next) {
    const json = JSON.stringify(next)
    if (json === settingsJson) return
    settings = next
    settingsJson = json
    needFull = true
    placeAgenda()
    schedulePublish()
  }

  /** Validate and store settings (the settings page), applied in this window at once. Resolves what was stored. */
  async function saveSettings(raw) {
    const s = await S.saveSettings(ctx.appStorage, raw)
    applySettings(s)
    return s
  }

  /** What other windows may have written: settings, Done and snooze, now and then the Jev answers. */
  async function reloadShared() {
    try {
      applySettings(await S.loadSettings(ctx.appStorage))
    } catch (e) {
      ctx.log.warn(`settings: ${why(e)}`)
    }
    try {
      await state.load()
    } catch (e) {
      ctx.log.warn(`state: ${why(e)}`)
    }
    if (now() - jevLoadedAt >= JEV_LOAD_MS) {
      jevLoadedAt = now()
      try {
        await jev.load()
      } catch (e) {
        ctx.log.warn(`jev cache: ${why(e)}`)
      }
    }
  }

  async function announceWoken(t) {
    let sent = 0
    for (const e of state.woken(t)) {
      const fresh = t - e.until <= NOTIFY_WITHIN_MS && view.live.has(keyOf(e.pluginId, e.id))
      if (fresh && sent < NOTIFY_MAX) {
        sent++
        // Not awaited: notify resolves when the notification is shown, and a refresh must not wait.
        ctx.notify(e.title || 'A snoozed item is back', { title: 'Inbox: snooze ended' }).catch((err) => ctx.log.warn(`notify: ${why(err)}`))
      }
      // Marked either way: an old or gone one is never announced later.
      await state.markNotified(e).catch((err) => ctx.log.warn(`state: ${why(err)}`))
    }
  }

  /** Every minute: what other windows wrote, upkeep of the memory, woken snoozes. Sources push their own changes. */
  async function tick() {
    if (ticking) return ticking
    ticking = (async () => {
      await first
      await reloadShared()
      if (disposed) return
      const t = now()
      build(t)
      const listed = [...view.live.values()].map((it) => ({ pluginId: it.source, id: it.id }))
      await state.touch(listed, t).catch(() => {})
      await state.prune(t).catch((e) => ctx.log.warn(`prune: ${why(e)}`))
      await jev.prune().catch((e) => ctx.log.warn(`jev prune: ${why(e)}`))
      await announceWoken(t)
      publish()
    })().finally(() => {
      ticking = null
    })
    return ticking
  }

  /** The header's refresh: every source's `snapshot()` again. */
  async function refresh() {
    await first
    await Promise.all(sources.list().map((s) => sources.snapshot(s.pluginId)))
    await reloadShared()
    publish()
  }

  // ---- actions ----

  /** A live item by key (hidden or not), or null. */
  const liveByKey = (key) => (typeof key === 'string' ? view.live.get(key) || null : null)
  /** A live item not hidden by Done or snooze, or null. */
  const visibleByKey = (key) => {
    const it = liveByKey(key)
    return it && !state.status(it, now()).hidden ? it : null
  }
  const memoryRow = (it) => ({ pluginId: it.source, id: it.id, title: it.title, badge: descOf(it.source).badge, rev: it.rev })

  function setUndo(token, label, t) {
    lastUndo = { token, label, until: t + UNDO_MS }
  }

  /** Done in Inbox's memory only: the source is never called. Resolves the item, or null when there is none to mark. */
  async function markDone(key) {
    const it = visibleByKey(key)
    if (!it) return null
    const t = now()
    setUndo(await state.done(memoryRow(it), t), `Done: ${it.title}`, t)
    publish()
    return it
  }

  /**
   * One of the item's actions at its source: `act(id, action)` on its own plugin's handle. Refused here
   * when the item does not list the action (the source checks again). Resolves the source's reply with
   * the action's label.
   */
  async function runAction(key, action) {
    const it = liveByKey(key)
    if (!it) return { ok: false, message: 'that item is no longer in the Inbox' }
    const a = typeof action === 'string' ? (it.actions || []).find((x) => x.id === action) : null
    if (!a) return { ok: false, message: action === 'open' ? 'this item cannot be opened' : 'this item has no such action now' }
    const label = descOf(it.source).label
    const handle = sources.handle(it.source)
    if (!handle) return { ok: false, label: a.label, message: `${label} is no longer a source` }
    // Opening a "back" item or a woken snooze ends that mark (it was seen); a hidden one (opened from
    // the Done view or a search) stays done.
    // Decided before the act but applied after a successful one, so a failed or timed-out open keeps the mark.
    const endsMark = action === 'open' && !state.status(it, now()).hidden
    const reply = actReplyOf(await call(handle.act(it.id, action), `${label} ${action}`))
    if (endsMark && reply.ok) await state.restore(it.source, it.id)
    if (action === 'open') schedulePublish()
    return { ...reply, label: a.label }
  }

  function notice(text) {
    try {
      ctx.panels.post(PANEL, { type: 'notice', text })
    } catch {
      // the panel went away
    }
  }

  async function act(m) {
    const t = now()
    switch (m.type) {
      case 'hello':
      case 'visible':
        await first
        await reloadShared()
        publish()
        return
      case 'refresh':
        await refresh()
        return
      case 'open':
      case 'act': {
        const action = m.type === 'open' ? 'open' : m.action
        const reply = await runAction(m.key, action)
        if (!reply.ok) notice(`${reply.label || ACTION_NAMES[m.type]} failed: ${reply.message || 'the source refused'}`)
        return
      }
      case 'done':
        await markDone(m.key)
        return
      case 'snooze': {
        const it = visibleByKey(m.key)
        if (!it || !SNOOZES.has(m.choice)) return
        const until = untilOf(m.choice, t, SNOOZE_TIMES)
        setUndo(await state.snooze(memoryRow(it), until, t), `Snoozed: ${it.title}`, t)
        publish()
        return
      }
      case 'undo':
        if (lastUndo) {
          const { token } = lastUndo
          lastUndo = null
          await state.undo(token)
        }
        publish()
        return
      case 'restore': {
        // "Back to Inbox" in the Done view: the entry goes, the rules place the item again.
        const e = typeof m.key === 'string' ? state.entries().get(m.key) : null
        if (e) await state.restore(e.pluginId, e.id)
        publish()
        return
      }
      case 'search':
        query = typeof m.query === 'string' ? m.query.trim().slice(0, MAX_QUERY) : ''
        publish()
        return
      default:
    }
  }

  async function onPanelMessage(m) {
    if (!isObj(m) || typeof m.type !== 'string') return
    try {
      await act(m)
    } catch (e) {
      ctx.log.warn(`${m.type}: ${why(e)}`)
      notice(`${ACTION_NAMES[m.type] || 'That'} failed: ${why(e)}`)
    }
  }

  disposers.push(ctx.panels.onMessage(PANEL, onPanelMessage))
  if (typeof ctx.panels.onAction === 'function') {
    disposers.push(
      ctx.panels.onAction(PANEL, (id) => {
        if (id === 'refresh') void refresh().catch((e) => ctx.log.warn(`refresh: ${why(e)}`))
      })
    )
  }

  // "Done (Inbox)" in the toolbar of every `inbox-item` overlay of an item Inbox holds and shows. The
  // overlay's data came from its opener: only a key Inbox has itself gets the button.
  disposers.push(
    ctx.overlay.buttons(ITEM_TYPE, (info) => {
      const d = info && info.type && info.type.data
      if (!isObj(d) || typeof d.source !== 'string' || typeof d.id !== 'string') return []
      const key = keyOf(d.source, d.id)
      if (!visibleByKey(key)) return []
      return [{ id: DONE_BUTTON, label: 'Done (Inbox)', run: async () => ((await markDone(key)) ? { close: true } : undefined) }]
    })
  )
  disposers.push(ctx.schedule(REFRESH_S, () => tick()))

  const first = (async () => {
    await reloadShared()
    placeAgenda()
    await sources.start()
    started = true
    updatedAt = now()
    publish()
  })().catch((e) => {
    started = true
    ctx.log.error(`first read: ${why(e)}`)
  })

  // ---- `ccc inbox` (lib/cli.js; its v2 commands come with task 32) ----

  /** The list as `ccc inbox` numbers it: every group in order, the group's name in the level column. */
  function cliRows() {
    const out = []
    for (const g of view.groups) {
      for (const r of g.rows) out.push({ key: r.key, pluginId: r.item.source, id: r.item.id, title: r.item.title, badge: descOf(r.item.source).badge, level: g.name, at: r.item.time })
    }
    return out
  }

  if (ctx.cli && typeof ctx.cli.register === 'function') {
    const unregister = ctx.cli.register('inbox', async (argv) => {
      const p = CLI.parse(argv)
      if (p.error) return { stderr: `${p.error}\n`, code: 2 }
      if (p.cmd === 'help') return { stdout: CLI.HELP }
      // The first read has per-call timeouts; this deadline is the belt to them.
      let timer
      await Promise.race([first, new Promise((r) => (timer = setTimeout(r, opts.cliWaitMs ?? CLI_WAIT_MS)))])
      clearTimeout(timer)
      build(now())
      const rows = cliRows()
      if (p.cmd === 'list') return { stdout: CLI.formatList(rows, now()) }
      const got = CLI.resolve(rows, p.target)
      if (got.error) return { stderr: `${got.error}\n`, code: 1 }
      const row = got.row
      const title = CLI.oneLine(row.title, CLI.MAX_TITLE)
      try {
        if (p.cmd === 'open') {
          const reply = await runAction(row.key, 'open')
          if (!reply.ok) return { stderr: `open failed: ${CLI.oneLine(reply.message || 'the source refused', 300)}\n`, code: 1 }
          return { stdout: `Opened ${title}\n` }
        }
        if (p.cmd === 'done') {
          await markDone(row.key)
          return { stdout: `Done: ${title}\n` }
        }
        const until = untilOf(p.choice, now(), SNOOZE_TIMES)
        await act({ type: 'snooze', key: row.key, choice: p.choice })
        return { stdout: `Snoozed until ${until === null ? 'it changes' : CLI.when(until)}: ${title}\n` }
      } catch (e) {
        return { stderr: `${p.cmd} failed: ${why(e)}\n`, code: 1 }
      }
    })
    disposers.push(unregister)
  }

  function dispose() {
    disposed = true
    sources.dispose()
    jev.dispose()
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d()
      } catch {}
    }
  }

  return {
    first,
    tick,
    refresh,
    dispose,
    act: onPanelMessage,
    saveSettings,
    snapshot: () => {
      build(now())
      return snapshot(now())
    },
    groups: () => build(now()).groups,
    settings: () => settings,
    state,
    jev,
  }
}

let inbox = null
exports.activate = (ctx) => {
  inbox = createInbox(ctx)
  ctx.log.info('inbox: activated')
}
exports.deactivate = () => {
  if (inbox) inbox.dispose()
  inbox = null
}
exports.createInbox = createInbox
