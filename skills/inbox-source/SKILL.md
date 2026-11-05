---
name: inbox-source
description: Use when asked to write, change or debug a cc-cockpit plugin that feeds the Inbox plugin (bronos.inbox), or any provider of the inbox-feed service; examples are a Forgejo, GitHub, GitLab, Linear, Slack or RSS source, "a new source for the inbox" or "show X in my inbox".
---

# Writing an Inbox source (`inbox-feed` v2)

The Inbox plugin lists what needs the person from every plugin that provides the `inbox-feed`
service at major 2. A new source is a plugin of its own; Inbox needs no change and no release.

Read `contract.md` in this skill's folder before writing code: it holds the whole contract (manifest,
methods, events, every item field with its caps, actions, validation, a host skeleton). Run
`ccc guide` for the general plugin API (manifest, host, services, overlays, settings, secrets) and
`ccc guide plugins` for the manifest rules.

The rules that matter most:

- A source is a pure data provider: every item in its stated scope, facts only. No levels, no
  priorities, no dropping, no caps for the Inbox's sake. Inbox places the items by the person's rules.
- Sign-in, settings and polling stay in the source plugin; Inbox has no account.
- Answers come from the source's cache, never from a live API call inside `snapshot()`.
- Everything a source sends is validated as untrusted input; a bad item is left out and counted.
- The closest real model for an issues or code-review source (a Forgejo plugin, say) is the Jira
  plugin, repo `BronOS/cc-cockpit-jira`: its `dist/host.js` (`inbox-feed` section) and `dist/lib/feed.js`.
