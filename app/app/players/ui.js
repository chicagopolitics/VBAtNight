"use client";
import { useState, useMemo } from "react";

// Player registry admin. Merge = two rows are the same person (repoint
// identities, drop one). Split = one row mixed up two people: select some of
// its per-game chips and move them to a new/other player.
export default function PlayersAdmin({ players: initial, dupes = [] }) {
  const [players, setPlayers] = useState(initial);
  const [sel, setSel] = useState({});          // identityId -> true (split picks)
  const [merging, setMerging] = useState(null); // player id showing merge picker
  const [confirmMerge, setConfirmMerge] = useState(null); // { src, dst }
  const [undo, setUndo] = useState(null);       // { name, identityIds }
  const [dismissed, setDismissed] = useState({}); // "a:b" -> true
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("games");

  const byId = id => players.find(p => p.id === id);
  const games = list => new Set(list.map(i => i.game_id)).size;
  const initials = n => n.trim().slice(0, 1).toUpperCase() || "?";

  const view = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let out = players.filter(p => !ql || p.display_name.toLowerCase().includes(ql));
    const cmp = { games: (a, b) => b.games - a.games || b.touches - a.touches,
      name: (a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }),
      touches: (a, b) => b.touches - a.touches };
    return [...out].sort(cmp[sort]);
  }, [players, q, sort]);

  const openDupes = dupes.filter(dp => !dismissed[`${dp.a}:${dp.b}`]
    && byId(dp.a) && byId(dp.b));

  async function rename(id, display_name) {
    const nm = display_name.trim();
    if (!nm || nm === byId(id)?.display_name) return;
    await fetch("/api/players", { method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, display_name: nm }) });
    setPlayers(ps => ps.map(p => p.id === id ? { ...p, display_name: nm } : p));
  }

  async function doMerge(src, dst) {
    const s = byId(src);
    await fetch("/api/players", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "merge", src, dst }) });
    setPlayers(ps => {
      const moved = (s?.identities || []).map(i => ({ ...i, player_id: dst }));
      return ps.filter(p => p.id !== src).map(p => {
        if (p.id !== dst) return p;
        const list = [...p.identities, ...moved];
        return { ...p, identities: list, games: games(list),
          touches: p.touches + (s?.touches || 0), points: p.points + (s?.points || 0) };
      });
    });
    setUndo({ name: s?.display_name, identityIds: (s?.identities || []).map(i => i.id) });
    setConfirmMerge(null); setMerging(null);
    setTimeout(() => setUndo(u => (u && u.name === s?.display_name ? null : u)), 8000);
  }

  async function undoMerge() {
    const res = await fetch("/api/players", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: undo.name }) });
    const p = await res.json();
    await reassign(undo.identityIds, p);
    setUndo(null);
  }

  async function reassign(identIds, target) {   // target = { id, display_name }
    for (const iid of identIds)
      await fetch("/api/identities", { method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: iid, player_id: target.id, name: target.display_name }) });
    setPlayers(ps => {
      const moved = [];
      let out = ps.map(p => {
        const keep = p.identities.filter(i => !identIds.includes(i.id));
        const gone = p.identities.filter(i => identIds.includes(i.id));
        moved.push(...gone.map(i => ({ ...i, player_id: target.id })));
        const t = keep.reduce((s, i) => s + i.touches, 0);
        const pt = keep.reduce((s, i) => s + i.points, 0);
        return { ...p, identities: keep, games: games(keep), touches: t, points: pt };
      });
      const exists = out.find(p => p.id === target.id);
      const mt = moved.reduce((s, i) => s + i.touches, 0);
      const mp = moved.reduce((s, i) => s + i.points, 0);
      if (exists) out = out.map(p => p.id === target.id
        ? { ...p, identities: [...p.identities, ...moved], games: games([...p.identities, ...moved]),
            touches: p.touches + mt, points: p.points + mp } : p);
      else out = [...out, { ...target, identities: moved, games: games(moved),
        touches: mt, points: mp }];
      return out;
    });
    setSel({});
  }

  async function splitToNew(identIds) {
    const name = window.prompt("New player name:");
    if (!name || !name.trim()) return;
    const res = await fetch("/api/players", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: name.trim() }) });
    await reassign(identIds, await res.json());
  }

  const toggle = id => setSel(s => ({ ...s, [id]: !s[id] }));
  const selectedOf = p => p.identities.filter(i => sel[i.id]).map(i => i.id);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>Players</h1>
          <p className="muted" style={{ margin: 0 }}>
            The durable player registry — one row per person, tracked across games.
          </p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="search">
            <span className="search-i">⌕</span>
            <input type="text" placeholder="Search players" value={q}
              onChange={e => setQ(e.target.value)} />
          </span>
          <select value={sort} onChange={e => setSort(e.target.value)}>
            <option value="games">Most games</option>
            <option value="touches">Most touches</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      {openDupes.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {openDupes.map(dp => {
            const a = byId(dp.a), b = byId(dp.b);
            const key = `${dp.a}:${dp.b}`;
            return (
              <div className="dup-banner" key={key}>
                <span className="dup-ic">⚠</span>
                <span style={{ flex: 1 }}>
                  Possible duplicate — <b>{a.display_name}</b> and <b>{b.display_name}</b>
                  {" "}<span className="muted">({dp.reason})</span>
                </span>
                <button onClick={() => setConfirmMerge({ src: dp.b, dst: dp.a })}>
                  Merge into {a.display_name}
                </button>
                <button onClick={() => setDismissed(x => ({ ...x, [key]: true }))}
                  title="dismiss">✕</button>
              </div>
            );
          })}
        </div>
      )}

      {confirmMerge && (() => {
        const src = byId(confirmMerge.src), dst = byId(confirmMerge.dst);
        if (!src || !dst) return null;
        return (
          <div className="modal-overlay" onClick={() => setConfirmMerge(null)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ width: "min(460px,94vw)" }}>
              <h2 style={{ marginTop: 0 }}>Merge players?</h2>
              <p>
                <b>{src.display_name}</b>’s {src.games} game{src.games === 1 ? "" : "s"} and
                {" "}{src.touches} touches will move into <b>{dst.display_name}</b>.
                {" "}<b>{src.display_name}</b> will be removed.
              </p>
              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => setConfirmMerge(null)}>Cancel</button>
                <button className="primary" onClick={() => doMerge(src.id, dst.id)}>Merge</button>
              </div>
            </div>
          </div>
        );
      })()}

      <div style={{ marginTop: 16 }}>
        {view.map(p => {
          const picks = selectedOf(p);
          return (
            <div className="pcard" key={p.id}>
              <div className="row" style={{ alignItems: "center", gap: 12 }}>
                <span className="avatar">
                  {p.identities[0]?.crop
                    ? <img src={p.identities[0].crop} alt="" />
                    : initials(p.display_name)}
                </span>
                <span className="name-edit" style={{ flex: 1, minWidth: 0 }}>
                  <input type="text" defaultValue={p.display_name}
                    onKeyDown={e => e.key === "Enter" && e.target.blur()}
                    onBlur={e => rename(p.id, e.target.value)} />
                  <span className="pencil">✎</span>
                  <div className="muted stat-line">
                    {p.games} game{p.games === 1 ? "" : "s"} · {p.touches} touches
                    {p.points > 0 && <> · {p.points} points</>}
                  </div>
                </span>
                {merging === p.id ? (
                  <select autoFocus defaultValue="" onBlur={() => setMerging(null)}
                    onChange={e => e.target.value &&
                      setConfirmMerge({ src: p.id, dst: +e.target.value })}>
                    <option value="" disabled>Merge into…</option>
                    {players.filter(x => x.id !== p.id).map(x =>
                      <option key={x.id} value={x.id}>{x.display_name}</option>)}
                  </select>
                ) : (
                  <button onClick={() => setMerging(p.id)}>Merge…</button>
                )}
                {picks.length > 0 && (
                  <span className="row" style={{ gap: 6 }}>
                    <button className="primary" onClick={() => splitToNew(picks)}>
                      Split off {picks.length}
                    </button>
                    <select defaultValue="" onChange={e => {
                      const t = players.find(x => x.id === +e.target.value);
                      if (t) reassign(picks, t);
                      e.target.value = "";
                    }}>
                      <option value="" disabled>to existing…</option>
                      {players.filter(x => x.id !== p.id).map(x =>
                        <option key={x.id} value={x.id}>{x.display_name}</option>)}
                    </select>
                  </span>
                )}
              </div>
              <div className="chip-row">
                {p.identities.map(i => (
                  <button key={i.id} type="button" onClick={() => toggle(i.id)}
                    className={"gchip" + (sel[i.id] ? " on" : "")}
                    title="click to select for split">
                    <span className="gchip-th">
                      {i.crop && <img src={i.crop} alt="" />}
                      <span className="gchip-check">✓</span>
                    </span>
                    <span className="gchip-meta">
                      <span>{i.game_name}</span>
                      <span className="muted">{i.touches} touches</span>
                    </span>
                  </button>
                ))}
                {p.identities.length === 0 && <span className="muted">no linked identities</span>}
              </div>
            </div>
          );
        })}
        {view.length === 0 && <p className="muted">
          {q ? "No players match your search." :
            "No players yet — link identities in a game's naming step, or run the backfill."}</p>}
      </div>

      {undo && (
        <div className="toast">
          <span>Merged <b>{undo.name}</b>.</span>
          <button onClick={undoMerge}>Undo</button>
        </div>
      )}
    </div>
  );
}
