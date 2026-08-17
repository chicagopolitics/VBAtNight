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
import { deriveGrades, scoreFrom, teamMap, winnerOf } from "./grades";
import { dayLabel } from "./game-name";
import { publicName } from "./public-name";
import { pointsOf } from "./recap";

// Rate leaders need a floor or the crown goes to whoever swung twice and got
// lucky — but a FIXED floor doesn't survive a change of night size. 8 is about
// a third of a two-game night's volume and a fifth of a six-game one: on
// 2026-08-14 it handed "most efficient" to a player who ranked 21st of 24 in
// attempts, off 10 swings against a top hitter's 38.
//
// So scale it to the night: a bit under a third of what the busiest hitter
// took. Checked against three real nights — 0.4 looked tidier but let one
// 50-swing outlier drag the bar to 20 and shut out a 6-kill, 0-error night on
// 15 swings, which is exactly the performance this line exists to find.
// 0.3 keeps that in, still excludes the 10-swing case, and on a two-game
// night falls back to the absolute floor, where this started.
const MIN_ATTACK_SHARE = 0.3;
const MIN_ATTACKS_FLOOR = 8;
// `of` picks the volume column, so a rate over any counter gets the same
// share-of-the-busiest rule rather than each one inventing its own number.
const volumeFloor = (rows, of, min) => Math.max(min,
  Math.ceil(MIN_ATTACK_SHARE * rows.reduce((m, r) => Math.max(m, of(r) || 0), 0)));
const attackFloor = rows => volumeFloor(rows, r => r.attack, MIN_ATTACKS_FLOOR);
// defensive touches (passes + digs), for the conversion award
const defenceFloor = rows => volumeFloor(rows, r => r.receive + r.dig, 8);
// enough serves that "no errors" means something
const MIN_SERVES = 8;
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

/**
 * Walks every rally that ended in a kill and reads the two touches that built
 * it. Returns:
 *   conns   Map(setter row key -> Map(hitter -> kills))  — who fed whom
 *   sparks  Map(row key -> count)  — whose pass or dig STARTED a scoring
 *           possession, i.e. the touch immediately before the assist
 *
 * Both halves come from where the boards get them, so this can't disagree
 * with either: the ASSIST from deriveGrades (the set immediately preceding
 * the kill — the Setters board's definition), and the KILL from the rally
 * outcome (the Scorers board's). Taking "the last set in the rally" instead
 * would be close, and wrong in exactly the scrappy rallies people remember.
 *
 * `sparks` exists because the obvious passing stat doesn't work on this data:
 * a shanked reception is scored as an ace for the SERVER and the receiver is
 * never mentioned, so reception errors are ~0 and "reception efficiency"
 * decays into "who got served the most". Counting the defensive touches that
 * became points measures against something the scoring actually records.
 */
function killChains(rallies, plays, idents, nameOf) {
  const byRally = new Map();
  for (const p of plays) {
    if (!byRally.has(p.rally_id)) byRally.set(p.rally_id, []);
    byRally.get(p.rally_id).push(p);
  }
  const teamsByGame = new Map();
  for (const i of idents) {
    if (!teamsByGame.has(i.game_id)) teamsByGame.set(i.game_id, []);
    teamsByGame.get(i.game_id).push(i);
  }
  for (const [gid, list] of teamsByGame) teamsByGame.set(gid, teamMap(list));
  // same key rule as lib/player-stats.js, so a setter's row and their
  // connections are looked up by the same string
  const info = new Map(idents.map(i => [`${i.game_id}:${i.cluster_id}`,
    { key: i.player_id != null ? `pid:${i.player_id}` : `name:${i.name}`, name: i.name }]));

  const conns = new Map(), sparks = new Map();
  for (const r of rallies) {
    if (r.outcome_type !== "kill" || r.outcome_cluster == null) continue;
    const touches = byRally.get(r.id);
    if (!touches) continue;
    const grades = deriveGrades(touches, r, teamsByGame.get(r.game_id));
    // touches arrive t-ordered (nightRows selects ORDER BY p.t), so the
    // position before the assist really is the touch before it
    const at = touches.findIndex(t => grades.get(t.id) === "assist");
    if (at < 0) continue;
    const set = touches[at];

    if (set.cluster_id != null) {
      const s = info.get(`${r.game_id}:${set.cluster_id}`);
      const h = info.get(`${r.game_id}:${r.outcome_cluster}`);
      if (s && h && named(h)) {
        if (!conns.has(s.key)) conns.set(s.key, new Map());
        const m = conns.get(s.key), who = nameOf(h.name) || h.name;
        m.set(who, (m.get(who) || 0) + 1);
      }
    }

    // the pass or dig this possession was built on. Kept independent of the
    // connection credit above: an unnamed setter shouldn't cost the defender
    // the touch that started the point.
    const first = at > 0 ? touches[at - 1] : null;
    if (first && first.cluster_id != null
        && (first.play_type === "receive" || first.play_type === "dig")) {
      const f = info.get(`${r.game_id}:${first.cluster_id}`);
      if (f && named(f)) sparks.set(f.key, (sparks.get(f.key) || 0) + 1);
    }
  }
  return { conns, sparks };
}

/** The hitter this setter fed most, when one clearly stands out. */
function favourite(conns, key) {
  const m = conns.get(key);
  if (!m) return null;
  let best = null;
  for (const [who, kills] of m)
    if (!best || kills > best.kills) best = { who, kills };
  // one kill is a rally, not a connection
  return best && best.kills >= 2 ? best : null;
}

// The shout-outs.
//
// The headline stats keep naming the same two or three people — a good night
// wins several of them at once. Adding more categories doesn't fix that on its
// own (the best hitter is usually also the most reliable one), so each award
// here goes to the best player NOBODY HAS NAMED YET, and the block is framed
// as shout-outs rather than superlatives. "Old Reliable" claims nothing;
// "1 error in 23 swings" is checkable. That split is what lets the nickname be
// loose without the line being untrue.
//
// Order is priority: the first award gets first pick of the unnamed pool.
// Triple Threat goes last because a composite collides most often.
// The icon is kept beside the label rather than baked into it, so a future
// HTML rendering can use one without the other. None of these repeat an emoji
// the headline lines already use.
const SHOUTOUTS = [
  { icon: "🪨", label: "Old Reliable",     // rock solid
    // a MINIMUM, and leader() maximises — so rank on the negated rate
    qualifies: (r, c) => r.attack >= c.attackFloor,
    value: r => -(r.atkErr / r.attack),
    detail: r => `${r.atkErr ? plural(r.atkErr, "error") : "no errors"} `
      + `in ${plural(r.attack, "swing")}` },
  { icon: "⚡", label: "The Spark",
    qualifies: (r, c) => (r.receive + r.dig) >= c.defenceFloor && c.sparks.get(r.key) > 0,
    value: (r, c) => c.sparks.get(r.key) / (r.receive + r.dig),
    detail: (r, c) => `${c.sparks.get(r.key)} of ${r.receive + r.dig} `
      + `digs & passes turned into kills` },
  { icon: "🧱", label: "The Wall",
    qualifies: r => r.stuff >= 2,
    value: r => r.stuff,
    detail: r => plural(r.stuff, "stuff block") },
  { icon: "📮", label: "The Postman",      // always delivers
    qualifies: r => r.srvErr === 0 && r.serve >= MIN_SERVES,
    value: r => r.serve,
    detail: r => `${plural(r.serve, "serve")}, no errors`
      + (r.ace ? `, ${plural(r.ace, "ace")}` : "") },
  { icon: "🃏", label: "Triple Threat",    // wildcard — scores every which way
    qualifies: r => r.kill >= 1 && r.ace >= 1 && r.stuff >= 1,
    value: r => r.kill + r.ace + r.stuff,
    detail: r => `${plural(r.kill, "kill")}, ${plural(r.ace, "ace")}, `
      + `${plural(r.stuff, "block")}` },
];

/**
 * Award each shout-out to the best qualifying player not yet named.
 *
 * `used` holds DISPLAY names, not row keys: the serving-run name and the
 * setter's connection target are already labels, and it's the printed name
 * that must not appear twice. An award with nobody left to give it to is
 * skipped rather than handed to someone with two touches.
 */
function shoutouts(rows, ctx, label) {
  const used = new Set(ctx.used);
  const out = [];
  for (const a of SHOUTOUTS) {
    const win = leader(rows, r => a.value(r, ctx), { label, min: -Infinity,
      qualifies: r => a.qualifies(r, ctx) && !used.has(label(r.name) || r.name) });
    if (!win) continue;
    out.push({ icon: a.icon, label: a.label, names: win.names,
      detail: a.detail(win.rows[0], ctx) });
    for (const n of win.names) used.add(n);
  }
  return out;
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
    const side = winner ? mine.filter(x => x.team === winner) : [];
    const roster = side.filter(named).map(x => nameOf(x.name));
    // Someone on the winning side was never named in review. Printing "P3"
    // would be worse, but silently listing five of six quietly drops a player
    // from their own team's win — so say that one is missing.
    return { id: g.id, label, score, winner, roster,
      unnamed: side.length - roster.length };
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

  const { conns, sparks } = killChains(rallies, plays, idents, label);

  // Setting is concentrated — one or two people take most of the sets — so
  // the assist count alone would name the same person every week. The hitter
  // they fed most is what makes the line about THIS night.
  const setter = leader(scored, r => r.assist, { label, min: 1 });
  if (setter && setter.rows.length === 1)
    setter.top = favourite(conns, setter.rows[0].key);

  const highlights = {
    topScorer: leader(scored, pointsOf, { label }),
    // min: -Infinity because a negative efficiency is a real value, not a
    // missing one — the attempts floor is what qualifies a hitter here
    mostEfficient: leader(scored, attackEff,
      { label, min: -Infinity, qualifies: r => r.attack >= attackFloor(scored) }),
    setter,
    run: longestRun(games, rallies, plays, idents, label),
    aces: leader(scored, r => r.ace, { label, min: 2 }),
    digs: leader(scored, r => r.digOk, { label, min: 1 }),
    longestRally: longest && longest.seconds > 0
      ? { ...longest, url: `${origin}/r/${longest.id}` } : null,
  };

  // Every name the headline lines have already spent. Roster names are
  // deliberately absent — they list everyone who played, so excluding them
  // would leave no candidates at all.
  const h = highlights;
  const used = [
    ...(h.topScorer?.names ?? []), ...(h.mostEfficient?.names ?? []),
    ...(h.setter?.names ?? []), ...(h.setter?.top ? [h.setter.top.who] : []),
    ...(h.run ? [h.run.name] : []),
    ...(h.aces?.names ?? []), ...(h.digs?.names ?? []),
  ];
  highlights.shoutouts = shoutouts(scored,
    { used, sparks, attackFloor: attackFloor(scored), defenceFloor: defenceFloor(scored) },
    label);

  return {
    date, when,
    games: gs,
    approx: gs.some(g => g.score?.approx),
    highlights,
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
    const names = g.roster.length
      ? joinNames(g.roster) + (g.unnamed ? ` +${g.unnamed}` : "") : null;
    out.push(`${g.label}: ${names ? `${names} — ${line}` : line}`);
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
  if (h.setter)
    out.push(`🤝 Setter of the night: ${joinNames(h.setter.names)} — `
      + `${plural(h.setter.value, "assist")}`
      + (h.setter.top ? `, ${h.setter.top.kills} to ${h.setter.top.who}` : ""));
  if (h.run)
    out.push(`🔥 Serving run: ${h.run.name}, ${h.run.points} straight`);
  // Skip the aces line when the top-scorer line already spelled out the same
  // person's aces — a six-line post can't afford to say a thing twice.
  const acesToldAbove = h.aces && h.topScorer
    && h.aces.rows.length === 1 && h.topScorer.rows.length === 1
    && h.aces.rows[0].key === h.topScorer.rows[0].key;
  if (h.aces && !acesToldAbove)
    out.push(`🎈 Aces: ${joinNames(h.aces.names)} — ${h.aces.value}`);
  // "Most digs", not "best defense": dig errors are seldom flagged, so digOk
  // tracks the raw count. As a count it's true; as a claim about quality it
  // would be overstated. The Spark below is the one that measures what came
  // of them.
  if (h.digs)
    out.push(`🛡️ Most digs: ${joinNames(h.digs.names)} — ${plural(h.digs.value, "dig")}`);
  if (h.longestRally) {
    out.push(`🏆 Longest rally: ${h.longestRally.seconds}s, `
      + `${plural(h.longestRally.touches, "touch", "touches")}`);
    out.push(`   ${h.longestRally.url}`);
  }

  // One icon per line, matching the headline block above — a run of bare
  // labels under a row of emoji lines reads as an afterthought.
  if (h.shoutouts?.length) {
    out.push("", "👏 Shout-outs");
    for (const s2 of h.shoutouts)
      out.push(`${s2.icon} ${s2.label}: ${joinNames(s2.names)} — ${s2.detail}`);
  }

  out.push("", `All clips: ${s.links.clips}`, `Stats: ${s.links.stats}`);
  if (s.approx)
    out.push("", "* a few points couldn't be pinned to a team — score is close, not exact");
  return out.join("\n");
}
