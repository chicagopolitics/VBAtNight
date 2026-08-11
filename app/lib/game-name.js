// The one door a game goes through to become a name.
//
// Mirrors lib/video-source.js: a rally has exactly one place it becomes
// playable, and a game has exactly one place it becomes readable. The point
// is that the site label and the YouTube title are two RENDERINGS of the same
// facts (played_on, slot) rather than two copies of a string — copies drift,
// renderings can't. See NAMING-PLAN.md.
//
// Facts live in columns; nothing here writes. Callers pass a games row.

const CHANNEL = "VB at Night";

// Manual override wins unconditionally, and is the escape hatch that lets the
// derived scheme stay simple — see the `label` note in lib/db.js.
const override = g => (g?.label || "").trim() || null;

// 'YYYY-MM-DD' -> parts, without going through Date(): `new Date("2026-07-21")`
// parses as UTC midnight and then renders in local time, so anywhere west of
// Greenwich a game silently displays as the day before. Volleyball is an
// evening sport; being off by one day is not a cosmetic bug.
function parseDay(played_on) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(played_on || "").trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d, iso: `${m[1]}-${m[2]}-${m[3]}` };
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Day-of-week from the date parts only (Zeller-ish via UTC, no local shift).
const dow = p => DOW[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];

const gameNo = g => (Number.isInteger(g?.slot) && g.slot > 0)
  ? `Game ${g.slot}` : null;

// Last resort. Never returns empty: a row with no facts at all still has an
// id, and "Game #14" beats "undefined" in a list the organizer has to scan.
const legacy = g => (g?.name || "").trim() || (g?.id ? `Game #${g.id}` : "Untitled");

/**
 * Label for a SESSION — one evening of volleyball, which is several games
 * (see resequenceNight in lib/import.js; /stats scopes its boards to one).
 * Date only, no game number, no `label` override: an override names one game,
 * and a night can hold several of them.
 *   -> "Tue, Jul 21 2026"
 * Null for anything that isn't a real 'YYYY-MM-DD', so callers can tell a
 * missing date from a formatted one rather than rendering "Invalid Date".
 */
export function dayLabel(played_on) {
  const p = parseDay(played_on);
  return p ? `${dow(p)}, ${MON[p.mo - 1]} ${p.d} ${p.y}` : null;
}

/**
 * Label for inside the app — games list, /watch, page titles.
 * Context is free here (the user is already on vbatnight), so no channel
 * prefix, and a human date format because a person is scanning a list.
 *   -> "Tue, Jul 21 2026 · Game 2"
 */
export function displayName(g) {
  if (override(g)) return override(g);
  const date = dayLabel(g?.played_on);
  if (!date) return legacy(g);
  const n = gameNo(g);
  return n ? `${date} · ${n}` : date;
}

/**
 * Title for YouTube.
 * Different from displayName on purpose: the video lands in a global
 * namespace (search, subscription feeds, a bare shared link) with no
 * surrounding page, so it needs the channel prefix to identify itself. ISO
 * dates because they sort correctly in the Studio title column.
 *   -> "VB at Night — 2026-07-21 · Game 2"
 * Clamped to YouTube's 100-char hard limit, which only a long `label` can hit.
 */
export function youtubeTitle(g) {
  const p = parseDay(g?.played_on);
  const n = gameNo(g);
  const core = override(g)
    ? [p ? p.iso : null, override(g)].filter(Boolean).join(" · ")
    : p ? [p.iso, n].filter(Boolean).join(" · ")
        : legacy(g);
  return `${CHANNEL} — ${core}`.slice(0, 100);
}

/**
 * Machine key: stable, sortable, filename-safe, URL-safe. Use where a handle
 * is wanted rather than a label (Shorts filenames, exports, share paths).
 *   -> "vban-2026-07-21-g2"
 * Falls back to the row id, which is the only genuinely stable thing we have.
 */
export function slug(g) {
  const p = parseDay(g?.played_on);
  if (!p) return `vban-game-${g?.id ?? "unknown"}`;
  const n = Number.isInteger(g?.slot) && g.slot > 0 ? `-g${g.slot}` : "";
  return `vban-${p.iso}${n}`;
}

/**
 * Does this game still need a human to tell us when it was played?
 * Drives the date prompt on import — a missing date is recoverable, a wrong
 * one silently reorders the night, so we ask rather than guess.
 */
export const needsDate = g => !parseDay(g?.played_on);

/**
 * Local calendar date for an ISO instant. The night is what matters, not the
 * instant, and a 9pm game on the 21st must not become the 22nd because the
 * camera wrote UTC. Uses the server's zone, which is the league's zone.
 */
export function playedOnFrom(recorded_at) {
  if (!recorded_at) return null;
  const t = new Date(recorded_at);
  if (isNaN(t)) return null;
  const p = n => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}
