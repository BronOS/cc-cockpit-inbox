'use strict'
// The calendar block of the Inbox panel: the day strip (the old cockpit's now bar, as
// bronos.calendar's timeline.js draws it: half-hour cells busy / not answered / free, an hour scale
// and the now marker), the next-event card and the upcoming list. Free of the DOM so node:test can
// check it; the page loads it as a classic script after rowlogic.js. The page and the host run on
// the same machine, so local time here is the person's time; events come as ms (CalEvent).

const TL_STEP = 30
const TL_LO = 8 * 60
const TL_HI = 19 * 60
const TL_DAY = 24 * 60

const tlClock = typeof module !== 'undefined' && module.exports ? require('./rowlogic').clockText : (ms) => clockText(ms)

/** Local midnight of the day of `t`. */
function dayStart(t) {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Wall minutes since local midnight of `day0` (DST days: from the clock, not from elapsed time). */
function wallMinute(ms, day0) {
  if (ms < day0) return 0
  const d = new Date(ms)
  if (dayStart(ms) > day0) return TL_DAY
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

/** Today's timed events with `from` / `to` in wall minutes. */
function timedOf(events, now) {
  const d0 = dayStart(now)
  return (events || []).filter((e) => !e.allDay).map((e) => ({ ...e, from: wallMinute(e.start, d0), to: wallMinute(e.end, d0) }))
}

/** The strip's span: 08–19 ('work'), or ('auto') widened to the hour around any event outside it. */
function dayRange(timed, mode) {
  if (mode === 'work') return { lo: TL_LO, hi: TL_HI }
  const lo = Math.floor(Math.min(TL_LO, ...timed.map((r) => r.from)) / 60) * 60
  const hi = Math.min(TL_DAY, Math.ceil(Math.max(TL_HI, ...timed.map((r) => r.to)) / 60) * 60)
  return { lo: Math.max(0, lo), hi }
}

/** Cells of `step` minutes: 'busy', 'unanswered' (every event there waits for an answer) or 'free'. */
function stripCells(timed, lo, hi, step = TL_STEP) {
  const busy = timed.filter((r) => r.response !== 'declined' && r.to > r.from)
  return Array.from({ length: Math.max(0, Math.ceil((hi - lo) / step)) }, (_, i) => {
    const a = lo + i * step
    const hit = busy.filter((r) => r.from < a + step && r.to > a)
    if (!hit.length) return 'free'
    return hit.every((r) => r.response === 'needsAction') ? 'unanswered' : 'busy'
  })
}

function hourText(min) {
  const m = Math.round(min)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** The scale: both ends and every 4 hours at least 2 hours from both. */
function stripScale(lo, hi) {
  if (!(hi > lo)) return []
  const at = (min) => ({ pct: ((min - lo) / (hi - lo)) * 100, text: hourText(min) })
  const out = [at(lo)]
  for (let m = Math.ceil(lo / 240) * 240; m < hi; m += 240) if (m - lo >= 120 && hi - m >= 120) out.push(at(m))
  out.push(at(hi))
  return out
}

/** The now marker in % of the strip, null outside it. */
function nowPct(now, lo, hi) {
  const m = wallMinute(now, dayStart(now))
  return m >= lo && m < hi ? ((m - lo) / (hi - lo)) * 100 : null
}

/** "in 18 min", "in 2 h 5 min", "now · 12 min left". */
function countdown(e, now) {
  const span = (ms) => {
    const m = Math.max(1, Math.round(ms / 60000))
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
  }
  if (e.start <= now && now < e.end) return `now · ${span(e.end - now)} left`
  return `in ${span(e.start - now)}`
}

/** The next timed event not over and not declined, from today's and the upcoming ones. */
function nextEvent(day, upcoming, now) {
  const seen = new Set()
  const all = [...((day && day.events) || []), ...(upcoming || [])].filter((e) => !seen.has(e.id) && seen.add(e.id))
  return all.filter((e) => !e.allDay && e.response !== 'declined' && e.end > now).sort((a, b) => a.start - b.start)[0] || null
}

/** `Tue 10:00` for another day, `15:00` today. */
function whenText(ms, now) {
  return dayStart(ms) === dayStart(now) ? tlClock(ms) : `${new Date(ms).toLocaleDateString('en-GB', { weekday: 'short' })} ${tlClock(ms)}`
}

/**
 * The whole block: header texts, the strip, the next card and up to `count` upcoming events after
 * it (an unanswered one with Accept).
 */
function calendarModel(cal, now) {
  const day = cal && cal.day
  const timed = timedOf(day && day.events, now)
  const { lo, hi } = dayRange(timed, cal && cal.timeline)
  const next = nextEvent(day, cal && cal.upcoming, now)
  const count = Math.max(0, (cal && cal.upcomingCount) ?? 3)
  const upcoming = ((cal && cal.upcoming) || [])
    .filter((e) => e.start > now && e.response !== 'declined' && (!next || e.id !== next.id))
    .slice(0, count)
    .map((e) => ({ id: e.id, when: e.allDay ? 'all day' : whenText(e.start, now), title: e.title, unanswered: e.response === 'needsAction' }))
  const t = day && day.tomorrow
  const tomorrow = !t || !t.count ? 'tomorrow nothing' : t.first ? `tomorrow first ${t.first.allDay ? 'all day' : tlClock(t.first.start)}` : `tomorrow ${t.count}`
  const n = ((day && day.events) || []).length
  const cells = stripCells(timed, lo, hi)
  return {
    title: `Today · ${new Date(now).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`,
    more: `${n} event${n === 1 ? '' : 's'} · ${tomorrow}`,
    cells,
    cellTitles: cells.map((_, i) => `${hourText(lo + i * TL_STEP)}–${hourText(Math.min(hi, lo + (i + 1) * TL_STEP))}`),
    scale: stripScale(lo, hi),
    now: nowPct(now, lo, hi),
    next: next ? { id: next.id, when: countdown(next, now), what: `${whenText(next.start, now)} ${next.title}`, join: Boolean(next.meetUrl) } : null,
    upcoming,
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TL_STEP, dayStart, wallMinute, timedOf, dayRange, stripCells, hourText, stripScale, nowPct, countdown, nextEvent, whenText, calendarModel }
}
