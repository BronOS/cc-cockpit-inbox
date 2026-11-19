---
worth: yes
added: 2026-11-19
---
# Mark read and Done close the item overlay (a setting, on by default)

Oleg's request (2026-11-19): in an item overlay (`inbox-item`), pressing Mark read or Done closes the overlay. This is a
setting, and it is on by default.

What happens today (the toolbar buttons come from each plugin through `ctx.overlay.buttons`; a button closes the
overlay when its `run` returns `{ close: true }`):
- Inbox's "Done (Inbox)": already closes (`dist/host.js:810`).
- GitHub and Gitea: Done closes; Mark read and Mark unread do not (`dist/lib/overlay.js:156` and `:168`).
- Gmail: Mark read and Mark unread do not close (`dist/host.js` `overlayButtons`, ~1169); it has no Done.
- Jira: no overlay buttons.

Still open: where the setting lives. Each plugin's buttons run in that plugin's own host, so one switch in Inbox does
not reach them directly. The options:
- (a) A setting per source plugin (simple, but several switches for one wish).
- (b) One Inbox setting, passed to the openers in the overlay's type data or through the inbox-feed service.
- (c) A core overlay setting, plus a button hint (for example `closes: 'after-action'`) that core honours.

Mark unread probably stays open in every option, since it is a "look again later" action. Decide that together with
the setting.
