# The `inbox-feed` v2 contract

(Source of truth: the Inbox plugin's `docs/design-v2.md` and `dist/lib/feed.js`. This file is checked
against that code by a test; if the two differ, the code wins.)

## Manifest of a source

```json
{
  "services": { "provides": { "inbox-feed": 2 } }
}
```

- A plugin provides one major per name: `inbox-feed` 2 only. A source at major 1 is invisible to the
  Inbox. A source may provide other services too, and may `uses` what it needs (Jira uses `reviewer`).
- Needs cc-cockpit 0.10.0 or newer (feed events ride on `ctx.services.emit`, the item overlay on
  `ctx.overlay.buttons`). There is no manifest field for an app version: say it in the plugin's
  `description` ("Needs cc-cockpit 0.10.0.").
- Guard the calls like Jira does: `typeof ctx.services.provide === 'function'` and the same for `emit`,
  so an older app never breaks the plugin.

## Methods (provided with `ctx.services.provide('inbox-feed', { ... })`, async, plain data)

- `describe()` -> `{ label, badge, color, kind, scope }`. `label` 1-24 characters ("Forgejo"), `badge`
  1-6 ("FJ", shown upper case), `color` one of `green red blue amber violet grey` (a name, never CSS),
  `kind` one of `chat mail issues other` (a fact for the default rules), `scope` 1-120 characters of
  plain text built from the source's settings ("my open issues + review requests").
- `features()` -> `string[]`. Return `[]`; v2 defines no names.
- `snapshot()` -> `Sync` (below): the full current list from the cache. Inbox calls it at start and
  whenever the provider joins. Await your own first load, then answer; do not call the API here.
- `act(id, action)` -> `{ ok: true }` or `{ ok: false, message }` (message one line, at most 300). Run
  one of the item's current actions. The caller is another plugin: check that `id` is one of your
  items and `action` is in that item's `actions`, else refuse. Reflect the result with an `item` or
  `gone` event; Inbox never changes the item itself. Answer within 10 s (Inbox gives each call 10 s):
  for `open`, resolve once the overlay has started, not when it closes.

## Events (`ctx.services.emit('inbox-feed', event, data)`)

| Event | Data | Meaning |
|---|---|---|
| `item` | one `FeedItem` | new or changed (any field); the whole item, never a patch |
| `gone` | `{ ids: string[] }` (1-500) | no longer the person's business: closed, merged, out of scope, deleted |
| `sync` | `Sync` | the whole current list: after start, a reconnect or sign-in, a recovered error, or whenever unsure |

```ts
interface Sync {
  items: FeedItem[]                         // the whole scope, at most 1000
  state: 'ok' | 'signedOut' | 'error'       // non-ok: items is the last known list; Inbox marks the source stale
  message?: string                          // at most 300, shown on the source's line when not ok
  asOf: number                              // ms of the data (finite, > 0)
}
```

Emit `item` and `gone` by diffing each poll's result against what you last told Inbox (any field change
is an `item`; a missing id is `gone`; chunk `gone` at 500 ids), and right after a local action. Emit a
`sync` when the Sync state (kind or message) changes. Wrap `emit` in try/catch: it must never break a poll.
Event order of one provider is kept; the last `item` for an id wins. Who sent an event is the plugin id
the app passes, never a field, so a source cannot place items under another source.

## The item

```ts
interface FeedItem {
  id: string                    // the source's own stable id
  rev: string                   // changes when something NEW happens; not on a read change
  title: string
  preview?: string              // plain text
  time: number                  // ms of the latest activity: the sort key
  from?: { name?: string; address?: string }
  to?: 'direct' | 'group' | 'cc'
  mentionsMe?: boolean          // absent = false
  read: boolean | null          // null: the source has no read state
  place?: { kind: 'channel' | 'folder' | 'project'; name: string; status?: string }
  labels?: string[]
  actions: { id: string; label: string }[]
}
```

| Field | Rule |
|---|---|
| `id` | required; 1-200 characters, no control characters; refused (never cut) when bad |
| `rev` | required; 1-100 characters (a message id, an `updated` timestamp) |
| `title` | required; 1-300, one line (whitespace runs become one space), cut when longer |
| `preview` | at most 1000, one line, cut; Jev reads title + preview |
| `time` | required; finite number > 0, ms of the latest activity |
| `from` | `name` at most 120, `address` at most 254 (the author, last actor) |
| `to` | `direct` (assigned / DM), `group`, `cc` (watching, copied) or absent |
| `mentionsMe` | boolean |
| `read` | boolean or null |
| `place` | `kind` one of `channel`, `folder`, `project`; `name` at most 120; `status` at most 60 (project key + status) |
| `labels` | at most 20, each 1-40 printable characters, compared case-insensitively (first spelling kept) |
| `actions` | at most 8; `id` matches `^[a-z][A-Za-z0-9-]{0,39}$`, `label` 1-40; duplicates dropped |

`rev` semantics: it changes when something new happens (a comment, a status change, a new commit), so a
snoozed or done item comes back; it must not change when only the read state changes. Jira uses
`updated`; Gmail the newest message id.

Labels are free tags the person's rules match: `assigned`, `mentioned`, `priority:high`, `type:bug`,
`due:2026-11-06`, `alert`, `jira:KEY`. Use a `prefix:value` shape for facts.

Well-known action ids: `open` (the row click and Enter; always offer it), `markRead`, `markUnread`
(only when the source has read state; an item that cannot be marked unread simply lacks the action),
`done` (done at the source: archive, resolve, close; shown with the source's label). Any other id is the
source's own and is shown as a plain button.

## Validation the Inbox applies (untrusted input)

- A string over its cap is cut (title, preview, names, labels) or the item refused (id, rev, action id);
  unknown fields are dropped; a wrong-typed optional field is left out.
- An item missing `id`, `rev`, `title` or a valid `time` is left out. A duplicate id in one Sync: the
  first wins, the rest are refused. Every refusal is counted on the source's line ("2 items from
  Forgejo were refused"), so a mistake is visible; test your items against the table above.
- At most 1000 items per source are kept. Past that the oldest by `time` are left out and counted.
  Do not cap for the Inbox's sake: send the whole scope, keep it small by choosing the scope.
- A malformed Sync is a source error with no items. A `gone` with bad ids counts them as refused.
- Everything is drawn as text; a colour is a palette name.

## The item in an overlay

The `open` action shows the item in an overlay (a page, or the reviewer plugin's diff for code review).
Rules the Inbox and the app rely on:

- Open it with `ctx.overlay.start({ ..., ready: 'manual', type: { name: 'inbox-item', data: { source: ctx.pluginId, id } } })`
  (or pass the same `type` to the reviewer's `annotate`). `ready: 'manual'` shows the loader at once;
  signal ready when the page has drawn the content.
- Register toolbar buttons with `ctx.overlay.buttons('inbox-item', (info) => [...])`. Return the item's
  current actions except `open`, as `{ id, label, run }` where `run` calls the same code as `act`; return
  `[]` unless `info.type.data.source === ctx.pluginId` and `info.type.data.id` is one of your current items.
- Check `info.opener` (the app's record of who opened the overlay; `data` comes from the opener and is
  untrusted): only your own plugin id, or the reviewer plugin you handed the item to
  (`ctx.services.provider('reviewer')`), may get your item buttons. Another plugin opening an overlay
  that names your item gets none. A `run` that fails should throw after showing the error in your panel.
- `handle.onDiscuss` supplies the item's text for "Discuss with Claude".

## Skeleton of a source host

```js
'use strict'
exports.activate = (ctx) => {
  let sent = new Map() // what Inbox was last told: id -> item
  let started = false
  const ready = loadFirstView() // your cache fill; never block activate on the network

  const items = () => buildFeedItems(cache) // from the cache, the whole scope, at most 1000
  const stateOf = () => (notConfigured() ? { state: 'signedOut', message: 'Not configured' }
    : authRefused() ? { state: 'signedOut', message: 'Token refused' }
    : lastError ? { state: 'error', message: lastError } : { state: 'ok' })
  const sync = () => {
    const list = items()
    sent = new Map(list.map((i) => [i.id, i]))
    return { items: list, ...stateOf(), asOf: lastPoll || Date.now() }
  }
  const emit = (event, data) => {
    try { ctx.services.emit('inbox-feed', event, data) } catch (e) { ctx.log.warn('inbox-feed:', e.message) }
  }
  // After each poll and each local action: tell only what changed.
  const emitChanges = () => {
    if (!started) return
    const next = items()
    for (const it of next) if (JSON.stringify(sent.get(it.id)) !== JSON.stringify(it)) emit('item', it)
    const gone = [...sent.keys()].filter((id) => !next.some((i) => i.id === id))
    for (let i = 0; i < gone.length; i += 500) emit('gone', { ids: gone.slice(i, i + 500) })
    sent = new Map(next.map((i) => [i.id, i]))
  }
  ready.then(() => { started = true; emit('sync', sync()) })

  ctx.services.provide('inbox-feed', {
    describe: () => ({ label: 'Forgejo', badge: 'FJ', color: 'violet', kind: 'issues', scope: scopeLine() }),
    features: () => [],
    snapshot: async () => { await ready; return sync() },
    act: async (id, action) => {
      const item = items().find((i) => i.id === id)
      if (!item) return { ok: false, message: `${id} is not in the scope` }
      if (!item.actions.some((a) => a.id === action)) return { ok: false, message: `${id} has no action "${action}"` }
      try { await run(item, action); emitChanges(); return { ok: true } }
      catch (e) { return { ok: false, message: String(e.message || e).slice(0, 300) } }
    },
  })
  ctx.overlay.buttons('inbox-item', (info) => ownItemButtons(info)) // see "The item in an overlay"
}
```

`loadFirstView`, `buildFeedItems`, `run`, `ownItemButtons` and the polling are yours. Jira's
`dist/host.js` is the worked version (feed section: `feedSync`, `emitFeed`, `feedAct`, `overlayButtons`,
`trustedOpener`) and `dist/lib/feed.js` its item builder and diff.

## What existing sources changed (worked examples)

- Gmail and Jira dropped their own priority `level`, unread-only filters, noise rules, `limit`, and
  `changed` events from the feed (the levels stay inside their own panels), and now send the whole scope.
- Jira: scope "my open issues + mentions of the last N days"; a Done issue is `gone`; `place` = project key
  + status name; labels `assigned`, `mentioned`, `priority:<name>`, `type:<name>`, `due:YYYY-MM-DD`,
  `label:<name>`; actions `open`, `markRead` / `markUnread` on its own seen marks; `preview` from its
  cache (latest comment, else the description's start); events from the poll diff.
- Gmail: threads of its unread and read lanes; system labels as `important`, `starred`, `category:<name>`,
  alerts as `alert`; `sync` after its first cached view, a sign-in and a recovered error.
- A Forgejo source would follow Jira: kind `issues`, one item per issue or pull request in scope
  (assigned, review requested, mentioned), `place` = repo + state, labels such as `assigned`,
  `review-requested`, `type:pr`, `rev` from the `updated_at` of the last comment or push.

## Checklist

1. Manifest provides `inbox-feed` 2; description says the app version needed.
2. describe/features/snapshot/act provided; snapshot answers from the cache after the first load.
3. `sync` at start and after sign-in or recovery; `item` / `gone` from a diff after each poll and action.
4. Every item has `id`, `rev`, `title`, `time`, `read`, `actions` (with `open`); caps respected.
5. Item overlay opened with the `inbox-item` type and `ready: 'manual'`; buttons check the opener.
6. Tests with a fake `ctx`: item shapes against the table, the diff, `act` refusing unknown ids.
