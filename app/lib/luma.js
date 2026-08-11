// The next session someone can actually sign up for.
//
// Registration lives in Luma. This reads it so the site can point at it —
// someone interested enough to browse the highlights is usually interested
// enough to play next week, and until now nothing here said so.
//
// WHY THE iCAL FEED, NOT THE API. Luma's documented REST API needs a Luma Plus
// subscription. The calendar's iCal feed — the one behind Luma's own "Add iCal
// Subscription" button — is public, unauthenticated, and works on the free
// plan. It also carries LESS than the event page does: that page's HTML embeds
// the whole attendee roster by name, while the feed has no ATTENDEE lines at
// all. Better on privacy, and it lists every upcoming session rather than one
// fixed event, so nobody has to paste a new URL here each week.
//
// WHAT IT IS NOT. api.lu.ma/ics/get is the endpoint that button uses, not a
// contractual API. So everything below fails CLOSED: a bad id, a dead network,
// a changed format — all of it resolves to null, and the caller renders
// nothing. A promotion badge must never be able to break or slow a page.
//
// No DB, no imports: a single module-level cache, in the style of `_db` in
// lib/db.js. One Node process on the droplet, so that's sufficient.

const TTL_MS = 10 * 60 * 1000;   // how long an answer stays fresh
const TIMEOUT_MS = 2500;         // a page must not wait longer than this
const feedUrl = id =>
  `https://api.lu.ma/ics/get?entity=calendar&id=${encodeURIComponent(id)}`;

// The venue's clock — not the server's, not the reader's. Same hazard
// lib/game-name.js documents at length for played_on: a Thursday 8pm session
// must not read as Wednesday because the process runs in UTC.
export const LEAGUE_TZ = process.env.LEAGUE_TZ || "America/Indiana/Indianapolis";

const calendarId = () => (process.env.LUMA_CALENDAR_ID || "").trim();

// Unset = the feature is off, the same way youtubeConfigured() and
// driveCanUpload() gate theirs. Nothing renders and nothing errors.
export const lumaConfigured = () => !!calendarId();

// --- iCalendar reading -----------------------------------------------------

// RFC 5545 folds long lines by beginning the continuation with a space or tab.
// This feed folds DESCRIPTION, which is exactly the field the signup URL is
// hiding in, so unfolding is required rather than defensive.
const unfold = text => text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");

// Text values escape , ; \ and newlines.
const unescapeText = s => s == null ? null
  : s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

// DTSTART:20260814T000000Z                       <- what this feed emits
// DTSTART;TZID=America/New_York:20260813T200000  <- handled defensively; with
// no zone offset to apply we fall back to the server's, which is only ever a
// display nudge of a few hours, never a missing session.
function icsDate(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec((raw || "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${z ? "Z" : ""}`);
  return isNaN(t) ? null : t;
}

function parseEvents(text) {
  const out = [];
  for (const block of unfold(text).split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    // a property may carry parameters before the colon (DTSTART;TZID=…:value)
    const get = name =>
      new RegExp(`^${name}(?:;[^:\\n]*)?:(.*)$`, "m").exec(body)?.[1]?.trim() ?? null;

    const start = icsDate(get("DTSTART"));
    if (!start) continue;
    // The signup link lives in DESCRIPTION ("Get up-to-date information at:").
    // Without one there is nothing to offer, so such an event is skipped
    // rather than rendered as a badge that goes nowhere.
    const url = /https:\/\/luma\.com\/[A-Za-z0-9]+/.exec(get("DESCRIPTION") || "")?.[0];
    if (!url) continue;
    // UID is "evt-XXXX@events.lu.ma"; the local part is the stable id. It ends
    // up inside a CSS attribute selector for the dismiss rule, so anything
    // outside a conservative alphabet is dropped.
    const uid = (get("UID") || url).replace(/@.*$/, "").replace(/[^A-Za-z0-9_-]/g, "");
    out.push({
      id: uid || null,
      name: unescapeText(get("SUMMARY")) || "Next session",
      location: unescapeText(get("LOCATION")),
      url,
      start,
      end: icsDate(get("DTEND")) || start,
    });
  }
  return out.filter(e => e.id);
}

// Earliest session that hasn't finished yet. Past events stay in the feed —
// three of the four were already over the day this was written — so filtering
// is required, not a nicety.
const pickNext = list => list
  .filter(e => e.end.getTime() > Date.now())
  .sort((a, z) => a.start - z.start)[0] ?? null;

// --- fetch + cache ---------------------------------------------------------

let cache = null;        // { at, value }
let inflight = null;

async function load() {
  const res = await fetch(feedUrl(calendarId()), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "text/calendar" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`feed responded ${res.status}`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("response was not iCalendar");
  return pickNext(parseEvents(text));
}

function refresh() {
  if (inflight) return inflight;
  inflight = load()
    .then(v => (cache = { at: Date.now(), value: v }).value)
    .catch(e => {
      console.warn("[luma] next session unavailable:", e.message);
      // Stamp the failure with a fresh timestamp so a Luma outage costs one
      // request per TTL rather than a 2.5s timeout on every page view. Any
      // previously good answer keeps being served in the meantime.
      cache = { at: Date.now(), value: cache?.value ?? null };
      return cache.value;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * The next session, or null when there isn't one / isn't configured / Luma is
 * unreachable. Callers treat all three the same: render nothing.
 *
 * Never blocks on a stale cache — a slightly old date is worth far more than a
 * slow page, so a stale answer goes back immediately and the refresh lands for
 * whoever comes next. Only the first request after a restart can wait, and
 * only up to TIMEOUT_MS.
 */
export async function nextSession() {
  if (!lumaConfigured()) return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  if (cache) { refresh(); return cache.value; }   // stale-while-revalidate
  return await refresh();
}

// --- display ---------------------------------------------------------------

const at = d => (d instanceof Date ? d : new Date(d));
const fmt = (d, opts) =>
  new Intl.DateTimeFormat("en-US", { timeZone: LEAGUE_TZ, ...opts }).format(at(d));

/** "Thu, Aug 13" — the badge itself. The date is the hook; a bare "sign up"
 *  gives a reader no reason to press it. */
export const shortDay = d =>
  fmt(d, { weekday: "short", month: "short", day: "numeric" });

/** "Thursday, August 13 at 8:00 PM" — title and aria-label, where there's
 *  room to be unambiguous. */
export const fullWhen = d =>
  `${fmt(d, { weekday: "long", month: "long", day: "numeric" })} at ` +
  `${fmt(d, { hour: "numeric", minute: "2-digit" })}`;
