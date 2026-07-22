"use client";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

// Filterable stats. Three kinds:
//   touch    — plain attempt counts (matches touch.type)
//   +grade   — quality subset of a touch type (derived in lib/grades.js)
//   outcome  — rally-ending points/faults (matches rally.outcome_*)
// Stats-page cells deep-link here as /watch?player=<name>&stat=<key>.
export const STATS = {
  serve: { label: "serves", touch: "serve" },
  receive: { label: "receives", touch: "receive" },
  dig: { label: "digs", touch: "dig" },
  set: { label: "sets", touch: "set" },
  attack: { label: "attacks", touch: "attack" },
  block: { label: "block touches", touch: "block" },
  kill: { label: "kills", outcome: "kill" },
  ace: { label: "aces", outcome: "ace" },
  stuff: { label: "stuff blocks", outcome: "block" },
  attack_error: { label: "attack errors", outcome: "attack_error" },
  service_error: { label: "serve errors", outcome: "service_error" },
  assist: { label: "assists", touch: "set", grade: "assist" },
  set_error: { label: "set errors", touch: "set", grade: "error" },
  dig_kept: { label: "digs kept in play", touch: "dig", grade: "success" },
  dig_error: { label: "dig errors", touch: "dig", grade: "error" },
  rec_pos: { label: "positive receptions", touch: "receive", grade: "positive" },
  rec_error: { label: "reception errors", touch: "receive", grade: "error" },
  blocked: { label: "blocked attacks", touch: "attack", grade: "blocked" },
};
const GROUPS = [
  ["Touches", ["serve", "receive", "dig", "set", "attack", "block"]],
  ["Points & faults", ["kill", "ace", "stuff", "attack_error", "service_error"]],
  ["Quality", ["assist", "rec_pos", "dig_kept", "blocked", "set_error", "dig_error", "rec_error"]],
];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = d => {
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return `${MON[+m - 1]} ${+day}, ${y}`;
};

export default function Highlights({ games }) {
  const sp = useSearchParams();
  const [game, setGame] = useState("all");
  const [player, setPlayer] = useState(sp.get("player") || "all");
  const [stat, setStat] = useState(STATS[sp.get("stat")] ? sp.get("stat") : "all");
  const [open, setOpen] = useState(() => new Set());
  const toggle = id => setOpen(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // every named participant across published games (touches + outcomes)
  const players = useMemo(() => {
    const s = new Set();
    for (const g of games) for (const r of g.rallies) {
      if (r.outcome_name) s.add(r.outcome_name);
      for (const t of r.touches) if (t.name) s.add(t.name);
    }
    return [...s].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [games]);

  const s = STATS[stat];
  const filtering = player !== "all" || stat !== "all";
  const matchTouch = t =>
    (player === "all" || t.name === player) &&
    (!s || (t.type === s.touch && (!s.grade || t.grade === s.grade)));

  const shown = games
    .filter(g => game === "all" || g.id === +game)
    .map(g => ({ ...g, rallies: g.rallies
      .map((r, i) => {
        // outcome stats live on the rally, not a touch: match the rally
        // itself and cue playback near the end where the point was won
        if (s?.outcome) {
          const ok = r.outcome_type === s.outcome &&
            (player === "all" || r.outcome_name === player);
          return { ...r, num: i + 1, matched: [], atEnd: true, ok };
        }
        const matched = filtering ? r.touches.filter(matchTouch) : [];
        return { ...r, num: i + 1, matched, ok: !filtering || matched.length > 0 };
      })
      .filter(r => r.ok) }))
    .filter(g => g.rallies.length > 0);
  const total = shown.reduce((a, g) => a + g.rallies.length, 0);
  // any active filter means the visitor asked for specific clips — show them
  // right away; otherwise games start collapsed so nothing preloads
  const autoExpand = filtering || game !== "all";

  return (
    <div>
      <h1>Highlights</h1>
      <div className="row card filters">
        <select value={game} onChange={e => setGame(e.target.value)}>
          <option value="all">All games</option>
          {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select value={player} onChange={e => setPlayer(e.target.value)}>
          <option value="all">All players</option>
          {players.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={stat} onChange={e => setStat(e.target.value)}>
          <option value="all">All plays</option>
          {GROUPS.map(([label, keys]) => (
            <optgroup key={label} label={label}>
              {keys.map(k => <option key={k} value={k}>{STATS[k].label}</option>)}
            </optgroup>
          ))}
        </select>
        <span className="muted">{total} rall{total === 1 ? "y" : "ies"}</span>
        {filtering && (
          <button onClick={() => { setPlayer("all"); setStat("all"); }}>clear</button>
        )}
      </div>
      {games.length === 0 && <p className="muted">Nothing published yet — check back soon.</p>}
      {games.length > 0 && total === 0 &&
        <p className="muted">No rallies match those filters.</p>}
      {shown.map(g => {
        const isOpen = autoExpand || open.has(g.id);
        const rosters = [
          g.teamA?.length ? `Team A: ${g.teamA.join(", ")}` : null,
          g.teamB?.length ? `Team B: ${g.teamB.join(", ")}` : null,
          g.others?.length ? `${g.teamA?.length || g.teamB?.length ? "Also" : "Players"}: ${g.others.join(", ")}` : null,
        ].filter(Boolean).join(" · ");
        return (
        <div key={g.id}>
          <div className="card gamecard" onClick={() => toggle(g.id)}
            role="button" aria-expanded={isOpen}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{g.name}</b>
              <span className="muted">
                {[fmtDate(g.date), `${g.rallies.length} rall${g.rallies.length === 1 ? "y" : "ies"}`]
                  .filter(Boolean).join(" · ")} {isOpen ? "▾" : "▸"}
              </span>
            </div>
            {rosters && <div className="muted" style={{ marginTop: 4 }}>{rosters}</div>}
          </div>
          {isOpen && <div className="grid-clips">
            {g.rallies.map(r => {
              // #t fragment plays only this rally's window, whether the media
              // is a per-rally clip (old bundles) or the full-game video (v8)
              const base = r.clip_file ||
                (g.video_file?.startsWith("/media/") ? g.video_file : null);
              if (!base) return null;
              const cs = r.clip_file ? (r.clip_start_s ?? r.start_s - 2) : 0;
              // start just before the moment you asked for: the first
              // matching touch, or the rally-ending play for outcome stats
              const from = r.atEnd ? Math.max(r.start_s - 2, r.end_s - 6)
                : r.matched.length
                  ? Math.max(r.start_s - 2, r.matched[0].t - 3) : r.start_s - 2;
              const frag = `#t=${Math.max(0, from - cs).toFixed(1)},${(r.end_s - cs + 2).toFixed(1)}`;
              return (
                <div className="card" key={r.id}>
                  <video src={base + frag} controls playsInline preload="metadata" />
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
          </div>}
        </div>
        );
      })}
    </div>
  );
}
