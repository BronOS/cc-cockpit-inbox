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
//
// The settings page (settings/index.html, `ctx.settingsPage`) edits a draft and sends it whole: the
// host checks every save with lib/settings.js `checkSettings` and refuses one that does not fit with
// the reason, stores and applies one that does. App scope edits the global set (ctx.appStorage),
// project scope this project's own (ctx.storage) or switches it back to the global; the set in force
// is the project's own when it has one (applyEffective). Done, snooze and the Jev answers stay app-wide. It also answers the page's "Test" of one rule over the
// items it holds now, with cached Jev answers only (never a request). The page gets the settings, the
// field table, the sources (label, scope, state, count) and whether a `jev` provider is there; Inbox
// has no secrets, and nothing else goes to it.

const { actReplyOf } = require('./lib/feed')
const { createSources } = require('./lib/sources')
const { createJev } = require('./lib/jev')
const { createState, untilOf } = require('./lib/state')
const { isObj, why, withTimeout, keyOf, SNOOZE_CHOICES, DEFAULT_TIMES } = require('./lib/util')
const { placeItem, traceItem, checkRule, byTime, REST, FIELDS, KINDS, TO, MAX_IN, MAX_VALUE, MAX_MINUTES } = require('./lib/rules')
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
// The panel message must stay under the app's post limit (1 MiB of JSON text,
// MAX_PANEL_MESSAGE_LENGTH): rows per group, Done entries and search results are capped (the counts
// go with them), previews cut. Those caps alone do not bound the total: settings allow 20 groups of
// 200 rows, each row up to ~2 KB (title, preview, labels, actions), so a heavy inbox passes the
// limit, the post throws and the panel would freeze on its last state with no word. So publish()
// measures the message and, over POST_BUDGET (room left for the JSON of the notice and slack),
// drops previews first, then halves the rows per group until it fits, and says so in the panel
// (`limited`); the row counts still show "N more not shown".
const ROWS_SHOWN = 200
const PREVIEW_SHOWN = 200
const POST_BUDGET = 800 * 1024
const MIN_ROWS_SHOWN = 5
const MAX_QUERY = 200
// A snooze that ended while the app was closed is not announced when it opens: only one that ended
// in the last 15 minutes, and at most 3 a refresh (the app caps notifications at 10 a minute).
const NOTIFY_WITHIN_MS = 15 * 60000
const NOTIFY_MAX = 3
const SNOOZES = new Set(SNOOZE_CHOICES)
const SNOOZE_TIMES = DEFAULT_TIMES
// The settings page's "Test": examples shown, and their titles cut (the page draws text only).
const TEST_EXAMPLES = 5
const TEST_TITLE = 120
// A group's open state as the person last left it (design-v2 "The panel": remembered), app-wide
// like the settings. A panel page has an opaque origin (no localStorage), so the host keeps it:
// `{ <group id>: true | false }`, only ids of groups that exist, at most one per group cap.
const OPEN_KEY = 'ui:groupsOpen'
const GROUP_ID = S.ID
const FULL_FIT = Object.freeze({ rows: ROWS_SHOWN, preview: PREVIEW_SHOWN })
const OLD_APP = 'Inbox 0.2.0 needs cc-cockpit 0.10.0 or newer (slots, overlay buttons and the services collector). Update the app.'

// What a failed panel action is called in its notice: the button's words, not the message type.
const ACTION_NAMES = { open: 'Open', done: 'Done', snooze: 'Snooze', undo: 'Undo', restore: 'Back to Inbox', refresh: 'Refresh', act: 'That action' }

const cut = (s, max) => (typeof s === 'string' && s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** What the editor needs to offer only what a save accepts: fields, ops, value kinds and caps. */
const TABLE = Object.freeze({
  fields: FIELDS,
  kinds: KINDS,
  to: TO,
  rest: REST,
  agenda: S.AGENDA,
  caps: { ...S.CAPS, in: MAX_IN, value: MAX_VALUE, minutes: MAX_MINUTES },
})

/** The unread rule (`read: null` is no read state and does not count): the groups' counts and the badge. */
const isUnread = (item) => item.read === false

/** The part of a source's line both the panel and the settings page show (the host adds its own extras). */
const sourceLine = (s) => ({
  pluginId: s.pluginId,
  label: s.desc.label,
  badge: s.desc.badge,
  color: s.desc.color,
  kind: s.desc.kind,
  ...(s.desc.scope ? { scope: s.desc.scope } : {}),
  state: s.state,
  count: s.items.length,
})

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
  // A throwing disposer must not keep the others from running.
  const disposeAll = () => {
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d()
      } catch {}
    }
  }

  if (!appIsNew(ctx)) {
    // An older app may still load Inbox (it ignores manifest keys it does not know): say what to do.
    ctx.log.warn(OLD_APP)
    const fatal = () => ctx.panels.post(PANEL, { type: 'state', version: 2, fatal: OLD_APP })
    disposers.push(ctx.panels.onMessage(PANEL, fatal))
    try {
      fatal()
    } catch {}
    const nothing = async () => {}
    return { first: Promise.resolve(), tick: nothing, refresh: nothing, act: nothing, saveSettings: nothing, dispose: disposeAll }
  }

  const call = (p, what) => withTimeout(p, callMs, what)
  const state = createState(ctx.appStorage)
  // Two sets (design-v2 "Rules" › "Per project"): the global one (ctx.appStorage) and this project's
  // own (ctx.storage, null: use the global). `settings` is the effective one, the only one placement,
  // the agenda, the panel and `ccc inbox` read; `settingsSet` names it (`global` or `project`).
  let globalSettings = S.defaults()
  let projectSettings = null
  let settings = globalSettings
  let settingsSet = 'global'
  let settingsJson = JSON.stringify(settings)
  // The last damaged override logged, so a bad value is logged once, not on every minute's read.
  let damagedLogged = null

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
  /** group id -> open, as the person left it (OPEN_KEY). */
  let groupsOpen = {}
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
      for (const [key, p] of [...placed]) {
        if (live.has(key)) continue
        placed.delete(key)
        // Left its feed: a Jev request still queued for it is dropped, not asked (a full placement's
        // sweep does the same for everything at once).
        if (!full) jev.forget(p.item.source, p.item.id)
      }
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
  function rowOut(key, item, extra, fit = FULL_FIT) {
    const d = descOf(item.source)
    const actions = item.actions || []
    return {
      key,
      source: item.source,
      id: item.id,
      title: item.title,
      ...(item.preview && fit.preview > 0 ? { preview: cut(item.preview, fit.preview) } : {}),
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
  function searchOut(t, fit) {
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
      g.rows = g.rows.slice(0, Math.max(0, fit.rows - shown)).map((r) => rowOut(r.key, r.item, { reason: r.placement.reason, jev: r.placement.jev, done: r.done, snoozed: r.snoozed }, fit))
      shown += g.rows.length
    }
    return { query, count: hits.length, groups: groups.filter((g) => g.rows.length), done: done.slice(0, Math.max(0, fit.rows - shown)) }
  }

  /**
   * The panel's whole state: groups, source lines, Done view, search, undo. `fit` caps rows per
   * group and preview length (publish() lowers them when the message would pass the post limit);
   * `limited` is the panel's line saying so.
   */
  function snapshot(t, fit = FULL_FIT, limited = null) {
    const groups = view.groups.map((g) => ({
      id: g.id,
      name: g.name,
      collapsed: g.collapsed,
      badge: g.badge,
      count: g.rows.length,
      unread: g.rows.filter((r) => isUnread(r.item)).length,
      rows: g.rows.slice(0, fit.rows).map((r) => rowOut(r.key, r.item, { reason: r.placement.reason, jev: r.placement.jev, back: r.back }, fit)),
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
        ...sourceLine(s),
        message: s.message,
        error: s.error,
        stale: s.stale,
        asOf: s.asOf,
        loaded: s.loaded,
        refused: s.refused,
        overCap: s.overCap,
        shown: shownBy.get(s.pluginId) || 0,
      })),
      done: {
        count: doneAll.length,
        rows: doneAll.slice(0, fit.rows).map((e) => {
          const d = descOf(e.pluginId)
          return { key: keyOf(e.pluginId, e.id), source: e.pluginId, id: e.id, title: e.title, at: e.at, live: e.live, badge: d.badge, color: d.color, label: d.label }
        }),
      },
      search: searchOut(t, fit),
      undo: lastUndo && t < lastUndo.until ? { label: lastUndo.label, until: lastUndo.until } : null,
      agenda: settings.agenda,
      groupsOpen: openOf(groupsOpen),
      limited,
    }
  }

  /**
   * The largest snapshot that fits POST_BUDGET: the full one, else without previews, else with the
   * rows per group halved down to MIN_ROWS_SHOWN. Null when even that does not fit (the caller
   * then posts a notice instead of a state the app would refuse).
   */
  function fittedSnapshot(t) {
    const full = snapshot(t)
    if (JSON.stringify(full).length <= POST_BUDGET) return full
    const limited = 'The inbox is too large to show in full: previews are hidden and fewer rows are listed. Search or narrow by source to see the rest.'
    for (let rows = ROWS_SHOWN; rows >= MIN_ROWS_SHOWN; rows = Math.floor(rows / 2)) {
      const s = snapshot(t, { rows, preview: 0 }, limited)
      if (JSON.stringify(s).length <= POST_BUDGET) return s
    }
    return null
  }

  /** The panel badge: unread items in the groups marked `badge` (`read: null`, no read state, does not count). */
  function badgeOf() {
    let n = 0
    for (const g of view.groups) if (g.badge) for (const r of g.rows) if (isUnread(r.item)) n++
    return n > 0 ? n : null
  }

  /** The app's title bar of the panel: when a source last changed, and refresh (the app's gear opens the settings page). */
  function header() {
    if (typeof ctx.panels.header !== 'function') return
    const d = updatedAt ? new Date(updatedAt) : null
    const spec = {
      meta: d ? `updated ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'loading…',
      // Each source answers snapshot() from what it last fetched (its own poll fetches): the button
      // reads that again, it does not make a source fetch, so the title does not promise one.
      actions: [{ id: 'refresh', icon: 'refresh', title: 'Reload from the sources' }],
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
      const s = fittedSnapshot(t)
      if (s) ctx.panels.post(PANEL, s)
      else {
        ctx.log.error('post: the panel state passes the post limit even cut down')
        notice('The inbox is too large to show. Turn off a source or remove groups in the Inbox settings.')
      }
    } catch (e) {
      ctx.log.error(`post: ${why(e)}`)
      notice(`The inbox could not be shown: ${why(e)}`)
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

  /**
   * The effective set from the two: this project's own when it has one, else the global. One that
   * differs from the current: every item placed again, the agenda moved. Changing only which set is
   * in force (the same content) places nothing again; `why` names the new one at once.
   */
  function applyEffective() {
    const next = projectSettings || globalSettings
    settingsSet = projectSettings ? 'project' : 'global'
    const json = JSON.stringify(next)
    if (json === settingsJson) return
    settings = next
    settingsJson = json
    needFull = true
    placeAgenda()
    schedulePublish()
  }

  /** A new global set (read or saved). */
  function applyGlobal(next) {
    globalSettings = next
    applyEffective()
  }

  /** This project's own set (read or saved), or null to use the global one. */
  function applyProject(next) {
    projectSettings = next
    applyEffective()
  }

  /** The stored override of this project, validated; a damaged one is logged once and counts as none. */
  async function loadProject() {
    const o = await S.loadOverride(ctx.storage)
    if (o.damaged && o.damaged !== damagedLogged) ctx.log.warn(`project rules: the stored set is damaged (${o.damaged}); the global rules apply`)
    damagedLogged = o.damaged || null
    return o.settings
  }

  /** Validate and store the global settings (the app's settings page), applied in this window at once. Resolves what was stored. */
  async function saveSettings(raw) {
    const s = await S.saveSettings(ctx.appStorage, raw)
    applyGlobal(s)
    return s
  }

  /** Validate and store this project's own set (its settings page), applied at once. Resolves what was stored. */
  async function saveProjectSettings(raw) {
    const s = await S.saveOverride(ctx.storage, raw)
    damagedLogged = null
    applyProject(s)
    return s
  }

  /** Drop this project's own set: the global rules apply again, every item placed by them. */
  async function useGlobalSettings() {
    await S.clearOverride(ctx.storage)
    damagedLogged = null
    applyProject(null)
  }

  /** The remembered open states of groups that exist now (a deleted group's entry is dropped). */
  function openOf(raw) {
    const ids = new Set([...settings.groups.map((g) => g.id), REST])
    const out = {}
    if (isObj(raw)) for (const [id, v] of Object.entries(raw)) if (GROUP_ID.test(id) && ids.has(id) && typeof v === 'boolean') out[id] = v
    return out
  }

  /** The panel's toggle of a group: remembered at once here, stored for the other windows and the next start. */
  async function rememberOpen(id, open) {
    if (typeof id !== 'string' || !GROUP_ID.test(id) || typeof open !== 'boolean') return
    const next = openOf({ ...groupsOpen, [id]: open })
    if (!Object.hasOwn(next, id)) return
    groupsOpen = next
    try {
      await ctx.appStorage.set(OPEN_KEY, next)
    } catch (e) {
      ctx.log.warn(`group state: ${why(e)}`)
    }
  }

  /**
   * Both sets (the global one: another window may have saved it; this project's: read the same way,
   * though only this project's page writes it), what other windows may have written: Done and
   * snooze, now and then the Jev answers.
   */
  async function readSettings() {
    try {
      globalSettings = await S.loadSettings(ctx.appStorage)
    } catch (e) {
      ctx.log.warn(`settings: ${why(e)}`)
    }
    try {
      projectSettings = await loadProject()
    } catch (e) {
      ctx.log.warn(`project settings: ${why(e)}`)
    }
    applyEffective()
  }

  async function reloadShared() {
    await readSettings()
    // After the settings: only ids of groups that exist are kept.
    try {
      const raw = await ctx.appStorage.get(OPEN_KEY)
      if (raw !== undefined) groupsOpen = openOf(raw)
    } catch (e) {
      ctx.log.warn(`group state: ${why(e)}`)
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
      await state.touch(listed, t).catch((e) => ctx.log.warn(`touch: ${why(e)}`))
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

  /** Snooze in Inbox's memory only. Resolves `{ item, until }` (the time that was stored), or null when there is none to snooze (or no such choice). */
  async function snoozeItem(key, choice) {
    const it = visibleByKey(key)
    if (!it || !SNOOZES.has(choice)) return null
    const t = now()
    const until = untilOf(choice, t, SNOOZE_TIMES)
    setUndo(await state.snooze(memoryRow(it), until, t), `Snoozed: ${it.title}`, t)
    publish()
    return { item: it, until }
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
      case 'snooze':
        await snoozeItem(m.key, m.choice)
        return
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
      case 'groupOpen':
        await rememberOpen(m.id, m.open)
        return
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

  // ---- the settings page ----

  /** The sources as the page lists them (read-only): label, kind, scope, state, item count. */
  function pageSources() {
    return sources.list().map((s) => ({ ...sourceLine(s), ...(s.message ? { message: s.message } : {}) }))
  }

  /**
   * One rule of a draft tried over the items Inbox shows now (Done and snoozed left out), with cached
   * Jev answers only: how many it would place where it stands (earlier rules take theirs first), how
   * many it holds for on its own, how many wait for a Jev answer, and five of the placed ones. A
   * disabled rule is tried as if enabled. The draft is checked like a save first.
   */
  function testRule(raw, ruleId) {
    const checked = S.checkSettings(raw)
    if (!checked.ok) return { ok: false, reason: checked.reason }
    const draft = checked.settings
    const idx = draft.rules.findIndex((r) => r.id === ruleId)
    if (idx < 0) return { ok: false, reason: 'that rule is not in the draft' }
    const rule = { ...draft.rules[idx], enabled: true }
    const tried = { ...draft, rules: draft.rules.map((r, i) => (i === idx ? rule : r)) }
    const t = now()
    build(t)
    const kindOf = (id) => descOf(id).kind
    const o = { now: t, kindOf, jevAnswer: jev.cachedAnswer }
    const placedRows = []
    let total = 0
    let holds = 0
    let pending = 0
    for (const [key, item] of view.live) {
      if (state.status(item, t).hidden) continue
      total++
      const r = checkRule(rule, item, { ...o, kind: kindOf(item.source) })
      if (r.result === 'held') holds++
      else if (r.result === 'pending') pending++
      const p = placeItem(tried, item, o)
      if (p.ruleId === rule.id) placedRows.push({ key, item, placement: p })
    }
    placedRows.sort(byTime)
    return {
      ok: true,
      rule: idx + 1,
      total,
      placed: placedRows.length,
      holds,
      pending,
      jev: Boolean(rule.jev) && jev.available(),
      examples: placedRows.slice(0, TEST_EXAMPLES).map((r) => {
        const d = descOf(r.item.source)
        return { title: cut(r.item.title, TEST_TITLE), label: d.label, badge: d.badge, color: d.color, reason: r.placement.reason }
      }),
    }
  }

  const testId = (m) => (typeof m.ruleId === 'string' ? m.ruleId.slice(0, S.MAX_ID_LENGTH) : '')

  /**
   * The settings page's backend. Its scope comes from the app (`page.scope`), never from a message:
   * `app` (Settings > Plugins) edits the global set; `project` (This Project) edits this project's own
   * set, or shows the global one read-only while the project uses it (`useGlobal`). In project scope
   * `useGlobal { on: false }` copies the stored global set into the project (the host reads it, the
   * page sends no settings) and `{ on: true }` deletes the override (the page asked the person
   * first); a save while the project uses the global rules is refused, so a stale page cannot write
   * the global set into a project, nor a project's page the global set.
   */
  function onSettingsPage(page) {
    const send = (m) => {
      try {
        page.post(m)
      } catch (e) {
        ctx.log.warn(`settings page: ${why(e)}`)
      }
    }
    const scope = page.scope === 'app' || page.scope === 'project' ? page.scope : null
    const sendSettings = (saved) => {
      const extra = scope === 'project' ? { useGlobal: projectSettings === null } : {}
      const shown = scope === 'project' ? projectSettings || globalSettings : globalSettings
      send({ type: 'settings', scope, ...extra, saved, settings: shown, table: TABLE, defaults: S.defaults(), sources: pageSources(), jev: jev.available() })
    }
    let closed = false
    page.onClose(() => {
      closed = true
    })
    if (!scope) {
      send({ type: 'fatal', reason: 'Inbox has no settings here: edit them under Settings > Plugins or This Project.' })
      return
    }
    page.onMessage(async (m) => {
      if (!isObj(m) || typeof m.type !== 'string') return
      try {
        if (m.type === 'ready') {
          // Another window may have saved since this one last read: the page starts from the stored values.
          await readSettings()
          sendSettings(false)
          // The sources are still being read: send them again once they are.
          if (!started) void first.then(() => !closed && sendSettings(false))
        } else if (m.type === 'save') {
          const checked = S.checkSettings(m.settings)
          if (!checked.ok) return send({ type: 'refused', reason: checked.reason })
          if (scope === 'app') await saveSettings(checked.settings)
          else {
            // Read again first: this window's copy may be older than the store (another page's switch).
            projectSettings = await loadProject()
            if (projectSettings === null) {
              applyEffective()
              sendSettings(false)
              return send({ type: 'refused', reason: 'This project uses the global rules: turn off "Use the global rules" to give it its own.' })
            }
            await saveProjectSettings(checked.settings)
          }
          sendSettings(true)
        } else if (m.type === 'useGlobal' && scope === 'project' && typeof m.on === 'boolean') {
          if (m.on) await useGlobalSettings()
          else {
            await readSettings()
            // Already its own (a second click, another page): kept, never overwritten by the global.
            if (projectSettings === null) await saveProjectSettings(globalSettings)
          }
          sendSettings(true)
        } else if (m.type === 'test') {
          send({ type: 'test', ruleId: testId(m), result: testRule(m.settings, m.ruleId) })
        }
      } catch (e) {
        ctx.log.warn(`settings page ${m.type}: ${why(e)}`)
        if (m.type === 'test') send({ type: 'test', ruleId: testId(m), result: { ok: false, reason: why(e) } })
        else send({ type: 'refused', reason: `${m.type === 'save' || m.type === 'useGlobal' ? 'Saving' : 'That'} failed: ${why(e)}` })
      }
    })
  }

  if (typeof ctx.settingsPage === 'object' && ctx.settingsPage !== null && typeof ctx.settingsPage.onOpen === 'function') {
    try {
      disposers.push(ctx.settingsPage.onOpen(onSettingsPage))
    } catch (e) {
      ctx.log.warn(`settings page: ${why(e)}`)
    }
  }

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

  // ---- `ccc inbox` (lib/cli.js) ----

  /** The list as `ccc inbox` numbers it: every group in order, with the rule that placed each row. */
  function cliRows() {
    const out = []
    for (const g of view.groups) {
      for (const r of g.rows) {
        out.push({ key: r.key, item: r.item, pluginId: r.item.source, id: r.item.id, title: r.item.title, badge: descOf(r.item.source).badge, group: g.name, groupId: g.id, reason: r.placement.reason, at: r.item.time })
      }
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
      // The list names the set only when it is this project's own (the usual case says nothing new);
      // `why` always names it.
      if (p.cmd === 'list') return { stdout: CLI.formatList(rows, now(), settingsSet === 'project' ? S.SET_NAMES.project : null) }
      if (p.cmd === 'undo') {
        // Same window as the panel's toast: after it the entry is not offered any more.
        if (!lastUndo || now() >= lastUndo.until) return { stderr: `Nothing to undo (undo lasts ${UNDO_MS / 1000} seconds after a done or snooze).\n`, code: 1 }
        const { label } = lastUndo
        try {
          await act({ type: 'undo' })
        } catch (e) {
          return { stderr: `undo failed: ${CLI.oneLine(why(e), 300)}\n`, code: 1 }
        }
        return { stdout: `Undone: ${CLI.oneLine(label, CLI.MAX_TITLE + 20)}\n` }
      }
      const got = CLI.resolve(rows, p.target)
      if (got.error) return { stderr: `${got.error}\n`, code: 1 }
      const row = got.row
      const title = CLI.oneLine(row.title, CLI.MAX_TITLE)
      if (p.cmd === 'why') {
        // The same pass as the row, from cached Jev answers only: asking is the sweep's job, not a read's.
        const t = now()
        const tr = traceItem(settings, row.item, { now: t, kindOf: (id) => descOf(id).kind, jevAnswer: jev.cachedAnswer })
        return { stdout: CLI.formatWhy(row, tr.text, S.SET_NAMES[settingsSet]) }
      }
      try {
        if (p.cmd === 'act') {
          const reply = await runAction(row.key, p.action)
          if (!reply.ok) return { stderr: `${CLI.oneLine(reply.label || p.action, 40)} failed: ${CLI.oneLine(reply.message || 'the source refused', 300)}\n`, code: 1 }
          return { stdout: `${CLI.oneLine(reply.label || p.action, 40)}: ${title}\n` }
        }
        if (p.cmd === 'open') {
          const reply = await runAction(row.key, 'open')
          if (!reply.ok) return { stderr: `open failed: ${CLI.oneLine(reply.message || 'the source refused', 300)}\n`, code: 1 }
          return { stdout: `Opened ${title}\n` }
        }
        // The list was built before the call: the item may have been hidden (another window, a
        // panel click) or gone since, and then nothing was marked, so no "Done:" line.
        if (p.cmd === 'done') {
          if (!(await markDone(row.key))) return { stderr: 'That item is no longer in the list: run `ccc inbox list` again.\n', code: 1 }
          return { stdout: `Done: ${title}\n` }
        }
        const snoozed = await snoozeItem(row.key, p.choice)
        if (!snoozed) return { stderr: 'That item is no longer in the list: run `ccc inbox list` again.\n', code: 1 }
        const { until } = snoozed
        return { stdout: `Snoozed until ${until === null ? 'it changes' : CLI.when(until)}: ${title}\n` }
      } catch (e) {
        return { stderr: `${p.cmd} failed: ${CLI.oneLine(why(e), 300)}\n`, code: 1 }
      }
    })
    disposers.push(unregister)
  }

  function dispose() {
    disposed = true
    sources.dispose()
    jev.dispose()
    disposeAll()
  }

  return {
    first,
    tick,
    refresh,
    dispose,
    act: onPanelMessage,
    saveSettings,
    saveProjectSettings,
    useGlobalSettings,
    testRule,
    snapshot: () => {
      build(now())
      return snapshot(now())
    },
    groups: () => build(now()).groups,
    settings: () => settings,
    settingsSet: () => settingsSet,
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
