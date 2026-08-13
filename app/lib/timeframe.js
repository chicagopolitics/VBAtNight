// Timeframe boundaries for the analytics page.
//
// page_views.created_at is UTC ('datetime(now)'), but "today" means the
// organizer's today, not Greenwich's. Volleyball is an evening sport: in
// LEAGUE_TZ a 9pm session lands on the FOLLOWING UTC day, so a UTC-based
// "views today" would credit the whole night to tomorrow. Same reasoning as
// parseDay in lib/game-name.js — off by one day is not cosmetic.
//
// Everything here returns strings shaped like created_at ('YYYY-MM-DD
// HH:MM:SS', UTC), so callers compare with a plain `>=` and SQLite never has
// to know about timezones.

import { LEAGUE_TZ } from "./luma.js";

/** The timeframes the page offers, in tab order. `all` has no lower bound. */
export const RANGES = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "all", label: "All time" },
];

/** Unknown/missing ?range= falls back to all-time — what /analytics showed
 *  before this existed, so a bare link keeps meaning what it meant. */
export const resolveRange = v =>
  RANGES.find(r => r.key === v) || RANGES[RANGES.length - 1];

// Wall-clock parts of an instant, as read in `tz`.
function partsIn(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d).map(x => [x.type, x.value]));
  // some ICU builds render midnight as hour 24 under hour12:false
  return { y: +p.year, mo: +p.month, d: +p.day,
           h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// The instant (UTC ms) at which `tz` reads the given wall-clock time.
// Date.UTC treats the parts as if they were UTC; re-reading that guess in tz
// shows how far off it is. Two passes, because the correction depends on the
// offset in force at the corrected instant — one pass is wrong across a DST
// change, two lands on it.
function utcMs({ y, mo, d, h = 0, mi = 0, s = 0 }, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(t), tz);
    t += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  }
  return t;
}

const asCreatedAt = ms => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * Lower bound of `key` as a created_at-shaped UTC string, or null for all
 * time. Weeks start Sunday (US convention, and the league plays midweek — a
 * Monday start would split a normal week across two buckets).
 */
export function rangeStart(key, now = new Date(), tz = LEAGUE_TZ) {
  const p = partsIn(now, tz);
  if (key === "today") return asCreatedAt(utcMs({ y: p.y, mo: p.mo, d: p.d }, tz));
  if (key === "week") {
    const dow = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();  // 0 = Sun
    // Date.UTC normalizes a non-positive day back into the previous month
    return asCreatedAt(utcMs({ y: p.y, mo: p.mo, d: p.d - dow }, tz));
  }
  if (key === "month") return asCreatedAt(utcMs({ y: p.y, mo: p.mo, d: 1 }, tz));
  return null;
}

/**
 * A SQLite date-modifier that shifts a UTC created_at into league-local time,
 * e.g. '-240 minutes' — for grouping rows into local days and hours.
 *
 * It's the offset in force NOW, applied to every row in the range. Within a
 * day or a week that's exact; a month spanning a DST change mislabels an hour
 * of traffic at the boundary. SQLite has no timezone database, and the
 * alternative (bucketing every row in JS) costs a full table scan to fix a
 * label nobody reads that closely.
 */
export const localShift = (now = new Date(), tz = LEAGUE_TZ) => {
  const p = partsIn(now, tz);
  const mins = Math.round(
    (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - now.getTime()) / 60000);
  return `${mins} minutes`;
};
