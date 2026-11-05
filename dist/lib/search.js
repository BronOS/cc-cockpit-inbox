'use strict'
// Search over everything Inbox knows (design-v2 "Inbox's own memory" / the panel's `/`): a
// case-insensitive substring over title, preview, from, place and labels of every item, whatever
// group it is in (Rest included) and Done ones too, which are marked. Plain substring, no regex
// (the query is typed by the person but runs over up to 1000 items per source). Pure.

const { keyOf } = require('./rules')

const MAX_QUERY = 200
const norm = (s) => String(s).normalize('NFKC').toLowerCase()

/** The searchable strings of a live feed item. */
function fieldsOf(item) {
  const out = [item.title, item.preview]
  if (item.from) out.push(item.from.name, item.from.address)
  if (item.place) out.push(item.place.kind, item.place.name, item.place.status)
  if (Array.isArray(item.labels)) out.push(...item.labels)
  return out.filter((v) => typeof v === 'string' && v !== '')
}

/**
 * `items`: every live item (hidden or not). `done`: state.doneList() entries. Returns
 * `{ pluginId, id, title, item, done }` for each match, live items first in the order given, then
 * Done entries whose item is no longer live (only their stored title is searchable). An empty
 * query matches nothing.
 */
function search(query, items, done = []) {
  const q = norm(String(query || '').trim().slice(0, MAX_QUERY))
  if (!q) return []
  const doneKeys = new Set(done.map((d) => keyOf(d.pluginId, d.id)))
  const liveKeys = new Set()
  const out = []
  for (const item of items) {
    const key = keyOf(item.source, item.id)
    liveKeys.add(key)
    if (fieldsOf(item).some((f) => norm(f).includes(q))) out.push({ pluginId: item.source, id: item.id, title: item.title || '', item, done: doneKeys.has(key) })
  }
  for (const d of done) {
    if (liveKeys.has(keyOf(d.pluginId, d.id))) continue
    if (norm(d.title || '').includes(q)) out.push({ pluginId: d.pluginId, id: d.id, title: d.title || '', item: null, done: true })
  }
  return out
}

module.exports = { search, fieldsOf, MAX_QUERY }
