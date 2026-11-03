'use strict'
// `ccc inbox ...`: argument parsing and the printed text. Pure: the host resolves a target to a row and
// runs the action. Provider text (titles) is untrusted, so every line printed here is one line, free of
// control characters, and cut.

const MAX_ROWS = 50
const MAX_TITLE = 120
const CHOICES = ['1h', 'afternoon', 'tomorrow', 'changes']
const CAL_REF = 'calendar'

const HELP = `ccc inbox: the ranked list of what needs you (bronos.inbox)

  ccc inbox [list]                       the list, one line per item: number, badge, level, title, age, ref
  ccc inbox open <n|ref>                 open the item in its own plugin (marks nothing done)
  ccc inbox done <n|ref>                 mark it done (and read at its source, as in the panel)
  ccc inbox snooze <n|ref> <choice>      choice: 1h, afternoon, tomorrow or changes (until the item changes)
  ccc inbox help                         this text

<n> is the number in the list as it stands now; <ref> is the stable reference printed at the end of each
line (<pluginId>:<id>). The calendar item can be opened, not marked done or snoozed.
`

/** One line, no control characters (C0, DEL, C1, line and paragraph separators), cut to \`max\`. */
function oneLine(s, max) {
  const t = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
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

function formatList(rows, now) {
  if (!rows.length) return 'Inbox zero.\n'
  const shown = rows.slice(0, MAX_ROWS)
  const out = [`Inbox: ${rows.length} item${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? ` (first ${shown.length} shown)` : ''}`]
  shown.forEach((r, i) => {
    out.push(`${i + 1}. [${oneLine(r.badge, 12)}] ${oneLine(r.level, 10) || '-'} ${oneLine(r.title, MAX_TITLE)} (${age(r.at, now)}) ${refOf(r)}`)
  })
  return `${out.join('\n')}\n`
}

/** @returns {{ cmd: string, target?: string, choice?: string } | { error: string }} */
function parse(argv) {
  const [cmd = 'list', ...rest] = argv
  const usage = (m) => ({ error: `${m}\nUsage: ccc inbox [list] | open <n|ref> | done <n|ref> | snooze <n|ref> ${CHOICES.join('|')} | help` })
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return { cmd: 'help' }
  if (cmd === 'list') return rest.length ? usage('list takes no arguments') : { cmd }
  if (cmd === 'open' || cmd === 'done') {
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
  const row = rows.find((r) => refOf(r) === target)
  if (!row) return { error: `No item with ref "${oneLine(target, 80)}" in the list (ccc inbox shows the refs).` }
  return { row }
}

/** "Tue 2026-11-03 14:00" in local time. */
function when(t) {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

module.exports = { HELP, CHOICES, MAX_ROWS, MAX_TITLE, oneLine, age, refOf, formatList, parse, resolve, when }
