// One night, for the group: the blurb the organizer pastes into the chat.
//
// The per-player recap (lib/recap.js) tells one person what THEY did. This
// tells everyone how the NIGHT went — scores, who led what, the rally worth
// clicking. Same source data, same aggregates, so the post and the boards it
// links to cannot disagree; that matters more here than anywhere else on the
// site, because a wrong number in a group chat gets corrected in public.
//
// Pure — takes the nightRows() tuple, no db handle. Split in two on purpose:
// nightSummary() decides WHAT the highlights are, summaryText() decides how
// they read. A night page or a group email could render the same object
// without re-deriving a thing.

import { attackEff } from "./player-stats";
import { scoreFrom, teamMap, winnerOf } from "./grades";
import { dayLabel } from "./game-name";
import { publicName } from "./public-name";
import { pointsOf } from "./recap";

// Rate leaders need a floor or the crown goes to whoever swung twice and got
// lucky. 8 is roughly a third of a two-game night's attempts — low enough that
// the line almost always appears, high enough that it means something.
const MIN_ATTACKS = 8;
// A run of two is a coincidence, not a highlight.
const MIN_RUN = 3;

// An identity nobody named yet reads as "P3". Fine in review, useless in a
// chat post — "Most efficient scorer: P3" is worse than leaving the line out.
const named = r => r.name && !/^P\d+$/.test(r.name);

/**
 * How each player is named in the post.
 *
 * First name only, per lib/public-name.js — this text gets pasted straight
 * into a group chat, which is precisely the case that rule exists for.
 *
 * But a roster with a Julio Jr AND a Julio Sr turns "…: Julio" into a line
 * two people can claim and neither can verify. So when a first name is
 * shared that night, it carries an initial: "Julio S.", "Julio J.". Enough to
 * tell them apart, still short of publishing anyone's surname.
 */
function labeller(names) {
  const first = n => publicName(n) || n;
  const seen = new Map();
  for (const n of new Set(names.filter(Boolean)))
    seen.set(first(n), (seen.get(first(n)) || 0) + 1);
  return n => {
    if (!n) return null;
    const f = first(n);
    if ((seen.get(f) || 0) <= 1) return f;
    const rest = String(n).trim().split(/\s+/).slice(1).join(" ");
    return rest ? `${f} ${rest[0].toUpperCase()}.` : f;
  };
}

/**
 * Who led on `value`, ties intact.
 *
 * Ties are kept rather than broken arbitrarily: this is a post about a dozen
 * people who were all there, and quietly dropping one of two equal leaders is
 * exactly the kind of thing someone notices about themselves.
 *
 * `rows` comes back too, so a caller wanting the counters behind the number
 * ("12 pts (9 kills, 3 aces)") doesn't have to find the player again.
 *
 * @returns { names: [first, ...], value, rows: [row, ...] } | null
 */
function leader(rows, value, { min = 1, qualifies = null, label = publicName } = {}) {
  let best = null, winners = [];
  for (const r of rows) {
    if (!named(r) || (qualifies && !qualifies(r))) continue;
    const v = value(r);
    if (v == null || v < min) continue;
    if (best == null || v > best) { best = v; winners = [r]; }
    else if (v === best) winners.push(r);
  }
  if (best == null) return null;
  return { value: best, rows: winners,
    names: winners.map(r => label(r.name) || r.name) };
}

// "Ken", "Ken & Sasha", "Ken, Sasha & Emily"
const joinNames = ns => ns.length <= 1 ? (ns[0] ?? "")
  : `${ns.slice(0, -1).join(", ")} & ${ns[ns.length - 1]}`;

// Volleyball convention: .421, no leading zero. Negative efficiency is real
// and worth rendering honestly (-.083), though it never wins a leader line.
const effStr = e => (e < 0 ? "-" : "") + Math.abs(e).toFixed(3).replace(/^0/, "");

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * Longest streak of points won on one player's serve, across the night.
 *
 * The rotation rule is what makes this computable: the serving team keeps the
 * same server while it keeps winning, and rotates a new one in on a loss. So a
 * run is consecutive rallies with an unchanged server whose team won.
 *
 * A rally with no recorded serve touch, or no attributable winner, BREAKS the
 * run rather than spanning it. Touch lists have holes; a phantom nine-in-a-row
 * stitched across a gap would be read out loud to the person it names.
 */
function longestRun(games, rallies, plays, idents, label) {
  const servers = new Map();          // rally_id -> cluster_id of its serve
  for (const p of plays) {            // plays are t-ordered, so first wins
    if (p.play_type === "serve" && !servers.has(p.rally_id) && p.cluster_id != null)
      servers.set(p.rally_id, p.cluster_id);
  }

  let best = null;
  for (const g of games) {
    const mine = idents.filter(i => i.game_id === g.id);
    const teamOf = teamMap(mine);
    if (!teamOf) continue;
    const nameOf = new Map(mine.map(i => [i.cluster_id, i.name]));

    let cur = null;                   // { cluster, points, firstRally }
    for (const r of rallies) {
      if (r.game_id !== g.id) continue;
      const cid = servers.get(r.id);
      const won = winnerOf(r, teamOf);
      const team = cid == null ? null : teamOf.get(cid);
      if (cid == null || !won || !team) { cur = null; continue; }
      if (!cur || cur.cluster !== cid) cur = { cluster: cid, points: 0, firstRally: r.id };
      if (won !== team) { cur = null; continue; }   // server's team lost: run over
      cur.points++;
      if (!best || cur.points > best.points)
        best = { points: cur.points, name: nameOf.get(cid), rallyId: cur.firstRally };
    }
  }
  if (!best || best.points < MIN_RUN || !best.name || /^P\d+$/.test(best.name)) return null;
  return { ...best, name: label(best.name) || best.name };
}

/** Per-game final score, and who was on the winning side. */
function gameLines(games, rallies, idents, nameOf) {
  return games.map((g, i) => {
    const mine = idents.filter(x => x.game_id === g.id);
    const teamOf = teamMap(mine);
    const score = scoreFrom(rallies.filter(r => r.game_id === g.id), teamOf);
    const label = `Game ${g.slot ?? i + 1}`;
    if (!score) return { id: g.id, label, score: null, winner: null, roster: [] };

    // The whole winning roster, not "Team A" — the letter means nothing to
    // someone reading this on their phone, and the sides shuffle between
    // games anyway. Unnamed auto-detected clusters are left off, the same
    // call the game card makes on /watch (roster() in app/watch/page.js).
    const winner = score.A === score.B ? null : score.A > score.B ? "A" : "B";
    const roster = winner
      ? mine.filter(x => x.team === winner && named(x)).map(x => nameOf(x.name))
      : [];
    return { id: g.id, label, score, winner, roster };
  });
}

/**
 * @param night   the tuple from nightRows(): { games, idents, rallies, plays, rows }
 * @param options { date: 'YYYY-MM-DD', origin: 'https://…' }
 */
export function nightSummary({ games, idents, rallies, plays, rows }, { date, origin }) {
  const when = dayLabel(date) || date;
  if (!games.length)
    return { date, when, games: [], highlights: {}, links: null, approx: false };

  const touchesPer = new Map();
  for (const p of plays) touchesPer.set(p.rally_id, (touchesPer.get(p.rally_id) || 0) + 1);

  let longest = null;
  for (const r of rallies) {
    const secs = Math.round(r.end_s - r.start_s);
    if (!longest || secs > longest.seconds)
      longest = { id: r.id, seconds: secs, touches: touchesPer.get(r.id) || 0 };
  }

  const label = labeller(idents.map(i => i.name));
  const gs = gameLines(games, rallies, idents, label);
  const scored = rows.filter(named);

  return {
    date, when,
    games: gs,
    approx: gs.some(g => g.score?.approx),
    highlights: {
      topScorer: leader(scored, pointsOf, { label }),
      // min: -Infinity because a negative efficiency is a real value, not a
      // missing one — the MIN_ATTACKS gate is what qualifies a hitter here
      mostEfficient: leader(scored, attackEff,
        { label, min: -Infinity, qualifies: r => r.attack >= MIN_ATTACKS }),
      run: longestRun(games, rallies, plays, idents, label),
      aces: leader(scored, r => r.ace, { label, min: 2 }),
      defense: leader(scored, r => r.digOk, { label, min: 1 }),
      longestRally: longest && longest.seconds > 0
        ? { ...longest, url: `${origin}/r/${longest.id}` } : null,
    },
    links: {
      clips: `${origin}/watch?day=${date}`,
      stats: `${origin}/stats?day=${date}`,
    },
  };
}

/** The post. Lines with nothing to say are dropped, never zero-filled. */
export function summaryText(s) {
  if (!s.games.length) return `No published games for ${s.when}.`;
  const h = s.highlights, out = [`🏐 VB at Night — ${s.when}`, ""];

  for (const g of s.games) {
    if (!g.score) { out.push(`${g.label}`); continue; }
    // Winner's total first. The line names the side that WON, so leading with
    // the A total would print "Jay's side 23–25" — a win that reads as a loss.
    const [hi, lo] = g.winner === "B" ? [g.score.B, g.score.A]
                                      : [g.score.A, g.score.B];
    const line = `${hi}–${lo}${g.score.approx ? "*" : ""}`;
    out.push(`${g.label}: ${g.roster.length
      ? `${joinNames(g.roster)} — ${line}` : line}`);
  }
  if (s.games.some(g => g.score)) out.push("");

  if (h.topScorer) {
    // the breakdown only makes sense for a single winner; on a tie the total
    // is the shared fact and the parenthetical would be one player's alone
    const d = h.topScorer.rows.length === 1 ? h.topScorer.rows[0] : null;
    const bits = d ? [d.kill && plural(d.kill, "kill"), d.ace && plural(d.ace, "ace"),
      d.stuff && plural(d.stuff, "block")].filter(Boolean) : [];
    out.push(`⭐ Top scorer: ${joinNames(h.topScorer.names)} — `
      + `${h.topScorer.value} pts${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }
  if (h.mostEfficient) {
    const d = h.mostEfficient.rows.length === 1 ? h.mostEfficient.rows[0] : null;
    out.push(`🎯 Most efficient scorer: ${joinNames(h.mostEfficient.names)} — `
      + `${effStr(h.mostEfficient.value)}${d ? ` on ${plural(d.attack, "swing")}` : ""}`);
  }
  if (h.run)
    out.push(`🔥 Serving run: ${h.run.name}, ${h.run.points} straight`);
  // Skip the aces line when the top-scorer line already spelled out the same
  // person's aces — a six-line post can't afford to say a thing twice.
  const acesToldAbove = h.aces && h.topScorer
    && h.aces.rows.length === 1 && h.topScorer.rows.length === 1
    && h.aces.rows[0].key === h.topScorer.rows[0].key;
  if (h.aces && !acesToldAbove)
    out.push(`🎈 Aces: ${joinNames(h.aces.names)} — ${h.aces.value}`);
  if (h.defense)
    out.push(`🛡️ Best defense: ${joinNames(h.defense.names)} — ${plural(h.defense.value, "dig")}`);
  if (h.longestRally) {
    out.push(`🏆 Longest rally: ${h.longestRally.seconds}s, `
      + `${plural(h.longestRally.touches, "touch", "touches")}`);
    out.push(`   ${h.longestRally.url}`);
  }

  out.push("", `All clips: ${s.links.clips}`, `Stats: ${s.links.stats}`);
  if (s.approx)
    out.push("", "* a few points couldn't be pinned to a team — score is close, not exact");
  return out.join("\n");
}
