# Inbox (bronos.inbox)

A [cc-cockpit](https://github.com/BronOS/cc-cockpit) plugin: one panel with everything that needs
you, from every plugin that offers an inbox feed (Google Chat, Gmail and Jira today), placed in groups
by your own rules, with done, snooze, undo and search. Calendar's agenda sits above or below the list.

Inbox has no account and makes no network call. It reads the other plugins only through their
services; each source keeps its own sign-in.

**Needs cc-cockpit 0.10.0 or newer** (slots, overlay buttons, the html settings page and the
component stylesheet), and sources that provide `inbox-feed` 2: Gmail 0.5.0, Chat 0.3.0, Jira 0.7.0
and, for the agenda, Calendar 0.3.0. A source that still provides version 1 is not listed (the
Plugins page warns about it).

## What it shows

- **Groups** in your order (by default Now, Chat, Mail, Jira and Rest, which starts collapsed), each
  with its count. Inside a group the newest item is first.
- **Rows**: the source's badge, the title, who and where, the first line of the preview, up to three
  labels, and why the row is where it is ("rule 4: sourceKind is chat", "rule 2: Jev 0.86", "no
  rule"). Actions sit on the right on hover: the source's own, then Done and Snooze.
- **Source lines** above the groups when a source is signed out or failed (its last list stays,
  marked stale), or when it refused or cut items.
- **Search** (`/`) over title, preview, sender, place and labels of every item, Rest and Done
  included, grouped as the list is.
- **Chips**: All, one per source, and Done (today's done and snoozed items, each with "Back to
  inbox").
- **Agenda**: Calendar's page in a slot at the top or the bottom; with no Calendar there is nothing.

## Rules

An ordered list; for each item the first enabled rule that holds puts it in its group, otherwise it
goes to Rest. A rule is either **conditions** (all must hold) or **one Jev question with a
threshold** (conditions before it act as a filter, so Jev is asked only for what passes). Fields:
`source`, `sourceKind`, `title`, `preview`, `from.name`, `from.address`, `to`, `mentionsMe`, `read`,
`place.kind|name|status`, `labels`, `time`. Text compares case-insensitively; each field has its own operators:
`is`, `contains`, `startsWith`, `endsWith` and `in` (not all on every field), `isNot` on `source` and
`sourceKind`, `notContains` on `title` and `preview`, `has`, `hasNot` and `hasPrefix` on `labels`,
`newerThan` and `olderThan` (minutes) on `time`; there are no regular expressions.

Jev answers are cached per question and item version (a new message asks again). While one is
pending the row says "Jev…" and moves at most once when the answer comes; with Jev unavailable the
rule counts as not holding and is tried again later.

Rules are app-wide. The default list: read items go to Rest; Chat mentions and direct messages go to
Now; then each source to its own group.

## Done, snooze, undo

- **Done** (`e`) hides an item until its source reports something new (a reply, a comment, a status);
  it then returns marked "back". Done never touches the source: mark it read there with the row's
  own action.
- **Snooze** (`s`, then `1` to `4`): for 1 hour, until 14:00, until tomorrow 09:00, or until the item
  changes. When it ends the item comes back and you get one notification.
- **Undo** (the toast, `u`, `ccc inbox undo`) takes back the last done or snooze within 6 seconds.

Both are kept app-wide on this machine and dropped 14 days after the item was last listed.

## Settings

The gear in the panel's title bar opens the settings page: groups (add, rename, reorder, delete, with
collapsed and badge), rules (reorder, enable, duplicate, delete, edit inline), **Test** (how many
current items a rule would place, with examples; Jev rules use cached answers only), the sources
(read-only: state and counts), and the agenda position. Changes are saved whole with Save, so a
half-typed rule is never applied. A source is kept out with a rule (`source is X` to Rest) or in that
plugin's own settings.

## Keys

`j` / `k` move, `Enter` opens (the source plugin's own view), `e` done, `s` snooze then `1` to `4`,
`u` undo, `/` search, `Esc` leaves search or closes the snooze menu.

## CLI

```
ccc inbox [list]                  the groups, numbered rows, each with the rule that placed it
ccc inbox open <n|ref>            open an item in its own plugin
ccc inbox act <n|ref> <action>    run one of the item's own actions (markRead, ...)
ccc inbox done <n|ref>            mark it done
ccc inbox undo                    take back the last done or snooze (6 seconds)
ccc inbox why <n|ref>             the full trace: every rule, and why it did not hold
ccc inbox snooze <n|ref> <when>   1h, afternoon, tomorrow or changes
ccc inbox help
```

A ref is `<pluginId>:<id>` and stays valid when the numbers shift. Output is bounded: at most 50 rows,
one cut line each, with control characters removed.

```
Inbox: 2 items
Chat (1)
1. [CHAT] Lunch? (4m) bronos.chat:c1
     rule 4: sourceKind is chat
Mail (1)
2. [MAIL] Invoice (3h) bronos.mail:m/1:x
     rule 5: sourceKind is mail
```

## Adding a source

Any plugin that provides the `inbox-feed` service, version 2, is a source; Inbox needs no release
for it. The contract, in short (full text in [docs/design-v2.md](docs/design-v2.md)):

- A source is a data provider: every item in its stated scope, facts only, with no level, no
  dropping and no cap for Inbox's sake.
- Methods: `describe()` (label, badge, color, kind `chat`, `mail`, `issues` or `other`, scope),
  `snapshot()` (the whole set and its state) and `act(id, action)` (only the item's own listed actions).
- Events: `item` (a new or changed item, whole), `gone` (an id left the scope) and `sync` (the whole
  set and state replaced, after a reconnect).
- An item: `id`, `rev` (changes on something new, not on a read change), `title`, `preview`, `time`,
  `from`, `to` (`direct`, `group` or `cc`), `mentionsMe`, `read` (or null), `place`, `labels` and
  `actions`. Well-known action ids: `open`, `markRead`, `markUnread`, `done`.
- Everything is validated as untrusted input: strings are capped, unknown fields dropped, a bad item
  left out and counted on the source's line; at most 1000 items per source are kept.

## Development

The plugin is plain JavaScript with no build and no dependencies. `npm test` runs the node:test
suites in `test/`. To try it from a checkout: `ccc plugin link <path>` in a cc-cockpit tab.

## License

MIT
