// Resolving a Luma registration to a players row.
//
// The roster lives in Luma and arrives here as a PASTE, not an API call:
// lib/luma.js reads the public iCal feed on purpose (the REST API needs Luma
// Plus), and that feed carries no ATTENDEE lines at all. So the input is
// whatever the export button produced, and the two names involved were typed
// by two different people for two different reasons — "Michael Smith" at
// registration, "Mike" during review. Matching them is a suggestion engine,
// never an authority: everything below PROPOSES, and the organizer confirms.
// Same posture as the duplicate suggestions on /players.
//
// No DB and no imports, so this runs unchanged on the server (page.js) and in
// the browser (ui.js) — which is why the matching needs no API round-trip.

// --- name shapes -----------------------------------------------------------

// normalized name for duplicate detection: lowercase, trimmed, trailing count
// suffix stripped ("Julio 2" -> "julio") so hand-disambiguated dupes surface.
export const norm = s =>
  String(s ?? "").toLowerCase().trim().replace(/\s+\d+$/, "").replace(/\s+/g, " ");

export function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 1) return 2;          // we only care about <= 1
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const t = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return dp[m];
}

// First token of a normalized name. The bridge `lev` structurally cannot
// cross: it bails when lengths differ by more than one, so "Michael Smith" vs
// "Mike"'s row "Michael" never surfaces — and a full name registered against a
// first-name-only player row is the single most likely real shape here.
const firstTok = s => norm(s).split(" ")[0] || "";

// --- parsing ---------------------------------------------------------------

const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One delimited line -> fields, honouring double quotes (an export can quote a
// field that contains the delimiter, and "Smith, Jr." would otherwise split).
function splitLine(line, delim) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const headerIndex = (heads, re) => heads.findIndex(h => re.test(h));

/**
 * Read a pasted Luma export into { name, email } rows.
 *
 * Tolerant by design — the exact column set is Luma's to change, and the cost
 * of guessing wrong is a preview the organizer can see is wrong, so this
 * prefers a best effort over a strict schema. It never throws: a bad paste
 * yields an empty result, not a crashed page.
 */
export function parseRoster(text) {
  const empty = { rows: [], skipped: 0, columns: null };
  try {
    const lines = String(text ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return empty;

    // tabs beat commas: a TSV paste out of a spreadsheet is the common case
    // where a name legitimately contains a comma
    const delim = (lines[0].match(/\t/g) || []).length >
                  (lines[0].match(/,/g) || []).length ? "\t" : ",";

    const heads = splitLine(lines[0], delim).map(h => h.toLowerCase());
    let emailCol = headerIndex(heads, /e-?mail/);
    // exclude first/last so a split-name export doesn't win the whole-name slot
    let nameCol = heads.findIndex(h => /name/.test(h) && !/first|last|user|file/.test(h));
    const firstCol = headerIndex(heads, /first/);
    const lastCol = headerIndex(heads, /last/);

    // No recognisable header? Treat row 0 as data and find the column that
    // actually holds email addresses.
    let body = lines.slice(1);
    if (emailCol < 0) {
      const probe = splitLine(lines[0], delim);
      emailCol = probe.findIndex(v => EMAILISH.test(v));
      if (emailCol < 0) return empty;             // nothing email-shaped anywhere
      body = lines;                                // row 0 was data after all
      if (nameCol < 0) nameCol = probe.findIndex((v, i) => i !== emailCol && v);
    }

    const seen = new Set();
    const rows = [];
    let skipped = 0;
    for (const line of body) {
      const f = splitLine(line, delim);
      const email = (f[emailCol] || "").toLowerCase();
      if (!EMAILISH.test(email)) { skipped++; continue; }
      if (seen.has(email)) { skipped++; continue; }   // Luma repeats on re-register
      seen.add(email);
      const name = nameCol >= 0 && f[nameCol]
        ? f[nameCol]
        : [f[firstCol], f[lastCol]].filter(Boolean).join(" ").trim();
      rows.push({ name: name || "", email });
    }
    return { rows, skipped, columns: { name: nameCol, email: emailCol } };
  } catch {
    return empty;                                  // a paste must never 500 a page
  }
}

// --- matching --------------------------------------------------------------

/** How sure we are, worst to best. The UI bulk-confirms only `exact`. */
export const REASONS = {
  linked: "already linked",
  exact: "same name",
  typo: "similar name",
  "first-name": "first name matches",
  claimed: "that player is taken",
  ambiguous: "more than one match",
  none: "no match",
};

/**
 * Propose a player for each roster row.
 *
 * @param rows     from parseRoster
 * @param players  [{ id, display_name }]
 * @param links    { [email]: player_id } for users already mapped
 * @returns rows as { name, email, player_id, reason, candidates: number[] }
 *
 * A tier only runs when the one above it found nothing, and any tier finding
 * more than one player is `ambiguous` rather than a coin flip.
 */
export function matchRoster(rows, players, links = {}) {
  const byEmail = Object.fromEntries(
    Object.entries(links).map(([e, id]) => [e.toLowerCase(), id]));
  // a player already spoken for by SOME email — used to flag a second claim
  const claimedBy = new Map();
  for (const [e, id] of Object.entries(byEmail)) if (id != null) claimedBy.set(id, e);

  return rows.map(r => {
    const mine = byEmail[r.email];
    if (mine != null)
      return { ...r, player_id: mine, reason: "linked", candidates: [mine] };

    const n = norm(r.name);
    let hits = [], reason = "none";
    if (n) {
      hits = players.filter(p => norm(p.display_name) === n);
      if (hits.length) reason = "exact";
      if (!hits.length) {
        hits = players.filter(p => lev(r.name.toLowerCase(),
          p.display_name.toLowerCase()) <= 1);
        if (hits.length) reason = "typo";
      }
      if (!hits.length) {
        const f = firstTok(r.name);
        hits = f ? players.filter(p => firstTok(p.display_name) === f) : [];
        if (hits.length) reason = "first-name";
      }
    }

    const candidates = hits.map(p => p.id);
    if (hits.length !== 1)
      return { ...r, player_id: null,
        reason: hits.length ? "ambiguous" : "none", candidates };

    // a confident match on a player another email already owns is still a
    // question for the organizer, not a link to write
    const taken = claimedBy.get(candidates[0]);
    if (taken && taken !== r.email)
      return { ...r, player_id: null, reason: "claimed", candidates };

    return { ...r, player_id: candidates[0], reason, candidates };
  });
}
