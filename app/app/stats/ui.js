"use client";
import { useState } from "react";

// VNL-style leaderboards. Points/faults come from rally outcomes; attempts
// and quality (assists, digs kept, positive receptions, blocked) from the
// derived touch grades (lib/grades.js), overridable per-chip in review.

const pct = (num, den) => den > 0 ? `${Math.round((num / den) * 100)}%` : "–";
const avg = (n, g) => g > 0 ? (n / g).toFixed(1) : "–";

// Each countable cell deep-links to the watch page filtered to exactly the
// rallies behind that number (stat keys defined in watch/ui.js STATS).
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
      pct(p.kill, p.attack), pct(p.kill - p.atkErr - p.blocked, p.attack)],
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

// link a count to its clips on the watch page; zeroes have nothing to show
const linkFor = p => (v, stat) => v > 0
  ? <a className="statlink" title={`watch these ${v === 1 ? "clip" : "clips"}`}
      href={`/watch?player=${encodeURIComponent(p.name)}&stat=${stat}`}>{v}</a>
  : v;

export default function Boards({ rows, nGames, nScored }) {
  const [tab, setTab] = useState("scorers");
  const b = BOARDS[tab];
  const ranked = [...rows]
    .filter(p => b.sort(p) > 0 || tab === "scorers")
    .sort((a, z) => b.sort(z) - b.sort(a));

  return (
    <div>
      <h1>Leaderboards</h1>
      <p className="muted">
        {nGames} published game{nGames === 1 ? "" : "s"} · {nScored} scored
        rall{nScored === 1 ? "y" : "ies"} · quality stats derived from touch
        order + rally outcomes (override per-touch in review)
      </p>
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
                <td style={{ color: i < 3 ? "#c9a227" : undefined }}>{i + 1}</td>
                <td style={{ textAlign: "left" }}>{p.name}</td>
                {b.row(p, linkFor(p)).map((v, j) => <td key={j}>{v}</td>)}
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
