"use client";
import { useMemo, useState } from "react";

const TYPES = ["serve", "receive", "dig", "set", "attack", "block"];

export default function Highlights({ games }) {
  const [game, setGame] = useState("all");
  const [player, setPlayer] = useState("all");
  const [type, setType] = useState("all");

  // every named participant across published games (touches + outcomes)
  const players = useMemo(() => {
    const s = new Set();
    for (const g of games) for (const r of g.rallies) {
      if (r.outcome_name) s.add(r.outcome_name);
      for (const t of r.touches) if (t.name) s.add(t.name);
    }
    return [...s].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [games]);

  const filtering = player !== "all" || type !== "all";
  const matchTouch = t =>
    (player === "all" || t.name === player) && (type === "all" || t.type === type);

  const shown = games
    .filter(g => game === "all" || g.id === +game)
    .map(g => ({ ...g, rallies: g.rallies
      .map((r, i) => ({ ...r, num: i + 1,
        matched: filtering ? r.touches.filter(matchTouch) : [] }))
      .filter(r => !filtering || r.matched.length > 0) }))
    .filter(g => g.rallies.length > 0);
  const total = shown.reduce((a, g) => a + g.rallies.length, 0);

  return (
    <div>
      <h1>Highlights</h1>
      <div className="row card" style={{ position: "sticky", top: 0, zIndex: 10 }}>
        <select value={game} onChange={e => setGame(e.target.value)}>
          <option value="all">All games</option>
          {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select value={player} onChange={e => setPlayer(e.target.value)}>
          <option value="all">All players</option>
          {players.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={type} onChange={e => setType(e.target.value)}>
          <option value="all">All touches</option>
          {TYPES.map(t => <option key={t} value={t}>{t}s</option>)}
        </select>
        <span className="muted">{total} rall{total === 1 ? "y" : "ies"}</span>
        {filtering && (
          <button onClick={() => { setPlayer("all"); setType("all"); }}>clear</button>
        )}
      </div>
      {games.length === 0 && <p className="muted">Nothing published yet — check back soon.</p>}
      {games.length > 0 && total === 0 &&
        <p className="muted">No rallies match those filters.</p>}
      {shown.map(g => (
        <div key={g.id}>
          <h2>{g.name}</h2>
          <div className="grid-clips">
            {g.rallies.map(r => {
              // #t fragment plays only this rally's window, whether the media
              // is a per-rally clip (old bundles) or the full-game video (v8)
              const base = r.clip_file ||
                (g.video_file?.startsWith("/media/") ? g.video_file : null);
              if (!base) return null;
              const cs = r.clip_file ? (r.clip_start_s ?? r.start_s - 2) : 0;
              // when filtering, start just before the first matching touch so
              // the clip opens on the moment you asked for
              const from = r.matched.length
                ? Math.max(r.start_s - 2, r.matched[0].t - 3) : r.start_s - 2;
              const frag = `#t=${Math.max(0, from - cs).toFixed(1)},${(r.end_s - cs + 2).toFixed(1)}`;
              return (
                <div className="card" key={r.id}>
                  <video src={base + frag} controls preload="metadata" />
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span>
                      Rally {r.num}
                      {r.matched.length > 0 && (
                        <span className="muted">
                          {" · "}{r.matched.map(m =>
                            `${m.name || "?"} ${m.type}`).join(", ")}
                        </span>
                      )}
                    </span>
                    <span className="muted">
                      {Math.round(r.end_s - r.start_s)}s
                      {r.outcome_type ? ` · ${r.outcome_type.replace("_", " ")}` : ""}
                      {r.outcome_name ? ` by ${r.outcome_name}` : ""}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
