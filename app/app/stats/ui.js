"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { attackEff } from "@/lib/player-stats";
import NextSession from "../next-session";

// VNL-style leaderboards. Points/faults come from rally outcomes; attempts
// and quality (assists, digs kept, positive receptions, blocked) from the
// derived touch grades (lib/grades.js), overridable per-chip in review.

const pct = (num, den) => den > 0 ? `${Math.round((num / den) * 100)}%` : "–";
const avg = (n, g) => g > 0 ? (n / g).toFixed(1) : "–";
// an already-computed ratio, rendered the way pct() renders a pair
const pctOf = r => r == null ? "–" : `${Math.round(r * 100)}%`;

// Each countable cell deep-links to the watch page filtered to exactly the
// rallies behind that number (stat keys defined in lib/grades.js STATS).
// Derived cells (%, avg) aren't linked.
const BOARDS = {
  scorers: {
    label: "Scorers", metric: "points",
    cols: ["attack", "block", "serve", "total", "avg/game"],
    sort: p => p.kill + p.stuff + p.ace,
    row: (p, L) => {
      const total = p.kill + p.stuff + p.ace;
      return [L(p.kill, "kill"), L(p.stuff, "stuff"), L(p.ace, "ace"),
        <b key="t">{total}</b>, avg(total, p.games)];
    },
  },
  attackers: {
    label: "Attackers", metric: "kills",
    cols: ["kills", "errors", "blocked", "attempts", "success", "efficiency"],
    sort: p => p.kill,
    row: (p, L) => [<b key="k">{L(p.kill, "kill")}</b>, L(p.atkErr, "attack_error"),
      L(p.blocked, "blocked"), L(p.attack, "attack"),
      pct(p.kill, p.attack), pctOf(attackEff(p))],
    note: "efficiency = (kills − errors − blocked) / attempts",
  },
  blockers: {
    label: "Blockers", metric: "stuff blocks",
    cols: ["stuffs", "touches", "avg/game"],
    sort: p => p.stuff,
    row: (p, L) => [<b key="s">{L(p.stuff, "stuff")}</b>, L(p.block, "block"),
      avg(p.stuff, p.games)],
  },
  servers: {
    label: "Servers", metric: "aces",
    cols: ["aces", "errors", "attempts", "ace %", "avg/game"],
    sort: p => p.ace,
    row: (p, L) => [<b key="a">{L(p.ace, "ace")}</b>, L(p.srvErr, "service_error"),
      L(p.serve, "serve"), pct(p.ace, p.serve), avg(p.ace, p.games)],
  },
  setters: {
    label: "Setters", metric: "assists",
    cols: ["assists", "errors", "attempts", "assist %"],
    sort: p => p.assist,
    row: (p, L) => [<b key="a">{L(p.assist, "assist")}</b>, L(p.setErr, "set_error"),
      L(p.set, "set"), pct(p.assist, p.set)],
    note: "assist = set immediately preceding a kill",
  },
  diggers: {
    label: "Diggers", metric: "digs kept in play",
    cols: ["digs kept", "errors", "total digs", "success %", "avg/game"],
    sort: p => p.digOk,
    row: (p, L) => [<b key="d">{L(p.digOk, "dig_kept")}</b>, L(p.digErr, "dig_error"),
      L(p.dig, "dig"), pct(p.digOk, p.dig), avg(p.digOk, p.games)],
  },
  receivers: {
    label: "Receivers", metric: "positive receptions",
    cols: ["positive", "errors", "total", "efficiency"],
    sort: p => p.recPos,
    row: (p, L) => [<b key="r">{L(p.recPos, "rec_pos")}</b>, L(p.recErr, "rec_error"),
      L(p.receive, "receive"), pct(p.recPos - p.recErr, p.receive)],
    note: "positive = reception followed by a set · error = shanked an ace",
  },
};

// link a count to its clips on the watch page; zeroes have nothing to show.
// The active scope carries through, so the clips you land on are exactly the
// ones behind the number you clicked — a session-scoped 3 must not open
// twelve clips from other nights.
const linkFor = (p, scope) => (v, stat) => v > 0
  ? <a className="statlink" title={`watch these ${v === 1 ? "clip" : "clips"}`}
      href={`/watch?player=${encodeURIComponent(p.name)}&stat=${stat}${scope}`}>{v}</a>
  : v;

const points = p => p.kill + p.stuff + p.ace;
const touches = p => p.serve + p.receive + p.dig + p.set + p.attack + p.block;
const errors = p => p.atkErr + p.srvErr + p.setErr + p.digErr + p.recErr;

// The comparison pane. Deliberately NOT the boards' raw counts: 7 kills across
// four nights and 7 kills in one are the same number and not the same player,
// so everything here is a rate — per game, or per attempt.
//
// Every row is num/den, which serves three purposes at once: the value (pct or
// avg of the pair), the fraction underneath, and the number the leader mark
// ranks on. One expression, not three that can drift.
//
// That fraction isn't decoration: a percentage with no denominator invites
// nonsense (100% off two receptions is not a great receiver). `hint` overrides
// it where the pair isn't self-explanatory; `stat` links the numerator to its
// clips, as the boards do. pct/avg already render "–" on a zero denominator, so
// a player who never served reads "–", not 0%.
//
// `dir` is which way is better: 1 = higher, -1 = LOWER (the two error rows —
// starring the biggest number there would crown the worst server in the room),
// absent = not a contest. `games` is context and `touches / game` is
// involvement rather than quality, so neither competes.
const SUMMARY = [
  { label: "games", kind: "raw", num: p => p.games },
  { label: "points / game", kind: "avg", dir: 1,
    num: p => points(p), den: p => p.games,
    hint: p => `${points(p)} in ${p.games}` },
  { label: "attack efficiency", kind: "pct", dir: 1,
    num: p => p.kill - p.atkErr - p.blocked, den: p => p.attack,
    hint: p => `${p.kill}k − ${p.atkErr}e − ${p.blocked}b / ${p.attack}` },
  { label: "kill %", kind: "pct", dir: 1,
    num: p => p.kill, den: p => p.attack, stat: "kill" },
  { label: "ace %", kind: "pct", dir: 1,
    num: p => p.ace, den: p => p.serve, stat: "ace" },
  { label: "serve error %", kind: "pct", dir: -1,
    num: p => p.srvErr, den: p => p.serve, stat: "service_error" },
  { label: "reception efficiency", kind: "pct", dir: 1,
    num: p => p.recPos - p.recErr, den: p => p.receive,
    hint: p => `${p.recPos}+ − ${p.recErr}e / ${p.receive}` },
  { label: "dig success %", kind: "pct", dir: 1,
    num: p => p.digOk, den: p => p.dig, stat: "dig_kept" },
  { label: "assist %", kind: "pct", dir: 1,
    num: p => p.assist, den: p => p.set, stat: "assist" },
  { label: "errors / game", kind: "avg", dir: -1,
    num: p => errors(p), den: p => p.games,
    hint: p => `${errors(p)} in ${p.games}` },
  { label: "touches / game", kind: "avg",
    num: p => touches(p), den: p => p.games,
    hint: p => `${touches(p)} in ${p.games}` },
];

const shownValue = (m, p) => m.kind === "raw" ? m.num(p)
  : m.kind === "avg" ? avg(m.num(p), m.den(p)) : pct(m.num(p), m.den(p));

// Rank on the number the reader can SEE, not the underlying float: two cells
// both showing "33%" must both be starred, and raw floats would star one of
// them and look like a bug. Null = not in the running ("–" never wins).
const shownScore = (m, p) => {
  if (!m.dir) return null;
  const d = m.den(p);
  if (!(d > 0)) return null;
  const r = m.num(p) / d;
  return m.kind === "avg" ? Math.round(r * 10) / 10 : Math.round(r * 100);
};

// The value that leads a row, or null when there's no contest: fewer than two
// players in the running makes a "winner" meaningless, not informative.
const leaderOf = (m, players) => {
  const scores = players.map(p => shownScore(m, p)).filter(s => s !== null);
  if (scores.length < 2) return null;
  const best = m.dir > 0 ? Math.max(...scores) : Math.min(...scores);
  // A field where the best anyone managed is zero has no winner to crown —
  // three stars on "0% assists" celebrates nobody setting. The error rows are
  // the opposite: zero of them IS the achievement, so those keep their star.
  if (best === 0 && m.dir > 0) return null;
  return best;
};

export default function Boards({ rows, nGames, nScored, game, day, days = [],
                                 initialPlayers = [], session = null }) {
  const router = useRouter();
  const [tab, setTab] = useState("scorers");
  const [picked, setPicked] = useState(() => new Set(initialPlayers));
  // folded by default; a shared ?players= link arrives with it open, since the
  // reader's first question is "who is in this comparison?"
  const [openPick, setOpenPick] = useState(initialPlayers.length > 0);
  const [filter, setFilter] = useState("");
  const b = BOARDS[tab];
  const ranked = [...rows]
    .filter(p => b.sort(p) > 0 || tab === "scorers")
    .sort((a, z) => b.sort(z) - b.sort(a));
  // what the boards are counting right now, as a label and as a URL fragment
  // for the per-cell clip links
  const scopeName = game ? game.name : day ? day.label : null;
  const scopeQS = game ? `&game=${game.id}` : day ? `&day=${day.day}` : "";

  // everyone who appears in the current scope, for the compare menu
  const names = [...rows].map(p => p.name)
    .sort((a, z) => a.localeCompare(z, undefined, { sensitivity: "base" }));
  // what the menu shows: matches the filter, chosen names first. Array#sort is
  // stable, so alphabetical order survives inside each group.
  const f = filter.trim().toLowerCase();
  const menu = names.filter(n => !f || n.toLowerCase().includes(f))
    .sort((a, z) => (picked.has(z) ? 1 : 0) - (picked.has(a) ? 1 : 0));
  // One order for every section. Sorting each card by its own metric would
  // shuffle the same people between cards, which is the one thing a
  // side-by-side comparison must not do.
  const compare = rows.filter(p => picked.has(p.name))
    .sort((a, z) => points(z) - points(a));
  // picked, but no rows in this scope — they didn't play. An empty column
  // reads as a bug, so say it out loud.
  const absent = [...picked].filter(n => !rows.some(p => p.name === n));

  // The selection is a URL so it can be shared and survives a refresh, but it
  // is NOT a navigation: every row is already on the client, so a chip toggle
  // rewrites the address bar rather than round-tripping the server component.
  // returns just the query string ("" when empty) so callers own the path
  const withPlayers = (base, sel) => {
    const q = new URLSearchParams(base);
    sel.size ? q.set("players", [...sel].join(",")) : q.delete("players");
    const s = q.toString();
    return s ? `?${s}` : "";
  };
  // Mirror the selection into the address bar after it commits, rather than
  // inside the click handler: two chips clicked in the same tick would both
  // read the same stale `picked` and the first one would be lost.
  // "" would leave the URL untouched, query and all — clearing needs the bare
  // path spelled out.
  useEffect(() => {
    window.history.replaceState(null, "",
      withPlayers(window.location.search, picked) || window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);
  const toggle = name => setPicked(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  return (
    <div>
      <div className="row headrow">
        <h1>Leaderboards{scopeName && <> · {scopeName}</>}</h1>
        <NextSession session={session} />
      </div>
      {days.length > 0 && (
        <div className="row" style={{ margin: "8px 0" }}>
          <label className="muted" htmlFor="session">Session</label>
          {/* a session is a URL, not component state: it has to survive a
              refresh and be shareable, same as ?game= already is */}
          <select id="session" value={day?.day ?? "all"}
            onChange={e => {
              // a session change IS a navigation (the server re-queries), but
              // it must not drop who you were comparing
              const q = new URLSearchParams();
              if (e.target.value !== "all") q.set("day", e.target.value);
              router.push(`/stats${withPlayers(q, picked)}`);
            }}>
            <option value="all">All sessions</option>
            {days.map(x => (
              <option key={x.day} value={x.day}>
                {x.label} ({x.games} game{x.games === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        </div>
      )}
      {scopeName && <p className="muted">
        Showing <b>{scopeName}</b> only · <a href="/stats">all games</a></p>}
      <p className="muted">
        {nGames} {day ? "" : "published "}game{nGames === 1 ? "" : "s"}
        {" · "}{nScored} scored rall{nScored === 1 ? "y" : "ies"}
        {" · "}quality stats derived from touch order + rally outcomes
        (override per-touch in review)
      </p>
      {/* The comparison is a side feature, so its roster stays folded away —
          one muted line unless you go looking. Clicking a name in the board
          below is the everyday way in; this is for reaching someone who isn't
          on the board you happen to be looking at. */}
      {names.length > 0 && (
        <details className="compare" open={openPick}
          onToggle={e => setOpenPick(e.currentTarget.open)}>
          <summary className="muted">
            Compare players{picked.size > 0 ? ` (${picked.size})` : ""}
          </summary>
          {/* A roster this long is a menu, not a row of buttons — 40 chips is
              the clutter this replaces. Same shape as the review page's player
              picker: type to narrow, tap a full-width row. Chosen names float
              to the top so the current selection is always the first thing in
              view, however far you've scrolled or filtered. */}
          <div className="pickmenu">
            {names.length > 8 && (
              <input type="text" value={filter} placeholder="type a name…"
                autoComplete="off" aria-label="filter players"
                onChange={e => setFilter(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && menu.length) {
                    toggle(menu[0]); setFilter(""); e.preventDefault();
                  } else if (e.key === "Escape") { setFilter(""); e.preventDefault(); }
                }} />
            )}
            <div className="picklist">
              {menu.map(n => (
                <button key={n} onClick={() => toggle(n)}
                  className={"pick" + (picked.has(n) ? " on" : "")}
                  aria-pressed={picked.has(n)}>
                  <span className="tick">{picked.has(n) ? "✓" : ""}</span>{n}
                </button>
              ))}
              {menu.length === 0 && <p className="muted" style={{ margin: 4 }}>No match.</p>}
            </div>
            {picked.size > 0 && (
              <button className="fchip" style={{ marginTop: 8 }}
                onClick={() => setPicked(new Set())}>clear {picked.size} ✕</button>
            )}
          </div>
        </details>
      )}

      {(compare.length > 0 || absent.length > 0) && (
        <div className="card summary">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: "2px 0 8px" }}>
              {compare.length === 1 ? compare[0].name : "Comparison"}
            </h2>
            <button className="fchip" onClick={() => setPicked(new Set())}>clear ✕</button>
          </div>
          {absent.length > 0 && (
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>
              {absent.join(", ")} didn&apos;t play {scopeName ?? "in any published game"}.
            </p>
          )}
          {compare.length > 0 && (
            <div className="tablewrap">
              <table className="leader summary-t">
                <thead><tr>
                  <th style={{ textAlign: "left" }}>&nbsp;</th>
                  {compare.map(p => <th key={p.key ?? p.name}>{p.name}</th>)}
                </tr></thead>
                <tbody>
                  {SUMMARY.map(m => {
                    // only a field of two or more is a contest worth calling
                    const best = compare.length > 1 ? leaderOf(m, compare) : null;
                    return (
                      <tr key={m.label}>
                        <th scope="row">{m.label}</th>
                        {compare.map(p => {
                          const L = linkFor(p, scopeQS);
                          const hint = m.hint ? m.hint(p)
                            : m.kind !== "raw" ? <>{L(m.num(p), m.stat)} of {m.den(p)}</> : null;
                          const lead = best !== null && shownScore(m, p) === best;
                          return (
                            <td key={p.key ?? p.name}>
                              <b className={lead ? "best" : undefined}>{shownValue(m, p)}</b>
                              {lead && <span className="beststar" role="img"
                                title={m.dir > 0 ? "best of the selected players"
                                  : "lowest of the selected players"}
                                aria-label="best">★</span>}
                              {hint && <span className="sub">{hint}</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="tabs">
        {Object.entries(BOARDS).map(([k, v]) => (
          <button key={k} onClick={() => setTab(k)}
            className={k === tab ? "primary" : undefined}>
            {v.label}
          </button>
        ))}
      </div>
      <div className="card">
        <h2 style={{ margin: "2px 0 8px" }}>Best {b.label}</h2>
        {b.note && <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>{b.note}</p>}
        <div className="tablewrap">
        <table className="leader">
          <thead><tr>
            <th></th>
            <th style={{ textAlign: "left" }}>Player</th>
            {b.cols.map(c => <th key={c}>{c}</th>)}
            <th>games</th>
          </tr></thead>
          <tbody>
            {ranked.map((p, i) => (
              <tr key={p.key ?? p.name} style={i < 3 ? { fontWeight: 600 } : undefined}>
                <td style={{ color: i < 3 ? "var(--gold)" : undefined }}>{i + 1}</td>
                <td style={{ textAlign: "left" }}>
                  {/* the everyday way into the comparison — no extra chrome on
                      the page, just the name you were already reading */}
                  <button className={"pickname" + (picked.has(p.name) ? " on" : "")}
                    aria-pressed={picked.has(p.name)}
                    title={picked.has(p.name) ? "remove from comparison" : "compare this player"}
                    onClick={() => toggle(p.name)}>{p.name}</button>
                </td>
                {b.row(p, linkFor(p, scopeQS)).map((v, j) => <td key={j}>{v}</td>)}
                <td className="muted">{p.games}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {ranked.length === 0 && <p className="muted">
          No {b.metric} recorded yet — review and publish a game first.</p>}
      </div>
    </div>
  );
}
