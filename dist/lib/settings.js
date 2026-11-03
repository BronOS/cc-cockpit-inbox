'use strict'
// Inbox's settings (design "Ranking", "Done and snooze", "Panel"; the mock-up's settings view).
// They live in ctx.appStorage under one key, not in a manifest settings schema: the source rows are
// per provider (keyed by plugin id, providers come and go), which a fixed schema cannot list, and
// one inbox means one set of rules in every window. Read through `readSettings` every time: a value
// of the wrong type or out of range is replaced by its default, unknown keys are dropped, so a bad
// write (an older or newer Inbox, a hand edit) never breaks the panel. A provider that left keeps
// its row, so uninstalling and reinstalling Chat brings its count and weight back.

const KEY = 'settings'
const MAX_SOURCES = 50
// A plugin id as the app allows it, without `_`, so `__proto__` and friends never become keys.
const PLUGIN_ID = /^[a-z0-9][a-z0-9.-]{0,127}$/i

/** Items per source by `kind` (decision 4: 10 / 10 / 8). */
const KIND_ITEMS = Object.freeze({ chat: 10, mail: 10, issues: 8, other: 10 })
/** Weights by `kind` (rank.js DEFAULT_RULES.kindWeights; repeated for the settings view). */
const KIND_WEIGHTS = Object.freeze({ chat: 30, mail: 15, issues: 0, other: 0 })

const POSITIONS = ['top', 'bottom', 'inline', 'beside', 'off']
const BADGES = ['urgent', 'action', 'all', 'off']
const TIMELINES = ['auto', 'work']
const AFTERNOONS = ['12:00', '13:00', '14:00', '15:00', '16:00']
const MORNINGS = ['07:00', '08:00', '09:00', '10:00']

const DEFAULTS = Object.freeze({
  sources: Object.freeze({}),
  levels: Object.freeze({ urgent: 300, action: 150, fyi: 50 }),
  unread: 10,
  direct: 20,
  due: 25,
  agePerHour: 5,
  ageCap: 40,
  dedupeJira: true,
  doneMarksRead: true,
  doneReturns: true,
  afternoon: '14:00',
  morning: '09:00',
  notifySnooze: true,
  badge: 'urgent',
  calendar: Object.freeze({ position: 'top', upcoming: 3, pinMinutes: 30, timeline: 'auto' }),
})

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined)
const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d)
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const oneOf = (v, list, d) => (list.includes(v) ? v : d)

/** One source row: `{ on, items?, weight? }`; items and weight absent mean "the kind's default". */
function sourceRow(raw) {
  const out = { on: bool(own(raw, 'on'), true) }
  const items = int(own(raw, 'items'), 1, 50, undefined)
  if (items !== undefined) out.items = items
  const weight = int(own(raw, 'weight'), -1000, 1000, undefined)
  if (weight !== undefined) out.weight = weight
  return out
}

/** The settings, whole and valid, from whatever was stored (undefined: all defaults). */
function readSettings(raw) {
  const sources = {}
  const rawSources = own(raw, 'sources')
  if (isObj(rawSources)) {
    for (const id of Object.keys(rawSources).slice(0, MAX_SOURCES)) {
      if (PLUGIN_ID.test(id)) sources[id] = sourceRow(rawSources[id])
    }
  }
  const lv = own(raw, 'levels')
  const cal = own(raw, 'calendar')
  const D = DEFAULTS
  return {
    sources,
    levels: {
      urgent: int(own(lv, 'urgent'), -1000, 1000, D.levels.urgent),
      action: int(own(lv, 'action'), -1000, 1000, D.levels.action),
      fyi: int(own(lv, 'fyi'), -1000, 1000, D.levels.fyi),
    },
    unread: int(own(raw, 'unread'), -500, 500, D.unread),
    direct: int(own(raw, 'direct'), -500, 500, D.direct),
    due: int(own(raw, 'due'), -500, 500, D.due),
    agePerHour: int(own(raw, 'agePerHour'), 0, 100, D.agePerHour),
    ageCap: int(own(raw, 'ageCap'), 0, 1000, D.ageCap),
    dedupeJira: bool(own(raw, 'dedupeJira'), D.dedupeJira),
    doneMarksRead: bool(own(raw, 'doneMarksRead'), D.doneMarksRead),
    doneReturns: bool(own(raw, 'doneReturns'), D.doneReturns),
    afternoon: oneOf(own(raw, 'afternoon'), AFTERNOONS, D.afternoon),
    morning: oneOf(own(raw, 'morning'), MORNINGS, D.morning),
    notifySnooze: bool(own(raw, 'notifySnooze'), D.notifySnooze),
    badge: oneOf(own(raw, 'badge'), BADGES, D.badge),
    calendar: {
      position: oneOf(own(cal, 'position'), POSITIONS, D.calendar.position),
      upcoming: int(own(cal, 'upcoming'), 0, 10, D.calendar.upcoming),
      pinMinutes: int(own(cal, 'pinMinutes'), 5, 240, D.calendar.pinMinutes),
      timeline: oneOf(own(cal, 'timeline'), TIMELINES, D.calendar.timeline),
    },
  }
}

async function loadSettings(store) {
  return readSettings(await store.get(KEY))
}

/** Validate and store; resolves what was stored. */
async function saveSettings(store, raw) {
  const s = readSettings(raw)
  await store.set(KEY, s)
  return s
}

/** The effective row of one source: on, items and weight with its kind's defaults filled in. */
function sourceOf(settings, pluginId, kind) {
  const row = Object.hasOwn(settings.sources, pluginId) ? settings.sources[pluginId] : { on: true }
  const k = Object.hasOwn(KIND_ITEMS, kind) ? kind : 'other'
  return {
    on: row.on,
    items: row.items ?? KIND_ITEMS[k],
    weight: row.weight ?? KIND_WEIGHTS[k],
    weightSet: row.weight !== undefined,
  }
}

/** rank.js's rules from the settings (only weights the person set; the rest come from the kind). */
function rulesOf(settings) {
  const weights = {}
  for (const [id, row] of Object.entries(settings.sources)) if (row.weight !== undefined) weights[id] = row.weight
  return {
    levels: { ...settings.levels },
    weights,
    unread: settings.unread,
    direct: settings.direct,
    due: settings.due,
    agePerHour: settings.agePerHour,
    ageCap: settings.ageCap,
    dedupeJira: settings.dedupeJira,
  }
}

module.exports = {
  KEY,
  DEFAULTS,
  KIND_ITEMS,
  KIND_WEIGHTS,
  POSITIONS,
  BADGES,
  TIMELINES,
  AFTERNOONS,
  MORNINGS,
  readSettings,
  loadSettings,
  saveSettings,
  sourceOf,
  rulesOf,
}
