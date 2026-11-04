'use strict'
// Fakes shared by the suites: a cc-cockpit ctx written from `ccc guide api` (0.9.7), with
// `ctx.services.useAll('inbox-feed')` over providers a test adds and removes, a `calendar` provider
// behind `ctx.services.use`, an app-wide store two "windows" can share, and recorded posts, badges,
// notifications and opened links. Every name and id here is example data (Ann Example, APP-1).
// (bronos.calendar's fakes.js, with the services of a collector.)

const NOW = Date.parse('2026-11-03T12:42:00Z')
const HOUR = 3600000

/** A FeedItem as a provider answers it (the design's feed contract). */
function item(id, o = {}) {
  return {
    id,
    rev: o.rev || `${id}-r1`,
    title: o.title || `Item ${id}`,
    from: o.from || 'Ann Example',
    where: o.where || 'Inbox',
    at: o.at === undefined ? NOW - HOUR : o.at,
    level: o.level || 'action',
    unread: o.unread === undefined ? true : o.unread,
    ...(o.direct !== undefined ? { direct: o.direct } : {}),
    ...(o.mentionsMe !== undefined ? { mentionsMe: o.mentionsMe } : {}),
    ...(o.dueAt !== undefined ? { dueAt: o.dueAt } : {}),
    ...(o.jiraKey !== undefined ? { jiraKey: o.jiraKey } : {}),
  }
}

/**
 * A fake `inbox-feed` provider: `items` answers what the test put in `feed.items` (with `state`),
 * and every call is recorded. `opts.markRead === false` plays Jira (no markRead, features []).
 */
function fakeFeed(describe, items = [], opts = {}) {
  const feed = {
    items,
    state: 'ok',
    message: undefined,
    calls: [],
    throwOn: null,
    impl: {
      async describe() {
        feed.calls.push(['describe'])
        return describe
      },
      async features() {
        return [...(opts.markRead === false ? [] : ['markRead']), ...(opts.recent ? ['recent'] : []), ...(opts.markUnread ? ['markUnread'] : [])]
      },
      async items(o) {
        feed.calls.push(['items', o])
        if (feed.throwOn === 'items') throw new Error('feed broke')
        const limit = Math.max(1, Math.min(50, (o && o.limit) || 10))
        return { items: feed.items.slice(0, limit), asOf: NOW, state: feed.state, ...(feed.message ? { message: feed.message } : {}) }
      },
      async open(id) {
        feed.calls.push(['open', id])
      },
    },
  }
  if (opts.recent) {
    // `opts.recent`: the read rows the provider's read lane holds (Chat Recent, Gmail Read).
    feed.recent = opts.recent
    feed.impl.recent = async (o) => {
      feed.calls.push(['recent', o])
      return { items: feed.recent.slice(0, (o && o.limit) || 20), asOf: NOW, state: 'ok' }
    }
  }
  if (opts.markUnread) {
    // As the plugins do: the read row goes back to the unread items.
    feed.impl.markUnread = async (id) => {
      feed.calls.push(['markUnread', id])
      if (feed.throwOn === 'markUnread') throw new Error('chat: Google refused')
      const at = feed.recent.findIndex((it) => it.id === id)
      if (at < 0) throw new Error('chat: unknown id')
      const [it] = feed.recent.splice(at, 1)
      feed.items = [{ ...it, unread: true }, ...feed.items]
    }
  }
  if (opts.markRead !== false) {
    feed.impl.markRead = async (id) => {
      feed.calls.push(['markRead', id])
    }
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
  const calListeners = []
  ctx.emitCalendar = (event, data = {}) => {
    for (const l of calListeners) if (l.event === event) queueMicrotask(() => l.fn(structuredClone(data)))
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
      if (name !== 'calendar') throw new Error(`plugin bronos.inbox does not declare service "${name}" in services.uses`)
      const h = handleOf(() => ctx.calendar && ctx.calendar.impl, 'bronos.calendar')
      return new Proxy(h, {
        get(target, prop) {
          if (prop === 'on') {
            return (event, fn) => {
              const l = { event, fn }
              calListeners.push(l)
              return () => calListeners.splice(calListeners.indexOf(l), 1)
            }
          }
          return target[prop]
        },
      })
    },
    available: (name) => (name === 'calendar' ? Boolean(ctx.calendar) : name === 'inbox-feed' && providers.size > 0),
    provide() {
      throw new Error('Inbox provides nothing')
    },
    emit() {
      throw new Error('Inbox provides nothing')
    },
    caller: () => undefined,
  }
  if (opts.old) delete services.useAll
  return services
}

/** A fake `calendar` provider (the design's calendar contract), recording calls. */
function fakeCalendar(day = {}, upcoming = []) {
  const cal = {
    day: { date: '2026-11-03', events: [], tomorrow: { count: 0 }, state: 'ok', ...day },
    upcoming,
    calls: [],
    impl: {
      async day(o) {
        cal.calls.push(['day', o])
        return cal.day
      },
      async upcoming(o) {
        cal.calls.push(['upcoming', o])
        return cal.upcoming.slice(0, (o && o.count) || 3)
      },
      async respond(id, answer) {
        cal.calls.push(['respond', id, answer])
      },
      async open(id) {
        cal.calls.push(['open', id])
      },
    },
  }
  return cal
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

/** A ctx good enough for dist/host.js. `opts.old`: an app before 0.9.7 (no `useAll`). `opts.appStorage`: share one store. */
function fakeCtx(opts = {}) {
  const panelListeners = []
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
    calendar: opts.calendar || null,
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
        return () => {}
      },
      show() {},
    },
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(structuredClone(m))
    },
    cli: {
      register: (name, fn) => {
        ctx.cliName = name
        ctx.cliHandler = fn
        return () => {}
      },
    },
    async runCli(argv) {
      return ctx.cliHandler(argv, { stdin: '', cwd: '/tmp', signal: new AbortController().signal })
    },
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  ctx.services = fakeServices(ctx, opts)
  return ctx
}

/** Let queued microtasks and promise continuations run. */
const flush = () => new Promise((r) => setImmediate(r))

module.exports = { NOW, HOUR, item, fakeFeed, fakeCalendar, fakeAppStorage, fakeCtx, flush, CHAT, MAIL, JIRA }
