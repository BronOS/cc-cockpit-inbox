'use strict'
// Fakes shared by the suites: a cc-cockpit ctx written from `ccc guide api` (0.10.0), with
// `ctx.services.useAll('inbox-feed')` over providers a test adds and removes, a `jev` provider behind
// `ctx.services.use`, an app-wide store two "windows" can share, and recorded posts, badges, headers,
// slot placements, overlay type buttons, notifications and opened links. Every name and id here is
// example data (Ann Example, APP-1). (bronos.calendar's fakes.js, with the services of a collector.)

const NOW = Date.parse('2026-11-03T12:42:00Z')
const HOUR = 3600000

/** A v2 FeedItem (design-v2 "The item") as a provider emits it. */
function item2(id, o = {}) {
  return {
    id,
    rev: o.rev || `${id}-r1`,
    title: o.title || `Item ${id}`,
    time: o.time === undefined ? NOW - HOUR : o.time,
    read: o.read === undefined ? false : o.read,
    actions: o.actions || [{ id: 'open', label: 'Open' }],
    ...(o.preview !== undefined ? { preview: o.preview } : {}),
    ...(o.labels !== undefined ? { labels: o.labels } : {}),
    ...(o.extra || {}),
  }
}

/**
 * A fake `inbox-feed` v2 provider: `snapshot()` answers `{ items: feed.items, state, message, asOf }`.
 * `feed.hold()` makes the next snapshot wait until the returned `release()` is called, answering what
 * `feed.items` held when the snapshot was asked (a snapshot that resolves late, after newer events).
 * `feed.throwOn` = 'snapshot' | 'describe' | 'act' makes that call reject; `feed.actReply` is what `act` answers.
 */
function fakeFeedV2(describe, items = [], opts = {}) {
  const feed = {
    items,
    state: 'ok',
    message: undefined,
    calls: [],
    throwOn: null,
    held: null,
    hold() {
      let release
      const gate = new Promise((r) => (release = r))
      feed.held = gate
      return () => release()
    },
    impl: {
      async describe() {
        feed.calls.push(['describe'])
        if (feed.throwOn === 'describe') throw new Error('describe broke')
        return describe
      },
      async features() {
        feed.calls.push(['features'])
        return opts.features || []
      },
      async snapshot() {
        feed.calls.push(['snapshot'])
        if (feed.throwOn === 'snapshot') throw new Error('snapshot broke')
        const answer = { items: structuredClone(feed.items), state: feed.state, asOf: NOW, ...(feed.message ? { message: feed.message } : {}) }
        if (feed.held) {
          const gate = feed.held
          feed.held = null
          await gate
        }
        return answer
      },
      async act(id, action) {
        feed.calls.push(['act', id, action])
        if (feed.throwOn === 'act') throw new Error('act broke')
        return feed.actReply || { ok: true }
      },
    },
  }
  return feed
}

const CHAT = { label: 'Chat', badge: 'CHAT', color: 'green', kind: 'chat' }
const MAIL = { label: 'Mail', badge: 'MAIL', color: 'red', kind: 'mail' }
const JIRA = { label: 'Jira', badge: 'JIRA', color: 'blue', kind: 'issues' }

/** A handle like the app's: every property but `on` is an async method, data copied both ways. */
function handleOf(getImpl, label) {
  return new Proxy(
    { on: () => () => {} },
    {
      get(target, prop) {
        if (prop in target) return target[prop]
        if (prop === 'then') return undefined
        return async (...args) => {
          const impl = getImpl()
          if (!impl) throw new Error(`plugin ${label} no longer provides service "inbox-feed"`)
          if (typeof impl[prop] !== 'function') throw new Error(`service "inbox-feed" (plugin ${label}) has no method "${String(prop)}"`)
          return structuredClone(await impl[prop](...structuredClone(args)))
        }
      },
    }
  )
}

/**
 * The collector's side of the services API: `useAll('inbox-feed')` lists `providers` (pluginId ->
 * fake feed) in insertion order; `addProvider` / `removeProvider` change the set and fire onChange
 * once per turn; `emitFeed(pluginId, event, data)` reaches `set.on` listeners with the id.
 */
function fakeServices(ctx, opts) {
  const providers = new Map()
  const eventListeners = []
  const changeListeners = []
  let changeQueued = false
  const changed = () => {
    if (changeQueued) return
    changeQueued = true
    queueMicrotask(() => {
      changeQueued = false
      for (const fn of changeListeners) fn()
    })
  }
  ctx.feedListenerCount = () => eventListeners.length + changeListeners.length
  ctx.addProvider = (pluginId, feed) => {
    providers.set(pluginId, feed)
    changed()
  }
  ctx.removeProvider = (pluginId) => {
    providers.delete(pluginId)
    changed()
  }
  ctx.emitFeed = (pluginId, event, data = {}) => {
    for (const l of eventListeners) if (l.event === event) queueMicrotask(() => l.fn(structuredClone(data), pluginId))
  }
  const services = {
    useAll(name) {
      if (name !== 'inbox-feed') throw new Error(`plugin bronos.inbox does not declare service "${name}" in services.collects`)
      return Object.freeze({
        providers: () => [...providers.keys()].map((pluginId) => ({ pluginId, handle: handleOf(() => providers.get(pluginId)?.impl, pluginId) })),
        on: (event, fn) => {
          const l = { event, fn }
          eventListeners.push(l)
          return () => eventListeners.splice(eventListeners.indexOf(l), 1)
        },
        onChange: (fn) => {
          changeListeners.push(fn)
          return () => changeListeners.splice(changeListeners.indexOf(fn), 1)
        },
      })
    },
    use(name) {
      if (name !== 'jev') throw new Error(`plugin bronos.inbox does not declare service "${name}" in services.uses`)
      return handleOf(() => ctx.jev && ctx.jev.impl, 'bronos.jev')
    },
    available: (name) => (name === 'jev' ? Boolean(ctx.jev) : name === 'inbox-feed' && providers.size > 0),
    provide() {
      throw new Error('Inbox provides nothing')
    },
    emit() {
      throw new Error('Inbox provides nothing')
    },
    caller: () => undefined,
  }
  if (opts.old || (opts.missing || []).includes('useAll')) delete services.useAll
  return services
}

/**
 * A fake `jev` provider: `grid(items, questions)` answers `score(item, question)` (default 0.9) for
 * every item as a `noul` answer and records each call. `jev.fail` makes the next calls reject.
 */
function fakeJev(score = () => 0.9) {
  const jev = {
    calls: [],
    fail: false,
    score,
    impl: {
      async grid(items, questions) {
        jev.calls.push({ items, questions })
        if (jev.fail) throw new Error('jev: cap reached')
        const [qid, q] = Object.entries(questions)[0]
        const results = {}
        for (const it of items) results[it.id] = { answers: { [qid]: { noul: jev.score(it, q.instructions) } } }
        return { results, stats: {} }
      },
    },
  }
  return jev
}

/** The app-wide store (ctx.appStorage), shared by two ctxs to play two windows. Calls are atomic, a get-then-set is not. */
function fakeAppStorage() {
  const store = new Map()
  return {
    map: store,
    async get(k) {
      return store.has(k) ? structuredClone(store.get(k)) : undefined
    },
    async set(k, v) {
      if (typeof k !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(k)) throw new Error(`bad storage key ${k}`)
      store.set(k, structuredClone(v))
    },
    async delete(k) {
      store.delete(k)
    },
    async keys() {
      return [...store.keys()]
    },
    async increment(k, by = 1) {
      const v = store.has(k) ? store.get(k) : 0
      if (typeof v !== 'number') throw new Error(`${k} is not a number`)
      store.set(k, v + by)
      return v + by
    },
  }
}

/**
 * A ctx good enough for dist/host.js. `opts.old`: an app before 0.10.0 (no `useAll`, `slots` or
 * `overlay.buttons`); `opts.missing`: a list of those names to leave out one by one. `opts.appStorage`:
 * share one store. `opts.jev`: a `fakeJev` provider (none by default).
 */
function fakeCtx(opts = {}) {
  const panelListeners = []
  const actionListeners = []
  const pageOpeners = []
  const ctx = {
    api: 1,
    pluginId: 'bronos.inbox',
    settings: Object.freeze({ project: {}, app: {} }),
    posts: [],
    badges: [],
    logs: [],
    external: [],
    notes: [],
    schedules: [],
    jev: opts.jev || null,
    headers: [],
    slotPlacements: [],
    overlayButtons: new Map(),
    appStorage: opts.appStorage || fakeAppStorage(),
    storage: fakeAppStorage(),
    log: {
      info: (...a) => ctx.logs.push(['info', a.join(' ')]),
      warn: (...a) => ctx.logs.push(['warn', a.join(' ')]),
      error: (...a) => ctx.logs.push(['error', a.join(' ')]),
    },
    badge: (panel, v) => ctx.badges.push(v),
    schedule(seconds, fn) {
      const s = { seconds, fn, stopped: false }
      ctx.schedules.push(s)
      return () => {
        s.stopped = true
      }
    },
    async notify(text, o) {
      ctx.notes.push({ text, opts: o === undefined ? undefined : structuredClone(o) })
      return { clicked: false }
    },
    async openExternal(url) {
      ctx.external.push(url)
    },
    panels: {
      post: (panel, m) => {
        if (JSON.stringify(m).length > 1024 * 1024) throw new Error('panel message over 1 MiB')
        ctx.posts.push(structuredClone(m))
      },
      onMessage: (panel, fn) => {
        panelListeners.push(fn)
        return () => panelListeners.splice(panelListeners.indexOf(fn), 1)
      },
      header: (panel, spec) => ctx.headers.push(structuredClone(spec)),
      onAction: (panel, fn) => {
        actionListeners.push(fn)
        return () => actionListeners.splice(actionListeners.indexOf(fn), 1)
      },
      slots: (panel, placements) => ctx.slotPlacements.push(structuredClone(placements)),
      show() {},
    },
    slots: {
      onOpen() {
        throw new Error('Inbox provides no slot')
      },
      available: async () => true,
    },
    overlay: {
      buttons: (type, provider) => {
        ctx.overlayButtons.set(type, provider)
        return () => ctx.overlayButtons.delete(type)
      },
    },
    settingsPage: {
      onOpen: (fn) => {
        pageOpeners.push(fn)
        return () => pageOpeners.splice(pageOpeners.indexOf(fn), 1)
      },
    },
    /**
     * The settings page opened in this window: the host's `onOpen` listeners get a page like the app's
     * (`scope`, `post`, `onMessage`, `onClose`). Resolves `{ posts, send(m), close(), last(type) }`;
     * `send` waits for the host's handlers, `posts` are copies, as the port's JSON would make them.
     */
    openSettingsPage(scope = 'app') {
      const listeners = []
      const closers = []
      const page = {
        posts: [],
        async send(m) {
          for (const fn of listeners) await fn(structuredClone(m))
        },
        close() {
          for (const fn of closers.splice(0)) fn()
        },
        last(type) {
          return [...page.posts].reverse().find((m) => m.type === type)
        },
      }
      const instance = Object.freeze({
        scope,
        post: (m) => {
          if (JSON.stringify(m).length > 1024 * 1024) throw new Error('settings page message over 1 MiB')
          page.posts.push(JSON.parse(JSON.stringify(m)))
        },
        onMessage: (fn) => {
          listeners.push(fn)
          return () => listeners.splice(listeners.indexOf(fn), 1)
        },
        onClose: (fn) => {
          closers.push(fn)
          return () => closers.splice(closers.indexOf(fn), 1)
        },
      })
      for (const fn of pageOpeners) fn(instance)
      return page
    },
    /** The header action `id` clicked. */
    clickAction(id) {
      for (const fn of actionListeners) fn(id)
    },
    /** The overlay type buttons Inbox shows for an `inbox-item` overlay with this data. */
    async buttonsFor(data, type = 'inbox-item') {
      const provider = ctx.overlayButtons.get(type)
      return provider ? provider(structuredClone({ type: { name: type, data }, title: 'An item', opener: 'bronos.mail' })) : []
    },
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(structuredClone(m))
    },
    cli: {
      register: (name, fn) => {
        ctx.cliName = name
        ctx.cliHandler = fn
        return () => {
          ctx.cliHandler = null
        }
      },
    },
    async runCli(argv) {
      return ctx.cliHandler(argv, { stdin: '', cwd: '/tmp', signal: new AbortController().signal })
    },
    /** What a host still holds on this ctx: panel and action listeners, overlay providers, running timers, the CLI, feed subscriptions. */
    live() {
      return {
        panel: panelListeners.length,
        actions: actionListeners.length,
        overlay: ctx.overlayButtons.size,
        timers: ctx.schedules.filter((s) => !s.stopped).length,
        cli: Boolean(ctx.cliHandler),
        feed: ctx.feedListenerCount(),
        settingsPage: pageOpeners.length,
      }
    },
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  ctx.services = fakeServices(ctx, opts)
  const missing = opts.old ? ['slots', 'overlay.buttons'] : opts.missing || []
  if (missing.includes('slots')) delete ctx.slots
  if (missing.includes('overlay.buttons')) delete ctx.overlay.buttons
  return ctx
}

/** Let queued microtasks and promise continuations run. */
const flush = () => new Promise((r) => setImmediate(r))

module.exports = { NOW, HOUR, item2, fakeFeedV2, fakeJev, fakeAppStorage, fakeCtx, flush, CHAT, MAIL, JIRA }
