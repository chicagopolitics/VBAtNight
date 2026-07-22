"use client";
import { useState } from "react";

// VNL-style leaderboards. Points/faults come from rally outcomes; attempts
// and quality (assists, digs kept, positive receptions, blocked) from the
// derived touch grades (lib/grades.js), overridable per-chip in review.

const pct = (num, den) => den > 0 ? `${Math.round((num / den) * 100)}%` : "–";
const avg = (n, g) => g > 0 ? (n / g).toFixed(1) : "–";

const BOARDS = {
  scorers: {
    label: "Scorers", metric: "points",
    cols: ["attack", "block", "serve", "total", "avg/game"],
    sort: p => p.kill + p.stuff + p.ace,
    row: p => {
      const total = p.kill + p.stuff + p.ace;
      return [p.kill, p.stuff, p.ace, <b key="t">{total}</b>, avg(total, p.games)];
    },
  },
  attackers: {
    label: "Attackers", metric: "kills",
    cols: ["kills", "errors", "blocked", "attempts", "success", "efficiency"],
    sort: p => p.kill,
    row: p => [<b key="k">{p.kill}</b>, p.atkErr, p.blocked, p.attack,
      pct(p.kill, p.attack), pct(p.kill - p.atkErr - p.blocked, p.attack)],
    note: "efficiency = (kills − errors − blocked) / attempts",
  },
  blockers: {
    label: "Blockers", metric: "stuff blocks",
    cols: ["stuffs", "touches", "avg/game"],
    sort: p => p.stuff,
    row: p => [<b key="s">{p.stuff}</b>, p.block, avg(p.stuff, p.games)],
  },
  servers: {
    label: "Servers", metric: "aces",
    cols: ["aces", "errors", "attempts", "ace %", "avg/game"],
    sort: p => p.ace,
    row: p => [<b key="a">{p.ace}</b>, p.srvErr, p.serve,
      pct(p.ace, p.serve), avg(p.ace, p.games)],
  },
  setters: {
    label: "Setters", metric: "assists",
    cols: ["assists", "errors", "attempts", "assist %"],
    sort: p => p.assist,
    row: p => [<b key="a">{p.assist}</b>, p.setErr, p.set, pct(p.assist, p.set)],
    note: "assist = set immediately preceding a kill",
  },
  diggers: {
    label: "Diggers", metric: "digs kept in play",
    cols: ["digs kept", "errors", "total digs", "success %", "avg/game"],
    sort: p => p.digOk,
    row: p => [<b key="d">{p.digOk}</b>, p.digErr, p.dig,
      pct(p.digOk, p.dig), avg(p.digOk, p.games)],
  },
  receivers: {
    label: "Receivers", metric: "positive receptions",
    cols: ["positive", "errors", "total", "efficiency"],
    sort: p => p.recPos,
    row: p => [<b key="r">{p.recPos}</b>, p.recErr, p.receive,
      pct(p.recPos - p.recErr, p.receive)],
    note: "positive = reception followed by a set · error = shanked an ace",
  },
};

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
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {Object.entries(BOARDS).map(([k, v]) => (
          <button key={k} onClick={() => setTab(k)}
            style={k === tab ? { background: "#2c62c9", borderColor: "#2c62c9",
              color: "#fff" } : undefined}>
            {v.label}
          </button>
        ))}
      </div>
      <div className="card" style={{ overflowX: "auto" }}>
        <h2 style={{ margin: "2px 0 8px" }}>Best {b.label}</h2>
        {b.note && <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>{b.note}</p>}
        <table>
          <thead><tr>
            <th style={{ width: 30 }}></th>
            <th style={{ textAlign: "left" }}>Player</th>
            {b.cols.map(c => <th key={c}>{c}</th>)}
            <th>games</th>
          </tr></thead>
          <tbody>
            {ranked.map((p, i) => (
              <tr key={p.key ?? p.name} style={i < 3 ? { color: "#e8eaed" } : undefined}>
                <td style={{ color: i < 3 ? "#ffd34c" : undefined }}>{i + 1}</td>
                <td style={{ textAlign: "left" }}>{p.name}</td>
                {b.row(p).map((v, j) => <td key={j}>{v}</td>)}
                <td className="muted">{p.games}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {ranked.length === 0 && <p className="muted">
          No {b.metric} recorded yet — review and publish a game first.</p>}
      </div>
    </div>
  );
}
