---
name: inbox-rules
description: Use when asked to add, change, remove, reorder, test or explain the rules or groups of the cc-cockpit Inbox plugin (bronos.inbox), for example "put mail from X in Now", "why is this in Rest", "make a group for invoices", "stop showing Jira in the inbox", "move newsletters out of the way", or when an inbox item is in the wrong group.
---

# Inbox rules and groups (`ccc inbox rules`, `ccc inbox groups`)

The Inbox panel lists items from its sources (Chat, Mail, Jira and any other `inbox-feed` plugin) in
groups. Where an item goes is decided by an ordered list of rules: for each item the **first enabled
rule that holds** puts it in that rule's group; when no rule holds it goes to **Rest**. The rules and
groups are edited with the commands below; every change is checked the same way as a Save on the
Inbox settings page and applies at once.

## How to work

1. Run `ccc inbox rules` first: it prints which set this window uses, the groups (number, name, id)
   and the numbered rules (on or off, what each checks, its group, its id).
2. To explain a placement, run `ccc inbox` (the list, each row with the rule that placed it) and
   `ccc inbox why <n|ref>` (every rule tried for that item and why it did not hold).
3. Before adding or changing a rule, try it: `ccc inbox rules test '<rule json>'` (a new rule, put where
   `add` would put it, or `--at <n>`) or `ccc inbox rules test <n>` (an existing rule). It lists the
   current items of this window it would place; nothing is stored.
4. Prefer small edits (`rules add`, `set`, `move`, `enable`, `disable`, `rm`, `groups add` ...) over
   `rules import`: an import replaces the whole set, groups and agenda included.
5. Tell the person what you changed, in words, and which set (global or this project's).

Order matters: an earlier rule wins. A rule like "mail from my lead → Now" must stand above the
catch-all `sourceKind is mail → Mail`, or that one takes the mail first.

## Which set (the scope rule)

There is one global set, used by every project, and a project may have its own set instead (groups,
rules and agenda together). The person makes a project's own set only on the settings page (Settings ›
This Project, by turning off "Use the global rules"); the commands never create one.

- No flag: the set in effect in this window (this project's own set when it has one, else the global
  set). The first line of `ccc inbox rules` says which one.
- `--global`: the global set, even in a project that has its own (then the change does not show in
  this window; the output says so).
- `--project`: this project's own set; refused when the project has none ("this project uses the
  global rules; make it its own in Settings › This Project, or use --global"). Do not work around the
  refusal: ask the person whether the change is meant for every project (`--global`) or whether they
  want to give this project its own set on the settings page.

## Commands

```
ccc inbox rules [--global|--project]          groups, numbered rules, agenda
ccc inbox rules export                        the whole set as JSON
ccc inbox rules import -                      replace the whole set with JSON from stdin
ccc inbox rules add <json|-> [--at <n>]       add one rule
ccc inbox rules set <n> <json|->              replace rule n (keeps its id and on/off when the JSON has none)
ccc inbox rules rm <n>                        remove rule n
ccc inbox rules move <n> <to>                 move rule n to place <to>
ccc inbox rules enable <n>                    turn rule n on
ccc inbox rules disable <n>                   turn rule n off
ccc inbox rules test <json|-|n> [--at <n>]    dry run: what the rule would place now
ccc inbox groups [--global|--project]         the same listing
ccc inbox groups add <name> [--badge] [--collapsed] [--at <n>]
ccc inbox groups rename <id|n> <name>
ccc inbox groups rm <id|n>                    its rules then go to Rest
ccc inbox groups move <id|n> <to>
ccc inbox help
```

Every command takes `--global` or `--project`. Numbers are the positions `ccc inbox rules` prints
(1 is the first; disabled rules count). A group is named by its id or its position.

- Quote the JSON as one shell argument (single quotes), or pass `-` and pipe it on stdin:
  `echo '{"group":"now","when":[...]}' | ccc inbox rules add -`. `rules import -` reads stdin:
  `ccc inbox rules export > /tmp/inbox.json`, edit, then `ccc inbox rules import - < /tmp/inbox.json`.
  stdin is read only for a `-` argument, so the other commands never wait on it.
- `rules add` without `--at` puts the rule after the leading rules that go to Rest (filters such as
  the default `read is true → Rest`) and before the first rule that goes to any other group; at the
  end when every rule goes to Rest. Use `--at` when the rule belongs elsewhere.
- `groups add` puts the group just before Rest unless `--at` says otherwise; Rest is always last.
- On any problem nothing is stored and the error names the place, as a JSON path into the whole set
  and by position: `Nothing stored: rules[1].when[0].op: rule 2, condition 1: labels takes has,
  hasNot, hasPrefix, not "is"`. Fix that part and run the command again.
- Exit codes: 0 done, 1 refused (nothing stored), 2 a usage error.

## The set

```json
{
  "version": 2,
  "groups": [
    { "id": "now", "name": "Now", "collapsed": false, "badge": true },
    { "id": "rest", "name": "Rest", "collapsed": true, "badge": false }
  ],
  "rules": [
    { "id": "read", "enabled": true, "group": "rest", "when": [{ "field": "read", "op": "is", "value": true }] },
    { "id": "r1", "name": "Lead", "enabled": true, "group": "now", "when": [{ "field": "from.address", "op": "is", "value": "lead@example.com" }] }
  ],
  "agenda": "top"
}
```

- `version`: 2. `agenda`: `top`, `bottom` or `off` (where the Calendar agenda sits in the panel).
- **Groups**: at most 20 groups, Rest included. `id`: a letter or digit, then letters, digits, `_` or `-`, at
  most 40 characters, unique. `name`: 1 to 40 characters. `collapsed`: starts closed. `badge`: its
  unread items count toward the panel's badge. **Rest** (id `rest`) is built in: always there and
  always last; it can be renamed and its flags set, never removed. Removing a group sends its rules
  to Rest.
- **Rules**: at most 200. `id` as for groups, unique; minted (`r1`, `r2`, ...) when a rule has none,
  and kept when given. `name` (optional, 1 to 60 characters) replaces the conditions in the row's
  reason. `enabled` (default true). `group`: a group id of the same set (`rest` allowed).
- A rule has `when` (1 to 20 conditions, all must hold), or `jev` (one Jev question), or both.

### Conditions

`{ "field": ..., "op": ..., "value": ... }`. Text compares case-insensitively (the value and the item's
text both lower-cased); there are no regular expressions. An `in` op takes a list of 1 to 50 values of
the field's kind and holds when the item's value is one of them.

| Field | Ops | Value |
|---|---|---|
| `source` | `is`, `isNot`, `in` | a source plugin id (text), for example `bronos.mail` |
| `sourceKind` | `is`, `isNot`, `in` | `chat`, `mail`, `issues` or `other` |
| `title` | `contains`, `notContains`, `startsWith`, `is` | text |
| `preview` | `contains`, `notContains`, `startsWith`, `is` | text |
| `from.name` | `is`, `contains`, `endsWith`, `in` | text |
| `from.address` | `is`, `contains`, `endsWith`, `in` | text (`endsWith` `@example.com` for a domain) |
| `to` | `is`, `in` | `direct`, `group`, `cc` or `none` (how the item reached the person) |
| `mentionsMe` | `is` | true or false |
| `read` | `is` | true, false or null (null: the source has no read state) |
| `place.kind` | `is`, `contains`, `in` | text: `channel`, `folder` or `project` |
| `place.name` | `is`, `contains`, `in` | text (the channel, folder or project name) |
| `place.status` | `is`, `contains`, `in` | text (for example a Jira status) |
| `labels` | `has`, `hasNot`, `hasPrefix` | text (one label) |
| `time` | `newerThan`, `olderThan` | whole minutes, 1 to 525600 |

Text values are 1 to 200 characters on one line. A field the item lacks holds only for the negative
ops (`isNot`, `notContains`, `hasNot`). A source's plugin id is the part before the colon of each
row's ref in `ccc inbox` (`bronos.mail:...`).

### Jev conditions

`"jev": { "question": "Is this urgent?", "min": 0.8 }`: Jev (a cheap model, the `jev` plugin) scores
the item's title and preview against the question from 0 to 1; the rule holds at `min` or above
(`min` from 0 to 1, the question 1 to 300 characters). With `when` too, the conditions are a filter
checked first, so Jev is asked only for the items that pass them (`when` sourceKind is mail, then
the question). Answers are cached per item version; a new message asks again. While an answer is
pending the rule does not hold (the row says "Jev…" and moves once when it comes); with no Jev
provider the rule never holds. `rules test` uses cached answers only and says how many items have no
answer yet; it never asks Jev.

## Examples

- "Put mail from my lead in Now":
  `ccc inbox rules test '{"group":"now","when":[{"field":"from.address","op":"is","value":"lead@example.com"}]}'`,
  then the same JSON with `rules add`.
- "Make a group for invoices": `ccc inbox groups add Invoices --badge`, read its id from the output,
  then `ccc inbox rules add '{"group":"<id>","when":[{"field":"title","op":"contains","value":"invoice"}]}'`.
- "Keep the RSS source out": `ccc inbox rules add '{"group":"rest","when":[{"field":"source","op":"is","value":"<plugin id>"}]}' --at 1`.
- "Why is this in Rest?": `ccc inbox why <n>`: "no rule" means none held; the trace says why each failed.
- "Urgent mail first": `{"group":"now","when":[{"field":"sourceKind","op":"is","value":"mail"}],"jev":{"question":"Is this urgent?","min":0.8}}`.
