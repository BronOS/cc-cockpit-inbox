# Inbox (bronos.inbox)

A [cc-cockpit](https://github.com/BronOS/cc-cockpit) plugin: one panel with everything that needs
you, from every plugin that offers an inbox feed (Google Chat, Gmail and Jira today), ranked by your
own rules, with done, snooze and undo, and today's calendar as a strip with the next meeting and
Join.

Inbox has no account and makes no network call. It reads the other plugins only through their
services and never their data; each source keeps its own sign-in and its own triage.

**Needs cc-cockpit 0.9.7 or newer.** Older apps refuse the manifest, because they do not know
`services.collects`.

## Sources

Any plugin that provides the `inbox-feed` service (v1) is a source. When it is enabled it joins the
list, on and with the defaults of its kind; when it is disabled or uninstalled it leaves. Inbox
needs no release for a new source: a plugin only has to provide the feed. The contract is in
[docs/design.md](docs/design.md#the-feed-contract-inbox-feed-v1).

| Plugin | Version | Feed |
|---|---|---|
| bronos.chat | 0.2.0 | mentions and DMs, `markRead` |
| bronos.gmail | 0.4.0 | unread threads, `markRead`, the Jira key a mail is about |
| bronos.jira | 0.6.0 | your issues, with due dates |
| bronos.calendar | 0.2.0 | the `calendar` service (the strip, the next event, RSVP) |

## Ranking

`score = level + source weight + boosts − age`, highest first.

- Levels: urgent 300, action 150, fyi 50. Noise is never shown.
- Weights: Chat 30, Mail 15, Jira 0, set per source.
- Boosts: unread +10, a direct message or a mention +20, an issue due within 2 days +25.
- Age: −5 an hour, at most −40.

The level decides across sources: an urgent Jira ticket ("PROD is down", 310) beats a Chat action
item (210) although Chat weighs more. Keep a weight below the gap between levels (150) to keep it
that way; a bigger weight makes its source win across levels, if that is what you want. Select a row
to see how its score was made.

A mail about an issue that Jira already lists is hidden, and the issue shows "+1 related" (a setting).

## Done, snooze, undo

- **Done** (✓ or `e`) hides an item until it changes: a new reply, comment or status brings it back,
  marked "back: new reply". By default, done also marks the item read at its source where the source
  can do that (Chat and Gmail; Jira items are only hidden here).
- **Snooze** (⏱ or `s`, then `1`–`4`): for 1 hour, until this afternoon (14:00), until tomorrow
  morning (9:00), or until the item changes. When the snooze ends, the item comes back at the top for
  the rest of the day, and you get one notification.
- **Undo** (the toast, or `u`) takes back the last done or snooze within 6 seconds. A read mark set
  at the source stays.
- **Done & snoozed** (the chip) lists today's items, each with "Back to inbox".

Done and snooze are kept app-wide on this machine: an item done in one window is gone in all of
them. Nothing syncs between machines. An entry is dropped 14 days after its item was last listed.

## Calendar

The block shows today's strip (half hours busy, not answered or free, and the now marker), the next
meeting with Join, and the next few events, with Accept for an invitation you have not answered.
Its position is a setting:

- **Top** (the default) or **Bottom**.
- **In the list**: no block; the next meeting becomes a row, under the urgent items, 30 minutes
  before it starts.
- **Beside the list**: when the panel is wide, otherwise at the top.
- **Off**.

## Keys

`j` / `k` move, `Enter` opens (the source plugin's own view), `e` done, `s` snooze then `1`–`4`,
`u` undo, `Esc` closes the snooze menu.

## Settings

Open them with the gear in the panel's title bar. The settings are:

- each source: on, items, weight;
- the levels, boosts and age;
- the Jira dedupe;
- whether done marks read and whether a done item comes back;
- the afternoon and morning times;
- the snooze notification;
- what the badge counts: urgent items (the default), urgent and action, all items, or off;
- the calendar's position, the number of upcoming events, the pin minutes and the strip's hours.

A source that left keeps its row, greyed, so it comes back with your values.

## CLI

```
ccc inbox                         the ranked list
ccc inbox open <n|ref>            open an item in its own plugin
ccc inbox done <n|ref>            mark it done
ccc inbox snooze <n|ref> <when>   1h, afternoon, tomorrow or changes
ccc inbox help
```

`ccc inbox` prints one line per item: the number, badge, level, title, age, and a stable ref
(`<pluginId>:<id>`).

```
Inbox: 2 items
1. [JIRA] urgent APP-77 PROD down: checkout returns 502 (6m) bronos.jira:APP-77
2. [CHAT] action @you please approve the release notes (22m) bronos.chat:spaces/AAA/messages/BBB
```

## Development

The plugin is plain JavaScript with no build and no dependencies. `npm test` runs the node:test
suites in `test/`. To try it from a checkout: `ccc plugin link <path>` in a cc-cockpit tab.

## License

MIT
