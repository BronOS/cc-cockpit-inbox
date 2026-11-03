'use strict'
// The settings view's decisions, free of the DOM so node:test can check them (test/settings-view.test.js).
// The host validates every save with readSettings; these functions only make the form honest: a
// field the person did not touch is not stored, a bad number keeps the stored value, and no key
// is invented that readSettings would drop.

const SELECTS = {
  position: [['top', 'Top'], ['bottom', 'Bottom'], ['inline', 'In the list'], ['beside', 'Beside the list when wide'], ['off', 'Off']],
  timeline: [['auto', "From the day's events"], ['work', '08–19']],
  badge: [['urgent', 'Urgent items'], ['action', 'Urgent and action'], ['all', 'All items'], ['off', 'Off']],
  afternoon: ['12:00', '13:00', '14:00', '15:00', '16:00'].map((t) => [t, t]),
  morning: ['07:00', '08:00', '09:00', '10:00'].map((t) => [t, t]),
}

/** Source rows: the live providers, then every stored plugin id with no provider now (greyed, kept). */
function sourceRows(settings, providers) {
  const rows = []
  const seen = new Set()
  for (const p of providers || []) {
    seen.add(p.pluginId)
    rows.push({ pluginId: p.pluginId, label: p.label || p.pluginId, color: p.color, live: true, on: p.on, items: p.items, weight: p.weightSet ? String(p.weight) : '', weightDefault: p.weight, weightSet: !!p.weightSet })
  }
  for (const id of Object.keys((settings && settings.sources) || {})) {
    if (seen.has(id)) continue
    const r = settings.sources[id]
    rows.push({ pluginId: id, label: id, color: 'grey', live: false, note: 'not installed or off', on: r.on !== false, items: r.items, weight: r.weight === undefined ? '' : String(r.weight), weightSet: r.weight !== undefined })
  }
  return rows
}

/** A whole integer from a form string, else undefined (no "12abc", no "1e3", no empty). */
function parseInt10(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : undefined
  return typeof v === 'string' && /^\s*-?\d{1,9}\s*$/.test(v) ? Number(v) : undefined
}

/**
 * The settings to save. `form` holds raw field values: { sources: {id: {on, items, weight}}, levels:
 * {urgent, action, fyi}, unread, direct, due, agePerHour (strings), dedupeJira, doneMarksRead,
 * doneReturns, notifySnooze (booleans), afternoon, morning, badge (strings), calendar: {position,
 * upcoming, pinMinutes, timeline} }. Starts from the stored settings, so untouched and unknown
 * fields (ageCap) and rows of providers that left stay as they were.
 */
function formToSettings(settings, providers, form) {
  const out = JSON.parse(JSON.stringify(settings || {}))
  out.sources = out.sources || {}
  out.levels = out.levels || {}
  out.calendar = out.calendar || {}
  const num = (v, old) => { const n = parseInt10(v); return n === undefined ? old : n }
  for (const p of providers || []) {
    const f = (form.sources || {})[p.pluginId]
    if (!f) continue
    const row = { ...(out.sources[p.pluginId] || {}) }
    row.on = typeof f.on === 'boolean' ? f.on : p.on
    const items = parseInt10(f.items)
    if (items === undefined) { if (String(f.items ?? '').trim() === '') delete row.items } // bad text keeps the stored value
    else if (items === p.items && row.items === undefined) delete row.items // untouched: the kind's default
    else row.items = items
    const weight = parseInt10(f.weight)
    if (weight === undefined) { if (String(f.weight ?? '').trim() === '') delete row.weight }
    else if (weight === p.weight && !p.weightSet) delete row.weight
    else row.weight = weight
    out.sources[p.pluginId] = row
  }
  for (const k of ['urgent', 'action', 'fyi']) out.levels[k] = num((form.levels || {})[k], out.levels[k])
  for (const k of ['unread', 'direct', 'due', 'agePerHour']) out[k] = num(form[k], out[k])
  for (const k of ['dedupeJira', 'doneMarksRead', 'doneReturns', 'notifySnooze']) if (typeof form[k] === 'boolean') out[k] = form[k]
  for (const k of ['afternoon', 'morning', 'badge']) if (typeof form[k] === 'string') out[k] = form[k]
  const c = form.calendar || {}
  if (typeof c.position === 'string') out.calendar.position = c.position
  if (typeof c.timeline === 'string') out.calendar.timeline = c.timeline
  out.calendar.upcoming = num(c.upcoming, out.calendar.upcoming)
  out.calendar.pinMinutes = num(c.pinMinutes, out.calendar.pinMinutes)
  return out
}

if (typeof module !== 'undefined' && module.exports) module.exports = { SELECTS, sourceRows, parseInt10, formToSettings }
