# Inbox (bronos.inbox)

Status: draft 2026-11-03, from the user's answers and the mock-up (`docs/mockup.html`, approved as
"just perfect"). External plugin (own repo `BronOS/cc-cockpit-inbox`, for the marketplace), built
like the Gmail, Chat, Jira and Calendar plugins. The user's daily driver: one panel that merges the
top items of Chat, Mail and Jira, re-ranked by Inbox's own rules, with today's calendar.

Prior art: the old cockpit's inbox daemon and its Today view
(`~/Projects/claude-config/mods/inbox/cockpit/`: `views/today.js` drew the hour timeline, the inbox
had done and snooze). Port its decisions, not its user-specific text.

## Decisions (the user, 2026-11-03)

1. **Sources are configurable**: which plugin feeds each source, whether it is on, how many items it
   gives (decisions 4).
2. **Only through the plugins' services**: Inbox never reads another plugin's storage or calls its
   APIs; it knows one data shape (the feed contract below), not Gmail, Chat or Jira.
3. **Own ranking, configurable**: score = level + source weight + boosts − age. The level decides
   across sources and the weight only orders items of one level, so an urgent Jira ticket ("PROD is
   down") beats a Chat action item although Chat has the highest weight. Defaults: urgent 300,
   action 150, fyi 50, noise hidden; weights Chat 30, Mail 15, Jira 0.
4. **Items per source** are a setting (defaults 10 / 10 / 8).
5. **One list** with a source badge (CHAT / MAIL / JIRA), sorted by score. No Jev: the items come
   triaged by their plugins (each plugin's own jev-triage use); Inbox only re-ranks.
6. **A click opens the item the way its plugin does**: the feed's `open(id)` runs the plugin's own
   open (the reviewer overlay, with the Jira companion where the plugin shows one).
7. **Calendar**: the old cockpit's timeline as a strip with a now line, a "next event" card with
   Join, and a few upcoming events with Accept for an unanswered invitation. Its position is a
   setting: top (default), bottom, in the list (the next event pinned as a CAL item shortly before it
   starts), beside the list when the panel is wide, off.
8. **Items leave the list** three ways: the source drops it (read in Chat, archived in Gmail, the
   issue left the filter); **Done** (hidden until it changes; by default also marks it read at the
   source, Jira only hidden); **Snooze** (1 hour, this afternoon, tomorrow morning, until it
   changes). Undo after both; a "Done & snoozed" view to put one back. Opening is not done.
9. **Name**: Inbox.

## Architecture

```
 bronos.chat ──provides inbox-chat ───┐
 bronos.gmail ─provides inbox-mail ───┼──► bronos.inbox (one panel)
 bronos.jira ──provides inbox-issues ─┤        ranks, done/snooze, calendar strip
 bronos.calendar provides calendar ───┘
```

- A service has one provider per project (the Plugins page picks one when several plugins provide
  it), so each source is its own service name: **`inbox-chat`, `inbox-mail`, `inbox-issues`** (one
  contract, `feed` below, the same for all three) and **`calendar`** (its own contract). The source
  plugins provide them; Inbox `uses` all four, each optional at run time
  (`ctx.services.available`). Decision 1 is then the app's own provider pick (Settings > Plugins >
  "Plugin used for inbox-issues": Jira today, Forgejo one day) plus Inbox's per-source settings.
- Manifest: `services: { uses: { "inbox-chat": 1, "inbox-mail": 1, "inbox-issues": 1, "calendar": 1 } }`;
  one panel (default zone right); CLI `ccc inbox` (list, done, snooze, for Claude and scripts). No
  OAuth, no secrets, no network: Inbox has no account of its own.
- **Cheap reads**: a feed answers from the provider's own cache (what its panel shows), never with an
  API call, so Inbox polling it costs nothing. The provider emits `changed` after each of its polls;
  Inbox re-reads on that event (debounced 1 s) and every 60 s as a fallback.
- Every value from a feed is untrusted input: validated, strings capped (title 300, from/where 120),
  at most 50 items a call, unknown fields dropped, rendered as text.

## The feed contract (`inbox-chat`, `inbox-mail`, `inbox-issues`, v1)

Methods (all async, plain data):

- `features()` → `string[]`: which optional methods exist (`markRead`); lets a method be added later
  without a major bump (the reviewer's `features()` pattern).
- `items({ limit })` → `{ items: FeedItem[], asOf: number, state: 'ok' | 'signedOut' | 'error', message?: string }`.
  Ordered by the provider's own triage, best first; `limit` clamped to 1..50. Noise is left out
  unless the provider has nothing else. With `signedOut` / `error` the last cached items still come
  (the mock-up's "Jira: signed out, showing the last 4 items from 12:58").
- `open(id)` → `void`: open the item the way the plugin's own row click does.
- `markRead(id)` → `void` (optional; Chat and Gmail): mark it read at the source. Jira has none.
- Event `changed` `{}`: the provider's cache changed (a poll finished, the person acted in its panel).

```ts
interface FeedItem {
  id: string            // the provider's own id, stable (thread id, message name, issue key)
  rev: string           // changes when something new happens (a new message, comment, status);
                        // Inbox's "done until it changes" compares it
  title: string         // subject, message text start, "KEY summary"
  from: string          // sender / person / "assigned to you · High"
  where: string         // DM, space name, label, issue status
  at: number            // ms of the latest activity (age and "come back at the top")
  level: 'urgent' | 'action' | 'fyi' | 'noise'   // the provider's triage, Jev or rules
  unread: boolean
  direct?: boolean      // a DM, or the person is in To
  mentionsMe?: boolean
  dueAt?: number        // issues: the due date
  jiraKey?: string      // mail and chat: the issue an item is about (Gmail and Chat already find it)
}
```

## The calendar contract (`calendar`, v1)

- `day({ date? })` → `{ date, events: CalEvent[], tomorrow: { count, first? }, state, message? }`
  (today by default; declined events left out per the Calendar plugin's setting).
- `upcoming({ count, days })` → `CalEvent[]` (count ≤ 20, days ≤ 30).
- `respond(id, 'accepted' | 'tentative' | 'declined')` → `void`: the plugin's own RSVP.
- `open(id)` → `void`: the event's page the way the Calendar panel opens it.
- Event `changed` `{}`.

`CalEvent`: `{ id, title, start, end, allDay, response: 'accepted' | 'tentative' | 'declined' | 'needsAction' | null, meetUrl?: string }`
(`meetUrl` https only; Join opens it with `ctx.openExternal`).

## Ranking

`score = level + weight(source) + boosts − min(agePenalty × hours, ageCap)`, highest first, ties by
`at` (newer first). Defaults, all settings:

| Part | Default |
|---|---|
| Level urgent / action / fyi | 300 / 150 / 50 (noise: hidden) |
| Weight Chat / Mail / Jira | 30 / 15 / 0 |
| Unread | +10 |
| Direct or mentions me | +20 |
| Due within 2 days (issues) | +25 |
| Age | −5 an hour, at most −40 |

- The settings page says the rule: keep a weight below the gap between levels (150) and the level
  decides; a bigger weight makes that source win across levels (the person's choice).
- **Dedupe**: a mail or chat item whose `jiraKey` matches a listed issue is hidden (setting "Hide a
  Jira mail when its issue is listed", on); the issue row shows "+1 mail".
- **Calendar in the list** (position "in the list"): the next event becomes a CAL item 30 min (a
  setting) before it starts, placed under the urgent items, with Join; it leaves when the event ends.
- An FYI divider above the first fyi item; the first 9 shown, "Show all" for the rest.

## Done and snooze

- State per item key `<service>:<id>`: `{ kind: 'done' | 'snooze', rev, at, until? }` in
  `ctx.appStorage` (app-wide: one inbox, done in one window is done in all; main applies the calls
  one at a time). Kept 14 days after the item was last seen, then dropped.
- **Done** (✓, `e`): hidden while the item's `rev` is the one stored; a new `rev` brings it back with
  "back: new reply". With "Done also marks read at the source" (on) Inbox calls `markRead` when the
  feed has it.
- **Snooze** (⏱, `s`, then `1`–`4`): 1 hour; this afternoon (14:00, a setting); tomorrow morning
  (9:00, a setting); until it changes. A snooze that ends brings the item back at the top for the
  rest of the day (score +500 until opened or done) and once as a notification (setting, on).
- **Undo** (toast for 6 s, `u`) and the **Done & snoozed** chip (today's, each with "Back to inbox").
- Keys in the panel: `j`/`k` move, Enter opens, `e` done, `s` snooze, `u` undo.

## Panel

As the mock-up: header (Inbox, updated time, refresh, settings), chips All / Chat / Mail / Jira with
counts and Done & snoozed, the calendar block where its setting puts it, the list, the key hints.
A source that is off or has no provider is left out of the chips; one with `signedOut` / `error`
shows its line above the list. Badge: the number of urgent items (setting: urgent + action, off).

## Work in the source plugins (one release each, before Inbox)

- **Chat 0.2.0**: provide `inbox-chat` from its rows (mentions and DMs): `rev` = latest message
  name, `markRead` = its mark-read write, `open` = its row open.
- **Gmail 0.4.0**: provide `inbox-mail`: `rev` = history id or the newest message id, `markRead` =
  `setThreadUnread(false)`, `jiraKey` from its Jira finder.
- **Jira 0.6.0**: provide `inbox-issues` beside `jira`: `rev` = `updated`, `dueAt`, `open` = its issue
  view with the companion.
- **Calendar 0.2.0**: provide `calendar` from its event cache; `respond` = its RSVP.
- Each with tests (contract shape, caps, `changed` after a poll) and a guide line in its README.

## Open questions

1. Badge: urgent only (proposed), or urgent + action?
2. A second issue source (Forgejo) later: a slot `inbox-code`, or let `inbox-issues` take several
   providers (a core change: services have one provider per project today)?
3. Should snooze state also travel between machines? Proposed: no (app storage is local).
