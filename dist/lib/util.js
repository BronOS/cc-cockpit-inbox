'use strict'
// Small helpers every file of the host used to carry its own copy of. A leaf: requires nothing, so
// state, rules, feed, sources, settings and the host import the same definitions.

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** An error (or anything thrown) as one short line for a log or a notice: cut to 300 characters. */
const why = (e) => String((e && e.message) || e || 'failed').slice(0, 300)

/** `p`, or a rejection after `ms` (a provider that never answers must not hold an action). */
function withTimeout(p, ms, what) {
  let t
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms)
    }),
  ])
}

/** The item key: one rule for the sort, the traces, the host and state.js. */
const keyOf = (pluginId, id) => `${pluginId}\u0000${id}`

// The memory of Done / snoozed items and of Jev answers: an entry not seen for 14 days is dropped,
// and "seen" is written at most once a day.
const KEEP_MS = 14 * 24 * 3600000
const SEEN_EVERY_MS = 24 * 3600000

// The snooze choices, in the order the CLI lists them, and v1's default times (v1 had a setting for
// them; v2's settings hold groups, rules and the agenda only).
const SNOOZE_CHOICES = Object.freeze(['1h', 'afternoon', 'tomorrow', 'changes'])
const DEFAULT_TIMES = Object.freeze({ afternoon: '14:00', morning: '09:00' })

module.exports = { isObj, why, withTimeout, keyOf, KEEP_MS, SEEN_EVERY_MS, SNOOZE_CHOICES, DEFAULT_TIMES }
