'use strict'
// Inbox (bronos.inbox): one ranked list of every `inbox-feed` provider with today's calendar
// (docs/design.md). The host reads the providers through ctx.services (never their storage), ranks
// with lib/rank.js, keeps done and snooze in app storage (lib/state.js) and posts one `state`
// message to the panel; the panel only renders and asks.
//
// Refresh: a provider's `changed` event re-reads that source (debounced, a provider that emits after
// every poll of several lanes costs one read); every 60 s everything is re-read (sources, the
// calendar, the state and settings another window may have written); a provider joining or leaving
// (`onChange`) syncs the set. The panel posts `visible` when it comes into sight or its window gets
// focus, and the state is re-read then, so a done in another window shows at once there.
//
// Every provider is another plugin: each call has a time limit, one source that throws or hangs
// never holds the others, its last good items stay (marked stale, with its error line), and what it
// answers goes through lib/feed.js before anything else sees it. Actions from the panel name a row
// by its key; the host looks the row up in its own last ranking and never takes an id, a rev or a
// URL from the page as it is.

const { describeOf, itemsOf, featuresOf, calDayOf, calUpcomingOf, httpsUrl } = require('./lib/feed')
const { rank, DEFAULT_RULES } = require('./lib/rank')
const { createState, untilOf } = require('./lib/state')
const S = require('./lib/settings')
const CLI = require('./lib/cli')

const PANEL = 'main'
const FEED = 'inbox-feed'
const CALENDAR = 'calendar'
const CALL_MS = 10000
// How long `ccc inbox` waits for the first refresh (the plugin command limit is 30 s).
const CLI_WAIT_MS = 20000
const DEBOUNCE_MS = 1000
const REFRESH_S = 60
const UNDO_MS = 6000
// A snooze that ended while the app was closed is not announced when it opens: only one that ended
// in the last 15 minutes, and at most 3 a refresh (the app caps notifications at 10 a minute).
const NOTIFY_WITHIN_MS = 15 * 60000
const NOTIFY_MAX = 3
const ANSWERS = new Set(['accepted', 'tentative', 'declined'])
const SNOOZES = new Set(['1h', 'afternoon', 'tomorrow', 'changes'])
const OLD_APP = 'Inbox needs cc-cockpit 0.9.7 or newer (ctx.services.useAll). Update the app.'

// What a failed panel action is called in its notice: the button's words, not the message type.
const ACTION_NAMES = { open: 'Open', done: 'Done', snooze: 'Snooze', undo: 'Undo', restore: 'Back to inbox', markUnread: 'Mark unread', join: 'Join', respond: 'Accept', calOpen: 'Open the event', saveSettings: 'Saving the settings', refresh: 'Refresh' }

const why = (e) => String((e && e.message) || e || 'failed').slice(0, 300)

/** `p`, or a rejection after `ms` (a provider that never answers must not hold the refresh). */
function withTimeout(p, ms, what) {
  let t
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms)
    }),
  ])
}

/**
 * The Inbox host. `opts` exists for tests: `now` (clock), `callMs` (per-call limit), `debounceMs`
 * (the `changed` debounce), `timers` ({ setTimeout, clearTimeout } for the debounce).
 */
function createInbox(ctx, opts = {}) {
  const now = opts.now || Date.now
  const callMs = opts.callMs ?? CALL_MS
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS
  const timers = opts.timers || { setTimeout, clearTimeout }
  const disposers = []

  if (typeof ctx.services.useAll !== 'function') {
    // The manifest's `services.collects` keeps Inbox off an older app; this is the belt to that.
    ctx.log.warn(OLD_APP)
    disposers.push(ctx.panels.onMessage(PANEL, () => ctx.panels.post(PANEL, { type: 'state', fatal: OLD_APP })))
    return { tick: async () => {}, act: async () => {}, dispose: () => disposers.forEach((d) => d()) }
  }

  const feeds = ctx.services.useAll(FEED)
  const state = createState(ctx.appStorage)
  let settings = S.readSettings(undefined)
  /** pluginId -> { pluginId, handle, desc, features, items, asOf, state, message, error, stale, gen, timer, loaded } */
  const sources = new Map()
  const cal = { handle: null, unsub: null, day: null, upcoming: [], error: null, timer: null, gen: 0 }
  let ranked = { rows: [], hiddenByDedupe: 0 }
  let lastRead = []
  let lastUndo = null
  let lastBadge
  let updatedAt = null
  let disposed = false
  let ticking = null

  const call = (p, what) => withTimeout(p, callMs, what)

  // ---- sources ----

  function newSource(p) {
    return { pluginId: p.pluginId, handle: p.handle, desc: null, features: new Set(), items: [], asOf: null, state: 'ok', message: null, error: null, stale: false, gen: 0, timer: null, loaded: false, describing: null, recent: [] }
  }

  /** Bring `sources` in line with the providers now; resolves once the new ones were read. */
  async function sync() {
    const list = feeds.providers()
    const ids = new Set(list.map((p) => p.pluginId))
    for (const [id, s] of sources) {
      if (ids.has(id)) continue
      if (s.timer) timers.clearTimeout(s.timer)
      sources.delete(id)
    }
    const joined = []
    for (const p of list) {
      if (sources.has(p.pluginId)) continue
      sources.set(p.pluginId, newSource(p))
      joined.push(p.pluginId)
    }
    await Promise.all(joined.map((id) => refreshSource(id)))
    return new Set(joined)
  }

  /**
   * describe and features, once per provider instance. One promise per source: an onChange sync and
   * a refresh that start together share it instead of asking twice. A failure clears it (asked again
   * on the next read).
   */
  function describeSource(s) {
    if (!s.describing) {
      s.describing = Promise.all([call(s.handle.describe(), `${s.pluginId} describe`), call(s.handle.features(), `${s.pluginId} features`).catch(() => [])]).then(
        ([d, f]) => {
          s.desc = describeOf(d, s.pluginId)
          s.features = featuresOf(f)
          s.describedAt = now()
        },
        (e) => {
          s.describing = null
          throw e
        }
      )
    }
    return s.describing
  }

  /** Read one source (describe and features once per provider instance, then items). Never throws. */
  async function refreshSource(id) {
    const s = sources.get(id)
    if (!s) return
    const gen = ++s.gen
    const current = () => sources.get(id) === s && s.gen === gen && !disposed
    if (!s.desc || s.redescribe) {
      s.redescribe = false
      try {
        await describeSource(s)
        if (sources.get(id) !== s) return
      } catch (e) {
        if (sources.get(id) !== s) return
        // A source already described keeps its last description; only a first failure stops here.
        if (s.desc) {
          ctx.log.warn(`source ${id} describe: ${why(e)}`)
        } else {
        // Shown anyway, under a name built from its id; describe is asked again next time.
        s.error = `${id}: ${why(e)}`
        s.stale = s.items.length > 0
        ctx.log.warn(`source ${id}: ${why(e)}`)
        return
        }
      }
    }
    const conf = S.sourceOf(settings, id, s.desc.kind)
    if (!conf.on) return
    try {
      const ans = itemsOf(await call(s.handle.items({ limit: conf.items }), `${id}`))
      if (!current()) return
      s.loaded = true
      s.error = null
      s.state = ans.state
      s.message = ans.message || null
      if (ans.state === 'ok' || ans.items.length > 0) {
        s.items = ans.items
        s.asOf = ans.asOf
        s.stale = false
      } else {
        // An error with nothing in it: keep what the source gave last.
        s.stale = s.items.length > 0
      }
    } catch (e) {
      if (!current()) return
      s.error = `${s.desc.label}: ${why(e)}`
      s.stale = s.items.length > 0
      ctx.log.warn(`source ${id}: ${why(e)}`)
    }
    if (s.features.has('recent')) await refreshRecent(s, current)
  }

  /**
   * The source's read messages for the Read chip (`recent`, optional in feed v1). Only read rows are
   * kept (a provider that sends unread ones there would list them twice); a failure keeps the last
   * answer and only logs: the main list's error line is about `items`.
   */
  async function refreshRecent(s, current) {
    try {
      const ans = itemsOf(await call(s.handle.recent({ limit: settings.readItems }), `${s.pluginId} recent`))
      if (!current()) return
      if (ans.state === 'ok' || ans.items.length > 0) s.recent = ans.items.filter((it) => !it.unread)
    } catch (e) {
      if (current()) ctx.log.warn(`source ${s.pluginId} recent: ${why(e)}`)
    }
  }

  /** The Read chip's rows: every on source's read messages, newest first, as list rows. */
  function readRows() {
    const out = []
    for (const s of sources.values()) {
      if (!s.desc || !s.features.has('recent') || !S.sourceOf(settings, s.pluginId, s.desc.kind).on) continue
      for (const it of s.recent) {
        out.push({ key: `${s.pluginId}\u0000${it.id}`, pluginId: s.pluginId, id: it.id, rev: it.rev, badge: s.desc.badge, color: s.desc.color, label: s.desc.label, kind: s.desc.kind, title: it.title, from: it.from, where: it.where, at: it.at, level: it.level, unread: false, read: true, canUnread: s.features.has('markUnread') && it.canUnread !== false })
      }
    }
    return out.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity)).slice(0, settings.readItems)
  }

  function onFeedChanged(_data, pluginId) {
    if (disposed || typeof pluginId !== 'string') return
    const s = sources.get(pluginId)
    if (!s) {
      // An event before the onChange that announces its provider: sync picks it up.
      void sync().then(publish, (e) => ctx.log.warn(`sync: ${why(e)}`))
      return
    }
    if (s.timer) timers.clearTimeout(s.timer)
    s.timer = timers.setTimeout(() => {
      s.timer = null
      void refreshSource(pluginId).then(publish)
    }, debounceMs)
  }

  // ---- calendar ----

  async function refreshCalendar() {
    const gen = ++cal.gen
    if (settings.calendar.position === 'off' || !ctx.services.available(CALENDAR)) {
      cal.day = null
      cal.upcoming = []
      cal.error = null
      return
    }
    if (!cal.handle) {
      cal.handle = ctx.services.use(CALENDAR)
      cal.unsub = cal.handle.on('changed', onCalendarChanged)
    }
    try {
      const [day, up] = await Promise.all([
        call(cal.handle.day({}), 'calendar'),
        call(cal.handle.upcoming({ count: Math.min(20, settings.calendar.upcoming + 1), days: 7 }), 'calendar'),
      ])
      if (gen !== cal.gen || disposed) return
      cal.day = calDayOf(day)
      cal.upcoming = calUpcomingOf(up)
      cal.error = null
    } catch (e) {
      if (gen !== cal.gen || disposed) return
      cal.error = `Calendar: ${why(e)}`
      ctx.log.warn(`calendar: ${why(e)}`)
    }
  }

  function onCalendarChanged() {
    if (disposed) return
    if (cal.timer) timers.clearTimeout(cal.timer)
    cal.timer = timers.setTimeout(() => {
      cal.timer = null
      void refreshCalendar().then(publish)
    }, debounceMs)
  }

  /** An event the host has, by id (Join and RSVP use only what the calendar answered). */
  function eventById(id) {
    if (typeof id !== 'string') return null
    const all = [...((cal.day && cal.day.events) || []), ...cal.upcoming, ...(cal.day && cal.day.tomorrow.first ? [cal.day.tomorrow.first] : [])]
    return all.find((e) => e.id === id) || null
  }

  // ---- the list ----

  /** The sources that are on and described, cut to their item count, as rank.js takes them. */
  function rankSources() {
    const out = []
    for (const s of sources.values()) {
      if (!s.desc) continue
      const conf = S.sourceOf(settings, s.pluginId, s.desc.kind)
      if (!conf.on) continue
      out.push({ pluginId: s.pluginId, ...s.desc, items: s.items.slice(0, conf.items) })
    }
    return out
  }

  function computeRows(t) {
    const view = state.view(t, DEFAULT_RULES.snoozeBack, { doneReturns: settings.doneReturns })
    const c = settings.calendar
    const calArg = c.position === 'inline' && cal.day ? { position: 'inline', pinMinutes: c.pinMinutes, events: cal.day.events } : null
    ranked = rank(rankSources(), S.rulesOf(settings), t, view, calArg)
    return ranked
  }

  function badgeOf(rows) {
    const mode = settings.badge
    if (mode === 'off') return null
    const items = rows.filter((r) => !r.calendar)
    const n = mode === 'urgent' ? items.filter((r) => r.level === 'urgent').length : mode === 'action' ? items.filter((r) => r.level === 'urgent' || r.level === 'action').length : items.length
    return n > 0 ? n : null
  }

  function snapshot(t) {
    const { rows, hiddenByDedupe } = computeRows(t)
    const counts = new Map()
    for (const r of rows) if (r.pluginId) counts.set(r.pluginId, (counts.get(r.pluginId) || 0) + 1)
    const chips = []
    for (const s of sources.values()) {
      const conf = s.desc ? S.sourceOf(settings, s.pluginId, s.desc.kind) : null
      if (conf && !conf.on) continue
      const d = s.desc || describeOf(null, s.pluginId)
      const problem = s.error || (s.state !== 'ok' ? `${d.label}: ${s.message || (s.state === 'signedOut' ? 'signed out' : 'error')}` : null)
      chips.push({
        pluginId: s.pluginId,
        label: d.label,
        badge: d.badge,
        color: d.color,
        kind: d.kind,
        count: counts.get(s.pluginId) || 0,
        loaded: s.loaded,
        stale: s.stale,
        asOf: s.asOf,
        ...(problem ? { problem } : {}),
      })
    }
    lastRead = readRows()
    const today = state.today(t).map((e) => ({ pluginId: e.pluginId, id: e.id, title: e.title || '', badge: e.badge || '', kind: e.kind, at: e.at, until: e.until ?? null }))
    const c = settings.calendar
    return {
      type: 'state',
      now: t,
      updatedAt,
      rows,
      hiddenByDedupe,
      chips,
      today,
      // null: no source offers read messages (no Read chip).
      read: [...sources.values()].some((s) => s.features.has('recent')) ? lastRead : null,
      undo: lastUndo && t < lastUndo.until ? { label: lastUndo.label, until: lastUndo.until } : null,
      calendar:
        c.position === 'off' || (!cal.day && !cal.error)
          ? null
          : { position: c.position, timeline: c.timeline, upcomingCount: c.upcoming, day: cal.day, upcoming: cal.upcoming, ...(cal.error ? { problem: cal.error } : {}) },
      settings,
      // The settings view lists every provider, on or off, with its kind's defaults.
      providers: [...sources.values()].map((s) => {
        const d = s.desc || describeOf(null, s.pluginId)
        return { pluginId: s.pluginId, label: d.label, color: d.color, kind: d.kind, markRead: s.features.has('markRead'), ...S.sourceOf(settings, s.pluginId, d.kind) }
      }),
    }
  }

  /** The app's title bar of the panel: when the list was read, refresh and settings. Sent when it changes. */
  let lastHeader = ''
  function header() {
    if (typeof ctx.panels.header !== 'function') return
    const d = updatedAt ? new Date(updatedAt) : null
    const spec = {
      meta: d ? `updated ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'loading…',
      actions: [
        { id: 'refresh', icon: 'refresh', title: 'Refresh every source' },
        { id: 'settings', icon: 'settings', title: 'Inbox settings' },
      ],
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

  function publish() {
    if (disposed) return
    const t = now()
    header()
    const snap = snapshot(t)
    try {
      ctx.panels.post(PANEL, snap)
    } catch (e) {
      ctx.log.error(`post: ${why(e)}`)
    }
    const b = badgeOf(snap.rows)
    if (b !== lastBadge) {
      lastBadge = b
      ctx.badge(PANEL, b)
    }
  }

  // ---- state upkeep ----

  /** Every item any source lists now, for "last seen" and the notification check. */
  function listedItems() {
    const out = []
    for (const s of sources.values()) for (const it of s.items) out.push({ pluginId: s.pluginId, id: it.id })
    return out
  }

  async function announceWoken(t) {
    const listed = new Set(listedItems().map((x) => `${x.pluginId}\u0000${x.id}`))
    let sent = 0
    for (const e of state.woken(t)) {
      const fresh = t - e.until <= NOTIFY_WITHIN_MS && listed.has(`${e.pluginId}\u0000${e.id}`)
      if (fresh && settings.notifySnooze && sent < NOTIFY_MAX) {
        sent++
        // Not awaited: notify resolves when the notification is shown, and a refresh must not wait.
        ctx.notify(e.title || 'A snoozed item is back', { title: 'Inbox: snooze ended' }).catch((err) => ctx.log.warn(`notify: ${why(err)}`))
      }
      // Marked either way: an old or gone one is never announced later.
      await state.markNotified(e).catch((err) => ctx.log.warn(`state: ${why(err)}`))
    }
  }

  async function reloadShared() {
    try {
      settings = await S.loadSettings(ctx.appStorage)
    } catch (e) {
      ctx.log.warn(`settings: ${why(e)}`)
    }
    try {
      await state.load()
    } catch (e) {
      ctx.log.warn(`state: ${why(e)}`)
    }
  }

  /** The full refresh: shared state, the provider set, every source, the calendar, upkeep. */
  async function tick() {
    if (ticking) return ticking
    ticking = (async () => {
      await reloadShared()
      const fresh = await sync()
      // describe and features again on every full refresh: a provider plugin that reloads with new
      // code (a feature such as `recent` added) stays in the provider list without leaving it, so
      // onChange alone would keep its first answer. Both are host-local calls, nothing on the network.
      // Not one described within the last refresh interval (the first refresh overlaps the join's).
      const t0 = now()
      for (const [id, s] of sources) {
        if (fresh.has(id) || !s.describedAt || t0 - s.describedAt < REFRESH_S * 1000) continue
        s.describing = null
        s.redescribe = true
      }
      await Promise.all([...[...sources.keys()].filter((id) => !fresh.has(id)).map((id) => refreshSource(id)), refreshCalendar()])
      if (disposed) return
      const t = now()
      updatedAt = t
      await state.touch(listedItems(), t).catch(() => {})
      await state.prune(t).catch((e) => ctx.log.warn(`prune: ${why(e)}`))
      await announceWoken(t)
      publish()
    })().finally(() => {
      ticking = null
    })
    return ticking
  }

  // ---- actions from the panel ----

  const rowByKey = (key) => (typeof key === 'string' ? ranked.rows.find((r) => r.key === key && !r.calendar) || null : null)
  // Read rows open like any other, and never take done or snooze (they are done already).
  const readByKey = (key) => (typeof key === 'string' ? lastRead.find((r) => r.key === key) || null : null)

  function setUndo(token, label, t) {
    lastUndo = { token, label, until: t + UNDO_MS }
  }

  async function act(m) {
    const t = now()
    switch (m.type) {
      case 'hello':
      case 'visible':
        await reloadShared()
        publish()
        return
      case 'refresh':
        await tick()
        return
      case 'open': {
        const read = rowByKey(m.key) ? null : readByKey(m.key)
        if (read) {
          const rs = sources.get(read.pluginId)
          if (rs) await call(rs.handle.open(read.id), `${read.pluginId} open`)
          return
        }
        const row = rowByKey(m.key)
        const s = row && sources.get(row.pluginId)
        if (!s) return
        // Opening ends a "back" or a woken snooze (it was seen); it is not done (decision 8).
        await state.restore(row.pluginId, row.id)
        await call(s.handle.open(row.id), `${row.pluginId} open`)
        publish()
        return
      }
      case 'done': {
        const row = rowByKey(m.key)
        if (!row) return
        setUndo(await state.done(row, t), `Done: ${row.title}`, t)
        publish()
        const s = sources.get(row.pluginId)
        if (settings.doneMarksRead && s && s.features.has('markRead')) {
          // The read mark is not undone by Undo: the item is back in Inbox, read at its source.
          await call(s.handle.markRead(row.id), `${row.pluginId} markRead`).catch((e) => ctx.log.warn(`markRead ${row.pluginId}: ${why(e)}`))
        }
        return
      }
      case 'snooze': {
        const row = rowByKey(m.key)
        if (!row || !SNOOZES.has(m.choice)) return
        const until = untilOf(m.choice, t, { afternoon: settings.afternoon, morning: settings.morning })
        setUndo(await state.snooze(row, until, t), `Snoozed: ${row.title}`, t)
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
      case 'markUnread': {
        // A read row back to unread at its source (the Read chip's button). The source's own
        // `changed` follows; re-reading it here moves the row to the list at once.
        const read = readByKey(m.key)
        const s = read && sources.get(read.pluginId)
        if (!s || !read.canUnread) return
        await call(s.handle.markUnread(read.id), `${read.pluginId} markUnread`)
        await refreshSource(read.pluginId)
        publish()
        return
      }
      case 'restore': {
        if (typeof m.pluginId !== 'string' || typeof m.id !== 'string') return
        await state.restore(m.pluginId, m.id)
        publish()
        return
      }
      case 'join': {
        const ev = eventById(m.eventId)
        const url = ev && httpsUrl(ev.meetUrl)
        if (url) await ctx.openExternal(url)
        return
      }
      case 'respond': {
        const ev = eventById(m.eventId)
        if (!ev || !ANSWERS.has(m.answer) || !cal.handle) return
        await call(cal.handle.respond(ev.id, m.answer), 'calendar respond')
        await refreshCalendar()
        publish()
        return
      }
      case 'calOpen': {
        const ev = eventById(m.eventId)
        if (ev && cal.handle) await call(cal.handle.open(ev.id), 'calendar open')
        return
      }
      case 'saveSettings': {
        settings = await S.saveSettings(ctx.appStorage, m.settings)
        // Item counts or a source switched on change what to read.
        await Promise.all([...[...sources.keys()].map((id) => refreshSource(id)), refreshCalendar()])
        publish()
        return
      }
      default:
    }
  }

  async function onPanelMessage(m) {
    if (typeof m !== 'object' || m === null || typeof m.type !== 'string') return
    try {
      await act(m)
    } catch (e) {
      ctx.log.warn(`${m.type}: ${why(e)}`)
      try {
        ctx.panels.post(PANEL, { type: 'notice', text: `${ACTION_NAMES[m.type] || 'That'} failed: ${why(e)}` })
      } catch {
        // the panel went away
      }
    }
  }

  disposers.push(ctx.panels.onMessage(PANEL, onPanelMessage))
  if (typeof ctx.panels.onAction === 'function') {
    disposers.push(
      ctx.panels.onAction(PANEL, (id) => {
        if (id === 'refresh') void tick().catch((e) => ctx.log.warn(`refresh: ${why(e)}`))
        else if (id === 'settings') ctx.panels.post(PANEL, { type: 'view', view: 'settings' })
      })
    )
  }
  disposers.push(feeds.on('changed', onFeedChanged))
  disposers.push(feeds.onChange(() => void sync().then(publish, (e) => ctx.log.warn(`sync: ${why(e)}`))))
  disposers.push(ctx.schedule(REFRESH_S, () => tick()))
  const first = tick().catch((e) => ctx.log.error(`first refresh: ${why(e)}`))

  // ---- `ccc inbox` (lib/cli.js) ----

  if (ctx.cli && typeof ctx.cli.register === 'function') {
    const unregister = ctx.cli.register('inbox', async (argv) => {
      const p = CLI.parse(argv)
      if (p.error) return { stderr: `${p.error}\n`, code: 2 }
      if (p.cmd === 'help') return { stdout: CLI.HELP }
      // The first refresh has per-call timeouts; this deadline is the belt to them.
      let timer
      await Promise.race([first, new Promise((r) => { timer = timers.setTimeout(r, opts.cliWaitMs ?? CLI_WAIT_MS) })])
      timers.clearTimeout(timer)
      const rows = ranked.rows
      if (p.cmd === 'list') return { stdout: CLI.formatList(rows, now()) }
      const got = CLI.resolve(rows, p.target)
      if (got.error) return { stderr: `${got.error}\n`, code: 1 }
      const row = got.row
      const title = CLI.oneLine(row.title, CLI.MAX_TITLE)
      if (row.calendar && p.cmd !== 'open') return { stderr: `"${title}" is a calendar item: it can be opened, not marked done or snoozed.\n`, code: 1 }
      const t = now()
      try {
        if (p.cmd === 'open') {
          await act(row.calendar ? { type: 'calOpen', eventId: row.id } : { type: 'open', key: row.key })
          return { stdout: `Opened ${title}\n` }
        }
        if (p.cmd === 'done') {
          await act({ type: 'done', key: row.key })
          return { stdout: `Done: ${title}\n` }
        }
        const until = untilOf(p.choice, t, { afternoon: settings.afternoon, morning: settings.morning })
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
    for (const s of sources.values()) if (s.timer) timers.clearTimeout(s.timer)
    if (cal.timer) timers.clearTimeout(cal.timer)
    if (cal.unsub) cal.unsub()
    for (const d of disposers) if (typeof d === 'function') d()
  }

  return { first, tick, dispose, act: onPanelMessage, snapshot: () => snapshot(now()), rows: () => ranked.rows, state }
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
