'use strict'
// `ccc inbox ...`: argument parsing and the printed text. Pure: the host resolves a target to a row and
// runs the action. Provider text (titles) is untrusted, so every line printed here is one line, free of
// control characters, and cut.

const { SNOOZE_CHOICES } = require('./util')

const MAX_ROWS = 50
const MAX_TITLE = 120
const MAX_REASON = 240
const CHOICES = SNOOZE_CHOICES
const CAL_REF = 'calendar'

const ACTION_ID = /^[a-z][A-Za-z0-9-]{0,39}$/
const MAX_TRACE_LINES = 60

const HELP = `ccc inbox: the list of what needs you, in groups by your rules (bronos.inbox)

  ccc inbox [list]                       the groups, each row numbered, with its badge, title, age, ref and the rule that placed it
  ccc inbox open <n|ref>                 open the item in its own plugin (marks nothing done)
  ccc inbox act <n|ref> <action>         run one of the item's own actions at its source (markRead, ...)
  ccc inbox done <n|ref>                 mark it done in Inbox (the source is not touched)
  ccc inbox undo                         take back the last done or snooze (within 6 seconds)
  ccc inbox why <n|ref>                  the full trace: each rule checked, and why it did not hold
  ccc inbox snooze <n|ref> <choice>      choice: 1h, afternoon, tomorrow or changes (until the item changes)
  ccc inbox help                         this text

<n> is the number in the list as it stands now; <ref> is the stable reference printed at the end of each
row (<pluginId>:<id>).

Rules and groups. Without a flag a command works on the set in effect in this window: this project's own
set when it has one, else the global rules. --global works on the global set; --project on this project's
own set, and is refused when the project has none (it gets one only in Settings › This Project).

  ccc inbox rules [--global|--project]          the set: groups (n, name, id, flags), numbered rules (on/off, what each checks → group, id), agenda
  ccc inbox rules export                        the whole set as JSON on stdout
  ccc inbox rules import -                      replace the whole set with JSON read from stdin
  ccc inbox rules add <json|-> [--at <n>]       add one rule; default place: after the leading rules that go to Rest, before the first that goes elsewhere
  ccc inbox rules set <n> <json|->              replace rule n (its id and on/off are kept when the JSON has none)
  ccc inbox rules rm <n>                        remove rule n
  ccc inbox rules move <n> <to>                 move rule n to place <to>
  ccc inbox rules enable <n>                    turn rule n on
  ccc inbox rules disable <n>                   turn rule n off
  ccc inbox rules test <json|-|n> [--at <n>]    dry run over this window's items: what the rule would place (Jev: cached answers only); stores nothing
  ccc inbox groups [--global|--project]         the same listing as rules
  ccc inbox groups add <name> [--badge] [--collapsed] [--at <n>]   a new group, by default just before Rest
  ccc inbox groups rename <id|n> <name>         rename a group (Rest too)
  ccc inbox groups rm <id|n>                    remove a group; its rules then go to Rest
  ccc inbox groups move <id|n> <to>             move a group (Rest stays last)

A rule is JSON: {"group": "now", "when": [{"field": "from.address", "op": "endsWith", "value": "@example.com"}]}, or
with "jev": {"question": "Is this urgent?", "min": 0.8} (alone, or after "when" as a filter); "name" and "enabled" are
optional and an id is minted when there is none. "-" reads the JSON from stdin. Every change is checked whole, like a
Save on the settings page: on any problem nothing is stored and the error names the place (rules[2].when[0].op).
The change applies at once. The inbox-rules skill has the full field and operator table.
`

/** One line, no control characters (C0, DEL, C1, line and paragraph separators, zero-width and bidi controls), cut to \`max\`. */
function oneLine(s, max) {
  const t = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** "4m", "2h", "3d"; "now" under a minute, "-" without a time. */
function age(at, now) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '-'
  const m = Math.floor(Math.max(0, now - at) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}

const refOf = (row) => `${row.calendar ? CAL_REF : oneLine(row.pluginId, 80)}:${oneLine(row.id, 120)}`

/**
 * The list as the groups hold it: a header per non-empty group, then its numbered rows with the reason
 * (the rule that placed the row) under each. Rows come in group order; the first MAX_ROWS are shown.
 * `setName` goes in the first line when given (the host gives it for a project's own rules only).
 */
function formatList(rows, now, setName = null) {
  if (!rows.length) return 'Inbox zero.\n'
  const by = setName ? ` by ${oneLine(setName, 40)}` : ''
  const shown = rows.slice(0, MAX_ROWS)
  const out = [`Inbox: ${rows.length} item${rows.length === 1 ? '' : 's'}${by}${rows.length > shown.length ? ` (first ${shown.length} shown)` : ''}`]
  const totals = new Map()
  for (const r of rows) totals.set(r.groupId, (totals.get(r.groupId) || 0) + 1)
  let last = null
  shown.forEach((r, i) => {
    if (r.groupId !== last) {
      last = r.groupId
      out.push(`${oneLine(r.group, 40) || '-'} (${totals.get(r.groupId)})`)
    }
    out.push(`${i + 1}. [${oneLine(r.badge, 12)}] ${oneLine(r.title, MAX_TITLE)} (${age(r.at, now)}) ${refOf(r)}`)
    if (r.reason) out.push(`     ${oneLine(r.reason, MAX_REASON)}`)
  })
  return `${out.join('\n')}\n`
}

/**
 * The trace for \`why\`: the item, the set that placed it (`setName`: "the global rules" or "this
 * project's rules"), then one bounded line per rule and the placement.
 */
function formatWhy(row, traceText, setName = null) {
  const lines = String(traceText).split('\n')
  const out = [`${oneLine(row.title, MAX_TITLE)} (${refOf(row)})`]
  if (setName) out.push(`by ${oneLine(setName, 40)}:`)
  for (const l of lines.slice(0, MAX_TRACE_LINES)) out.push(oneLine(l, MAX_REASON))
  if (lines.length > MAX_TRACE_LINES) out.push(`… ${lines.length - MAX_TRACE_LINES} more lines`)
  return `${out.join('\n')}\n`
}

/** @returns {{ cmd: string, target?: string, choice?: string, action?: string } | { error: string }} */
function parse(argv) {
  const [cmd = 'list', ...rest] = argv
  const usage = (m) => ({ error: `${m}\nUsage: ccc inbox [list] | open <n|ref> | act <n|ref> <action> | done <n|ref> | undo | why <n|ref> | snooze <n|ref> ${CHOICES.join('|')} | rules ... | groups ... | help` })
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return { cmd: 'help' }
  if (cmd === 'list') return rest.length ? usage('list takes no arguments') : { cmd }
  if (cmd === 'undo') return rest.length ? usage('undo takes no arguments') : { cmd }
  if (cmd === 'act') {
    if (!rest.length) return usage('act needs a number or a ref and an action id')
    if (rest.length < 2) return usage('act needs an action id (the item\'s own, e.g. markRead)')
    if (rest.length > 2) return usage('act takes a number or ref and one action id')
    if (!ACTION_ID.test(rest[1])) return usage(`bad action id "${oneLine(rest[1], 40)}"`)
    return { cmd, target: rest[0], action: rest[1] }
  }
  if (cmd === 'open' || cmd === 'done' || cmd === 'why') {
    if (!rest.length) return usage(`${cmd} needs a number or a ref (see ccc inbox)`)
    if (rest.length > 1) return usage(`${cmd} takes one number or ref`)
    return { cmd, target: rest[0] }
  }
  if (cmd === 'snooze') {
    if (!rest.length) return usage('snooze needs a number or a ref and a choice')
    if (rest.length < 2) return usage(`snooze needs a choice: ${CHOICES.join(', ')}`)
    if (rest.length > 2) return usage('snooze takes a number or ref and one choice')
    if (!CHOICES.includes(rest[1])) return usage(`unknown snooze choice "${oneLine(rest[1], 40)}": use ${CHOICES.join(', ')}`)
    return { cmd, target: rest[0], choice: rest[1] }
  }
  return usage(`unknown command "${oneLine(cmd, 40)}"`)
}

/** A row of the current list by number or ref, or an error message. */
function resolve(rows, target) {
  if (/^\d+$/.test(target)) {
    const n = Number(target)
    const row = rows[n - 1]
    if (!row) return { error: rows.length ? `No item ${n}: the list has ${rows.length} (ccc inbox).` : 'No item: the inbox is empty.' }
    return { row }
  }
  // A ref is printable, so it is cut and cleaned (refOf): two ids that differ only past 120
  // characters, or in control characters, print the same ref. Never pick one of those silently.
  const hits = rows.filter((r) => refOf(r) === target)
  if (!hits.length) return { error: `No item with ref "${oneLine(target, 80)}" in the list (ccc inbox shows the refs).` }
  if (hits.length > 1) return { error: `The ref "${oneLine(target, 80)}" names ${hits.length} items: use the number from ccc inbox.` }
  return { row: hits[0] }
}

/** "Tue 2026-11-03 14:00" in local time. */
function when(t) {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

module.exports = { HELP, CHOICES, MAX_ROWS, MAX_TITLE, oneLine, age, refOf, formatList, formatWhy, parse, resolve, when }
