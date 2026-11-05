# Inbox v2 and the `inbox-feed` v2 contract

Status: built as 0.2.0, 2026-11-04 (deviations at the end). Turns decisions 1-8 and 15 of cc-cockpit's
`docs/feedback/20261104-real-work.md` into a design. The app features it builds on (slots, overlay types and
buttons, the html settings page, the component stylesheet) are in cc-cockpit's `docs/design-next.md`. Where a
decision left a detail open, the simplest choice is written in and repeated under Open questions. `docs/design.md`
(v1, 0.1.0) stays as the record of what v1 does; everything it says about ranking, levels, weights, boosts and the
calendar service is replaced here.

## What changes and why

v1 stacked two triages: each source ranked and cut its own items (Jev levels, noise dropped, top N), then Inbox
re-ranked them with weights and boosts. The result was hard to predict and sometimes missing the item that mattered.
v2 splits the roles:

- **A source is a data provider only** (1): every item in its stated scope, facts only. No level, no dropping, no
  grouping, no cap for Inbox's sake.
- **Inbox orders by the person's rules** (2, 8): an ordered list, first match wins, each rule puts the item in a named
  group; newest first within a group. Deterministic: the same items and rules give the same list.
- **Jev is one kind of rule condition** (3), its answer cached per item, so a lower-priority source can still win a
  top place (the manager's mail) without the order moving around.
- **Inbox knows no source** (4): it draws one standard row from the contract and routes a clicked action back to the
  source (`act(id, action)`); the source opens its own overlay, marks read, and so on.
- **Non-row content goes into slots** (5): the agenda is the Calendar plugin's own page in an `agenda` slot the Inbox
  panel places.
- **Inbox hides nothing for good** (15): unplaced items sit in a collapsed Rest group, Done items in a Done view, and
  search covers everything.

## Roles (15)

- **Inbox**: "what needs me now", across sources, by the person's rules. Needs at least one source; has no account,
  no network, no Jev of its own (it uses the `jev` service when a rule asks).
- **Source plugin**: "everything from here" in its own structure (Jira by project and status, Chat by space, Gmail by
  label, Calendar by week). It may run its own Jev triage for its own panel and works without Inbox. For Inbox it is
  only a provider of `inbox-feed` v2.
- **Same item, same actions everywhere**: the actions come from the source (in the item), whether the person clicks
  them in the Inbox row, in the source's panel, or in the item's overlay toolbar.
- **Scope is stated**: each source says what it feeds (`describe().scope`: "unread + read of the last 14 days",
  "my open issues + mentions of the last 14 days") in its panel and settings, and Inbox shows it per source.

## Architecture

```
 bronos.chat ──┐  provide inbox-feed 2: describe, snapshot, act + events item / gone / sync
 bronos.gmail ─┤ ── ctx.services.useAll('inbox-feed') ──► bronos.inbox panel
 bronos.jira ──┘                                           rules → groups, Done memory, search
                                                           │  places slot 'agenda' (top/bottom)
 bronos.calendar ── contributes.slots agenda ──────────────┘  (the app draws Calendar's page there)
 bronos.jev ── provides jev 1 ── services.use('jev') ─────► Inbox (Jev rule conditions only)
```

Manifest of Inbox 0.2.0: `services: { uses: { "inbox-feed": 2, "jev": 1 }, collects: ["inbox-feed"] }`; one panel
`main` with `"slots": ["agenda"]`; `contributes.settings.page` (scope app) for the rules editor; CLI `ccc inbox`. The
`calendar` service is no longer used. Needs the app release with slots, overlay types and settings pages (0.10.x).

## The feed contract (`inbox-feed`, v2)

### Methods (async, plain data)

- `describe()` → `{ label, badge, color, kind, scope }`: `label` 1-24 characters ("Mail"), `badge` 1-6 ("MAIL"),
  `color` one of `green red blue amber violet grey`, `kind` one of `chat mail issues other` (a fact for the default
  rules only, see Rules), `scope` 1-120 characters of plain text, built from the source's settings.
- `features()` → `string[]`: optional methods and events; v2 defines none, so the field is there for later additions
  without a major bump.
- `snapshot()` → `Sync` (below): the source's full current list, from its cache, never an API call. Inbox calls it when
  it activates and whenever a provider joins (`ServiceSet.onChange`).
- `act(id, action)` → `{ ok: true } | { ok: false, message }`: run one of the item's current actions. The source checks
  that `id` is one of its items and `action` is in that item's `actions` (the caller is another plugin). It reflects
  the result with an `item` or `gone` event; Inbox does not change the item itself. `message` at most 300 characters.

### Events (`ctx.services.emit('inbox-feed', event, data)`)

| Event | Data | Meaning |
|---|---|---|
| `item` | `FeedItem` | new or changed (any field); the whole item, never a patch. Rules re-run for it. |
| `gone` | `{ ids: string[] }` (1-500) | no longer the person's business: archived, closed, resolved, out of scope, deleted |
| `sync` | `Sync` | the full current list: at start, after a reconnect or sign-in, after a recovered error, whenever the source is unsure it told everything |

```ts
interface Sync {
  items: FeedItem[]                         // the whole scope, at most 1000
  state: 'ok' | 'signedOut' | 'error'       // non-ok: `items` is the last known list, Inbox marks the source stale
  message?: string                          // ≤ 300, shown on the source's line when state is not ok
  asOf: number                              // ms of the data
}
```

A source emits `item` and `gone` by diffing each poll's result against what it last told (any field change is an
`item`; a missing id is `gone`), plus right after a local action (a mark read in its panel or through `act`).

### How it rides on the services mechanism

No app change is needed for the feed itself. The provider `emit`s; Inbox listens with `useAll('inbox-feed').on(event,
(data, pluginId) => ...)`, which already hears every provider (0.9.7). Event data is `structuredClone`d and dispatched
in the host, with no rate or size limit (it never leaves the host), so a 1000-item `sync` costs a copy, not a round trip.

- **Who sent it** is the `pluginId` the registry passes, never a field in the data: an item's `source` is set by Inbox
  from it, so a provider cannot place items under another source.
- **Missed events**: a provider that emits before Inbox subscribed is covered by `snapshot()` on join. While a
  `snapshot()` for a source is pending, Inbox buffers that source's events and applies them after the snapshot, so an
  older snapshot never overwrites a newer `item`.
- **Order**: events of one provider arrive in emit order (one realm). The last `item` for an id wins.
- One small app addition, not required to work: the Plugins page warns on a collector when an enabled plugin provides
  the collected name at another major ("Gmail provides inbox-feed 1, Inbox reads 2: update Gmail"). Today
  `serviceStatus` marks a collected-only name `collectedOnly` with no problem, so a v1 source would be silently absent.

### The item (6)

```ts
interface FeedItem {
  id: string                    // the source's own stable id
  rev: string                   // changes when something new happens (message, comment, status); not on a read change
  title: string
  preview?: string              // plain text; Jev reads title + preview
  time: number                  // ms of the latest activity: the sort key
  from?: { name?: string; address?: string }
  to?: 'direct' | 'group' | 'cc'
  mentionsMe?: boolean
  read: boolean | null          // null: the source has no read state
  place?: { kind: 'channel' | 'folder' | 'project'; name: string; status?: string }
  labels?: string[]             // free tags: "assigned", "priority:high", "alert", "jira:PROJ-12"
  actions: { id: string; label: string }[]
}
```

| Field | Rule (Inbox validates; the source caps too) | Gmail | Chat | Jira |
|---|---|---|---|---|
| `id` | 1-200 characters, no control characters | thread id | `spaces/S/threads/T` | `PROJ-12` |
| `rev` | 1-100 characters | newest message id | latest message name | `updated` |
| `title` | 1-300, one line (whitespace runs become one space) | subject | conversation name | `PROJ-12 Fix the login redirect` |
| `preview` | at most 1000, one line | snippet | latest message text | latest comment, else description start |
| `time` | finite, > 0 | newest message | latest message | `updatedAt` |
| `from` | `name` ≤ 120, `address` ≤ 254 | lead sender | sender name | last actor or reporter |
| `to` | one of the three or absent | in To / Cc / a list | DM / group chat or space | assigned / watching or mentioned |
| `mentionsMe` | boolean, absent = false | absent | `@you` | mentioned in a comment |
| `read` | boolean or null | `!UNREAD` | read state | seen marks |
| `place` | `name` ≤ 120, `status` ≤ 60 | folder `Inbox` | channel = space name | project key + status name |
| `labels` | at most 20, each 1-40 printable characters, compared case-insensitively | label names, `important`, `category:updates`, `alert`, `jira:KEY` | `alert`, `mention:all`, `jira:KEY` | `assigned`, `mentioned`, `priority:high`, `type:bug`, `due:2026-11-06` |
| `actions` | at most 8; `id` `^[a-z][A-Za-z0-9-]{0,39}$`, `label` 1-40 | open, markRead or markUnread | open, markRead or markUnread | open, markRead or markUnread |

Well-known action ids: `open` (the row click and Enter), `markRead`, `markUnread`, `done` (done **at the source**:
archive, resolve; shown with the source's label). Other ids are the source's own and are shown as plain buttons.
Inbox shows `open` as the row click, the rest as row actions and, in the item's overlay, the source registers the same
actions as toolbar buttons (below).

**Validation in Inbox**: every value is untrusted input. Strings over a cap are cut (titles, previews) or refused
(ids, action ids); unknown fields are dropped; an item that fails (no id, bad `time`, duplicate id in one `sync`) is
left out, logged, and counted on the source's line ("2 items from Mail were refused"), so a refusal is visible.
Everything is drawn as text; a colour is a palette name, never CSS. At most 1000 items per source are kept; past that
the oldest by `time` are left out, with that count on the source's line.

## Inbox's own memory: Done (7)

- **Done** (✓, `e`, the row action and the overlay button "Done (Inbox)") hides an item until an `item` event brings a
  **different `rev`**; the item then returns marked "back: new activity". A read change or a label change alone does
  not bring it back. Done never calls the source: marking read is the source's action, offered next to it.
- Stored per item in `ctx.appStorage` under the v1 key form `st:<pluginId>:<id>` (hashed when too long):
  `{ kind: 'done', rev, at, title, pluginId, id }`. App-wide, so one Done reaches every window on its next read.
  Dropped 14 days after the item was last seen in any feed.
- **Undo** (`u`, a 6 s toast) takes back the last Done.
- **Done view**: a chip lists Done items newest first (title from the live item, else the stored title), each with
  "Back to Inbox" (deletes the entry).
- **Snooze** (v1) stays as Inbox memory too, unchanged except that a woken snooze is placed by the rules like any
  item, marked "back" (there is no score to lift it). See Open questions.

`gone` removes the item from Inbox's set; a Done entry for it stays until pruned, so an item that comes back in scope
with the same `rev` stays done.

## Rules (8)

### Format

The global set is stored in `ctx.appStorage` under `settings` (one key, validated on every read, as v1); a project may
override it whole (see "Per project" below):

```ts
interface InboxSettings {
  version: 2
  groups: Group[]                // display order, at most 20; the built-in group `rest` is always last
  rules: Rule[]                  // evaluation order, at most 200
  agenda: 'top' | 'bottom' | 'off'
}
interface Group { id: string; name: string; collapsed?: boolean; badge?: boolean }   // name 1-40
type Rule = {
  id: string                     // stable, minted by the editor
  name?: string                  // ≤ 60
  enabled: boolean
  group: string                  // a group id, `rest` allowed
} & ({ when: Condition[] }       // 1-20 conditions, all must hold
   | { jev: { question: string; min: number } })   // question 1-300 characters, min 0..1
interface Condition { field: Field; op: Op; value: string | number | boolean | null | string[] }
```

| Field | Ops | Value |
|---|---|---|
| `source` (plugin id), `sourceKind` | `is`, `isNot`, `in` | string, string[] |
| `title`, `preview` | `contains`, `notContains`, `startsWith`, `is` | string ≤ 200 |
| `from.name`, `from.address` | `is`, `contains`, `endsWith`, `in` | string, string[] (`endsWith "@example.com"` for a domain) |
| `to` | `is`, `in` | `direct`, `group`, `cc`, `none` |
| `mentionsMe` | `is` | boolean |
| `read` | `is` | true, false, null |
| `place.kind`, `place.name`, `place.status` | `is`, `contains`, `in` | string, string[] |
| `labels` | `has`, `hasNot`, `hasPrefix` | string |
| `time` | `newerThan`, `olderThan` | minutes, whole number 1..525600 |

String comparisons are case-insensitive (NFKC, lower case). No regular expressions (the app's ReDoS rule; plain
substring and prefix cover the cases so far). `in` lists hold at most 50 values.

### Per project (decision 8)

A project may have its own set: the whole `InboxSettings` (groups, rules and agenda as one unit, since rules name
group ids and cannot be mixed with another set's groups), stored in that project's `ctx.storage` under `settings`.
No key there means **use the global rules** (the default). The set in force in a window is the project's own when it has
one, else the global set; placement, the groups, the agenda slot, Jev rules, the panel and `ccc inbox list/why` all read
that effective set, and `why` names it ("by the global rules:" or "by this project's rules:"; `list` says "by this
project's rules" in its header only for a project's own set).

- Validated on every read like the global one. A stored value that is not a v2 set at all (not an object, no version 2
  or later, groups or rules not lists) is damaged: logged once, and the project uses the global rules (not the defaults,
  which would silently replace the person's rules there). A v2 set with a bad entry is repaired as the global one is.
- Both are read at start, every minute (`tick`), when the panel says `hello` or `visible`, and when the settings page
  opens; a save on either page applies in this window at once. A change that alters the effective set places every
  item again (as a rules edit always did); switching to an override with the same content places nothing again.
- Stay app-wide, whatever set placed an item: Done and snooze (lib/state.js), the Jev answer cache (`jv:` keys; an answer
  belongs to a question and an item, not to a set) and the panel's remembered group open states (`ui:groupsOpen`, keyed
  by group id, so a project's groups share the entry of a global group with the same id). A window keeps the stored
  states of groups its own set lacks (another project's), at most 200 ids, the longest-untouched dropped first.

### Evaluation

For each item not hidden by Done or snooze, rules run in order, enabled ones only; the first that holds places the item
in its group. None holds: the item goes to **Rest** with reason "no rule". Within a group: newest `time` first, then
source and id as a stable tie-break. Rules re-run for one item on its `item` event and on its Jev answer, and for all
items when the rules change.

**Jev conditions** (3). The answer is a `noul` score 0..1 for the question over `title + "\n" + preview` (cut to 1500
characters), asked through `ctx.services.use('jev')` `grid(...)`:

- Cached per question and item version: key `jv:<hash(question)>:<hash(pluginId, id)>` in `ctx.appStorage`, value
  `{ rev, score, at }`. A new `rev` asks again (new content); a read or label change does not. Changing the threshold
  needs no new answer; editing the question text does. Pruned like Done entries.
- Only items that reach the rule are asked (an earlier rule placed the others). Pending questions are batched: one
  `grid` call per question every 2 s at most, 100 items per call.
- **While an answer is pending**, evaluation goes on past the rule as if it did not hold, and the row shows "Jev…"; when
  the answer comes, the item moves at most once, and then stays (cached). That is the only time an item moves without
  a new event or a rules edit.
- **Jev unavailable** (no provider, its cap reached, an error, no answer in 45 s): the rule is treated as not holding,
  nothing is cached, the row's reason says "rule 3 skipped: Jev unavailable", and the question is asked again after 10
  minutes (the item is re-placed then; with no provider, within a minute of one appearing). The settings page shows a
  Jev rule as inactive when no `jev` provider is enabled.
- A placement of every item runs inside `sweep`: requests still queued for items that left the feed or for a question
  edited or deleted are dropped, never asked. A question's queue holds at most 2000 requests.
- Two windows may each ask once for the same item before either has written the cache; the cost is a duplicate
  request, not a different order (both write the same kind of answer; the last write wins).

### Groups, defaults and what a row says

Default settings (also the reset):

| Groups (order) | Rules (order) |
|---|---|
| Now, Chat, Mail, Jira, Rest (collapsed) | 1. `read is true` → Rest · 2. `sourceKind is chat` and `mentionsMe is true` → Now · 3. `sourceKind is chat` and `to is direct` → Now · 4. `sourceKind is chat` → Chat · 5. `sourceKind is mail` → Mail · 6. `sourceKind is issues` → Jira |

That is decision 2's default "by source (Chat, Email, Jira)", plus a Now group for what asks for the person in Chat (an
@mention, a direct message), so Chat itself holds the channel traffic. Jira and Gmail have no such rule: in Jira every
assigned issue is `to: direct` and in Gmail most mail is, so it would empty Mail and Jira into Now. The person then adds rules above them, for example
"`from.address in [lead@example.com]` → Now" and "Jev: Is this urgent? ≥ 0.8 → Now" with a group Now first. A source of
kind `other` lands in Rest until a rule names it. `badge: true` groups count toward the panel's icon badge (default
Chat, Mail, Jira); the badge is the number of unread items in them.

Each row shows why it is where it is, muted at the end of its meta line: `rule 3: Jev 0.86`, `rule 1: from.address is
lead@example.com` (the rule's name instead when it has one), `no rule`. The number is the rule's current position.
`ccc inbox why <n|ref>` prints the full trace (each rule checked, why it did not hold).

## The panel

- **Header** (the app's, `ctx.panels.header`): meta "updated 12:58", a refresh action (calls `snapshot()` on every
  source). The app's gear opens Inbox's settings page.
- **Agenda**: `ctx.panels.slots('main', [{ type: 'agenda', position: 'top' | 'bottom', height: 140 }])` from the
  `agenda` setting, `null` when off. The app draws the Calendar plugin's page there; with no provider there is no
  slot, and Inbox draws nothing in its place. Inbox does not read the calendar.
- **Toolbar**: search (`/`; case-insensitive substring over title, preview, from, place and labels of every item,
  Rest and Done included; results grouped as usual, Done ones marked), chips All / one per source (a view filter) /
  Done.
- **Source lines**: a source whose last `sync` was not ok shows one `.cc-error-line` above the groups ("Mail: signed
  out, showing items from 12:58"), with refused and over-cap counts when there are any.
- **Groups**: `details.cc-group` with name and count; Rest collapsed by default; a group's open state is remembered.
- **Row** (`.cc-row`): source badge, title, from · place · time, the preview's first line (muted), up to 3 labels as
  `.cc-chip`, the rule reason; actions on hover and focus: the source's actions except `open`, then Done. Click or
  Enter runs `act(id, 'open')`.
- **Keys**: `j`/`k` move, Enter opens, `e` Done, `u` undo, `/` search, Esc leaves search.

## The item in an overlay

A source opens its item's overlay itself (the row's `open`), tagged `inbox-item { source: <its plugin id>, id }`
(directly or through the reviewer's `annotate({ ..., type })`), opened at once with `ready: 'manual'` and filled when
the content is there (design-next §3.4). Buttons in the app's toolbar:

- the **source** registers `ctx.overlay.buttons('inbox-item', ...)` and returns its item's current actions (not
  `open`) when `data.source` is its own id and `data.id` is one of its items; `run` calls the same code as `act`;
- **Inbox** registers "Done (Inbox)" for every `inbox-item` it holds (its memory; `run` returns `{ close: true }`);
- core's **Discuss with Claude** (the source's `onDiscuss` supplies the item text).

## Settings page (12)

Inbox has no schema form; its settings are one html page (`contributes.settings.page`, scopes `app` and `project`)
inside the app's central Settings, with the component stylesheet:

- **Groups**: add, rename, reorder, delete (its rules move to Rest), collapsed by default, counts toward the badge.
- **Rules**: the ordered list (move up and down, enable, duplicate, delete); each rule edited inline: its group, then
  either conditions (field, op, value rows) or one Jev question with a threshold. "Test" shows how many current items
  the rule would place and five examples (Jev rules use cached answers only, never a new request).
- **Sources**: read-only list: label, scope, state, item count; a note that a source is kept out with a rule
  (`source is X` → Rest) or in that plugin's own settings.
- **Agenda**: top, bottom, off.

Opened under Settings > Plugins (scope `app`) the page edits the global set. Opened under This Project (scope
`project`) it starts with a **Use the global rules** switch (a checkbox with `role="switch"`: the component stylesheet
has no switch): on (the default, no set of the project's own) it shows the global set read-only, with a line saying
it is the global one and that it is edited under Settings > Plugins; off copies the stored global set into the
project (the host reads it, the page sends no settings) and the page then edits the project's set; turning it back on
asks first, inline ("Discard this project's rules and use the global ones?"; a sandboxed page has no `confirm()`), then
deletes the project's set. The host takes the scope from the app (`page.scope`), never from a message, and refuses a
project save while the project uses the global rules. The panel draws no settings.

## CLI

`ccc inbox [list]` (groups with numbered rows and reasons), `open <n|ref>`, `act <n|ref> <action>`, `done <n|ref>`,
`undo`, `why <n|ref>`, `help`. A ref is `<pluginId>:<id>`. `snooze` stays as in v1.

### Rules and groups (`ccc inbox rules`, `ccc inbox groups`)

A Claude tab asked to change the rules had no way to: they were editable only on the settings page. These commands
read and edit the same sets with the same check and the same save:

- `rules [list]`: which set (the header: "global rules", with "this project uses the global set" or "not in effect
  here", or "this project's rules"), the groups (position, name, id, flags), the numbered rules (on/off, the conditions
  as `why` phrases them, `Jev "<question>" >= <min>`, → group, id) and the agenda. `groups [list]` is the same text.
- `rules export` prints the set as JSON (pretty when it fits the 256 KiB output limit, else compact, else refused:
  never a cut JSON text). `rules import` replaces the whole set with JSON read from stdin.
- Small edits: `rules add <json|-> [--at <n>]`, `set <n> <json|->` (the old id and on/off kept when the JSON has
  none), `rm <n>`, `move <n> <to>`, `enable <n>`, `disable <n>`; `groups add <name> [--badge] [--collapsed] [--at <n>]`
  (default just before Rest), `rename <id|n> <name>`, `rm <id|n>` (its rules go to Rest), `move <id|n> <to>`. Rest
  cannot be removed or moved. A `-` reads the JSON from stdin (the manifest declares `stdin: true`).
- `rules add` without `--at`: after the leading rules that go to Rest, before the first rule that goes to another
  group (at the end when all go to Rest). The leading Rest rules are filters (`read is true`, decided question 3) that
  should keep winning; after them the list runs from specific to general and a new rule is nearly always more specific
  than the per-source catch-alls, which at the end would take its items first.
- `rules test <json|-|n> [--at <n>]`: the page's Test (`testRule`) over the items of this window: a new rule put where
  `add` would put it, or rule n where it stands (a disabled one tried as if enabled); the counts, then up to 20 of the
  items it would place (badge, title, source, ref). Jev rules use cached answers only, and the output says so and how
  many have no answer yet. Nothing is stored.
- **Scope**: no flag is the set in effect in this window (the project's own when it has one, else the global set);
  `--global` the global set; `--project` the project's own set, refused when it has none ("This project uses the
  global rules; make it its own in Settings › This Project, or use --global"). A set of its own is made only by the
  page's switch, never implicitly.
- **One validator, one save path**: an edit builds the next whole set from the stored one (read again first, as the
  page does when it opens) and hands it to `checkSettings`; on any problem nothing is stored and the error names the
  place as a JSON path and by position (`rules[1].when[0].op: rule 2, condition 1: labels takes has, hasNot,
  hasPrefix, not "is"`; `checkSettings` returns `path` beside `reason`). A set that passes is stored by the page's
  `saveSettings` / `saveProjectSettings`: applied in this window at once, read by other windows on their next read.
  Ids missing from a rule or group are minted with the editor's `mintId` (`r1`, `g1`, ...); given ids are kept (and
  checked). Group add, rename and delete are the editor's own `addGroup`, `renameGroup`, `deleteGroup`
  (settings/logic.js). Edits of one window run one at a time; across windows the last whole save wins, as with pages.
  An edit whose call the app has already cancelled (30 s, Ctrl+C) stores nothing.
- The skill `inbox-rules` (`skills/inbox-rules/SKILL.md`) carries the rule format, the field table, the commands and
  the scope rule; `test/skill.test.js` checks its field and op table and caps against `rules.js` and `settings.js`.

## Migration

### Inbox 0.1.0 → 0.2.0

- Settings: v1 sources, weights, levels, boosts and counts have no meaning in v2 and are dropped; the defaults above
  apply. The calendar position carries over (`top`, `bottom`, `off`; "in the list" and "beside" become `top`).
- Done and snooze entries (`st:` keys) carry over: same keys and `rev` semantics. v1's "Done also marks read" setting
  is gone (Done never touches the source).
- The Read chip and `recent` go: read items are in the feed (`read: true`), placed by rule 1 into Rest by default.
- Dedupe of a mail whose `jiraKey` matches a listed issue goes: it was a hidden manipulation; a `jira:KEY` label lets a
  rule do it visibly.

### Gmail (next minor)

- **Stops**: `level` (its Jev verdicts stay in its own lanes), the unread-only filter, the noise rule, `limit`,
  `items`/`recent`/`markRead`/`markUnread` methods and `canUnread`, `jiraKey` as a field, the `changed` event.
- **Scope**: the threads of its Unread and Read lanes (Inbox label, `unreadDays` and the read lane's days), alert
  threads included, each its own item (no alert groups in the feed). `scope`: "unread + read of the last N days".
- **Adds**: fields as in the table (label names through its label map; system labels as `important`, `starred`,
  `category:<name>`; alerts as `alert` and `alert:<name>`); `snapshot`, `act` (open, markRead, markUnread); `item` /
  `gone` from a diff after each poll and after a mark; `sync` after activate's first cached view, after a sign-in and
  after a recovered error; overlay buttons for its `inbox-item`s; `ready: 'manual'` opens; `type` passed to the
  reviewer's `annotate`. Its scope line in its panel and in its settings description.

### Chat (next minor)

- **Stops**: `level`, the Mentions-and-DMs-only filter, the noise rule, `limit`, `recent`, `canUnread` (an item that
  cannot be marked unread simply has no `markUnread` action), `jiraKey` as a field, `changed`.
- **Scope**: unread conversations of every lane (mentions, DMs, spaces, alerts) plus read conversations of the last
  `recentDays`. `scope`: "unread + read of the last N days".
- **Adds**: `to` from the conversation kind, `mentionsMe` from `@you`, `mention:all` and `alert:<name>` labels,
  `place` = the space's display name; the same `snapshot` / `act` / events / buttons / opens as Gmail.

### Jira (next minor)

- **Stops**: `level` and the status hints in the feed (they stay for its lanes), the noise rule, `limit`, `dueAt` as a
  field (a `due:YYYY-MM-DD` label instead), `changed`.
- **Scope**: issues of its Backlog, In progress, On hold and Mentioned lanes (Done is `gone`: closed and resolved
  issues leave the Inbox). `scope`: "my open issues + mentions of the last N days".
- **Adds**: `place` = project key + status name, labels `assigned`, `mentioned`, `priority:<name>`, `type:<name>`,
  `due:…`, Jira labels as `label:<name>`; actions open, markRead / markUnread on its seen marks; `preview` from what
  its cache holds (latest comment, else the description's start); events from the poll diff; buttons; opens.

### Calendar (next minor)

- **Adds**: `contributes.slots: [{ "type": "agenda", "entry": "slots/agenda.html", "minHeight": 48, "maxHeight": 320 }]`
  and `ctx.slots.onOpen('agenda', ...)`: its own page with today's timeline and the now line, the next event with a
  countdown and Join (the backend opens the meeting URL with `ctx.openExternal`), and invitations to answer with
  Accept / Decline (its RSVP). From its event cache, `setHeight` to fit.
- **Keeps** the `calendar` v1 service for other consumers; Inbox stops using it. No `inbox-feed`.

### Others

`bronos.jev-triage` is unchanged: sources may keep it for their own panels. A future source (Forgejo) joins by
providing `inbox-feed` 2, with no Inbox release.

## Versioning: v1 and v2

Recommended: **a clean break**. A plugin provides one major per service name (`services.provides` maps a name to one
version), so coexistence would need a second name (`inbox-feed-2`) or a dual-major provide the app does not have.
Inbox 0.2.0 uses `inbox-feed` 2 only; Gmail, Chat and Jira bump to provide 2 and drop 1; all four plus Calendar's slot
are released together, right after the app release they need. In between, an updated source is invisible to Inbox
0.1.0 and an old source to Inbox 0.2.0 (`useAll` lists only providers at the collector's major); the Plugins page
warning above makes that visible. Only Inbox consumes `inbox-feed`, so nobody else breaks.

## Tests

Inbox (`node:test`): contract validation (each cap, unknown fields, duplicates, wrong types, refused counts); event
application (item, gone, sync, buffering during `snapshot`, a provider leaving); rules (each op, first match, disabled
rules, Rest, the stable order: the same input gives the same list); Jev (cache key with `rev`, pending then one move,
unavailable then retry, no request from "Test"); Done (`rev` change brings it back, a read change does not; prune);
settings migration from 0.1.0. Sources: the poll diff emitter (item on any field change, gone on a missing id, sync on
reconnect), field mapping and caps, `act` refusing a foreign id or an action the item does not have, overlay button
attribution. App side: the existing collector e2e grows an `item` / `gone` / `sync` case.

## Decided questions

All accepted as recommended (Oleg, 2026-11-04).

1. Clean break (feed 2 only, all released together) or coexistence through a second name? Recommended: clean break.
2. Keep snooze in v2 (the decisions name only Done)? Recommended: keep, unchanged, placed by rules when it wakes.
3. Default rule 1 `read is true → Rest`? Recommended: yes, else the read history fills the source groups.
4. Allow field conditions before a Jev question in one rule (so Jev is asked only for mail)? Recommended: yes, as a pre-filter evaluated first.
5. Jev cache keyed by `rev` (a new message re-asks) or by item only? Recommended: by `rev`.
6. Add `due?: number` to the item for "due within N days" rules? Recommended: not now; `due:` label.
7. Per-source on/off in Inbox settings? Recommended: no; a rule to Rest, or the source's own setting.
8. Rules per project as well as app-wide? Recommended: app-wide only. **Changed (Oleg, 2026-11-05)**: a project may
   override the whole set (groups, rules, agenda) in its `ctx.storage`, with "use the global rules" as the default; work
   and personal projects need different sources and rules. Done, snooze and the Jev cache stay app-wide ("Per project").
9. Calendar invitations as `inbox-feed` items (Accept / Decline actions)? Recommended: later; agenda slot only now.
10. "In the Inbox" marks in source panels (decision 15, optional): an `inbox` service with placements by id? Recommended: later.
11. App: warn on the Plugins page when a provider's major differs from a collector's? Recommended: yes, in the same app release.
12. At most 1000 items kept per source? Recommended: yes, with the over-cap count shown.

## As built (0.2.0)

- `ccc inbox`: `list` prints a header per non-empty group with its count, each row numbered across groups, and the
  placing rule's reason on a line under it; at most 50 rows. `why` runs `traceItem` over the effective settings with
  cached Jev answers only (it never asks Jev), cut to 60 lines. `undo` honours the 6 s window of the panel's toast.
  `act` checks the action id shape here and the item's list of actions in the host. `snooze` is as in v1.
- Snooze keeps v1's fixed times (1 h, 14:00, 09:00, until it changes); the settings have no snooze fields.
- The Read chip and `recent` are gone; the badge counts unread items in the groups marked `badge`.
- The settings page edits a draft and saves it whole; the field table comes from the host.
