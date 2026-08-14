"use client";
import { useState, useEffect, createContext, useContext } from "react";

const label = r => r.name || `P${r.cluster_id}`;
const thumb = r => r.tracklets?.[0]?.crops?.[0] || r.rep_crops?.[0];
const nCrops = r => (r.tracklets || []).reduce((n, t) => n + t.crops.length, 0)
  || (r.rep_crops || []).length;

// What the cards read from the grid. The context exists so that Card,
// PlayerCombo and TeamToggle can live at MODULE scope: a component declared
// inside IdentityGrid is a new function — a new component *type* — on every
// render, so React unmounts the whole list and re-mounts it instead of updating
// it. That reloads every crop, drops whatever the reviewer had typed into a
// combo, and (because the browser clamps scrollTop the instant content leaves
// the document) throws the page back to the top on every single click.
const Grid = createContext(null);

export default function IdentityGrid({ idents, gameId, nameSuggestions = {},
  players: playersProp = [], teamSuggest = {}, courtVideo = null, rallyStarts = [],
  dismissed: dismissedProp = [] }) {
  const [rows, setRows] = useState(idents);
  const [players, setPlayers] = useState(playersProp);
  const [mergeSrc, setMergeSrc] = useState(null);
  const [courtOpen, setCourtOpen] = useState(false);
  const [shot, setShot] = useState(0);   // which rally start to show
  const [splitting, setSplitting] = useState(null);
  const [selected, setSelected] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [gone, setGone] = useState(dismissedProp);   // dismissed, restorable
  const [undo, setUndo] = useState(null);            // the toast's subject

  const byId = id => rows.find(r => r.id === id);

  async function patch(id, body) {
    const res = await fetch("/api/identities", { method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }) });
    return res.ok ? res.json() : null;
  }

  // The toast is the fast path back from a misclick; the "Not players" list
  // below is the slow one, and stays available forever.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 12000);
    return () => clearTimeout(t);
  }, [undo]);

  async function dismiss(r) {
    setRows(rs => rs.filter(x => x.id !== r.id));
    setGone(g => [r, ...g]);
    setUndo(r);
    if (splitting === r.id) { setSplitting(null); setSelected([]); }
    await patch(r.id, { dismissed: 1 });
  }

  async function restore(r) {
    setGone(g => g.filter(x => x.id !== r.id));
    setUndo(u => (u?.id === r.id ? null : u));
    const res = await patch(r.id, { dismissed: 0 });
    // the server knows how many touches actually came back (some may have been
    // re-attributed in review since), so take its count over the stored one
    const back = { ...r, play_count: res?.restored ?? r.play_count ?? 0 };
    setRows(rs => [...rs, back].sort((a, b) => (b.n_boxes || 0) - (a.n_boxes || 0)));
  }

  async function merge(srcId, dstId) {
    await patch(srcId, { merged_into: dstId });
    const src = byId(srcId);
    setRows(rs => rs.filter(r => r.id !== srcId).map(r =>
      r.id === dstId ? { ...r,
        play_count: r.play_count + (src?.play_count || 0),
        tracklets: [...r.tracklets, ...(src?.tracklets || [])] } : r));
    setMergeSrc(null);
  }

  async function reassign(target) {
    const res = await fetch("/api/tracklets", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: +gameId, tracklet_ids: selected, target }) });
    const { identity } = await res.json();
    const moved = rows.find(r => r.id === splitting)?.tracklets
      .filter(t => selected.includes(t.id)) || [];
    setRows(rs => {
      let out = rs.map(r => r.id === splitting
        ? { ...r, tracklets: r.tracklets.filter(t => !selected.includes(t.id)) } : r);
      if (identity && !identity.dismissed) {
        const ex = out.find(r => r.id === identity.id);
        if (ex) out = out.map(r => r.id === identity.id
          ? { ...r, tracklets: [...r.tracklets, ...moved] } : r);
        else out = [...out, { ...identity, rep_crops: [], play_count: 0, tracklets: moved }];
      }
      return out;
    });
    // dismissed segments land in the same restorable list as a whole-card
    // dismissal (restoring one gives back a standalone identity, which can
    // then be merged with "Duplicate…")
    if (identity?.dismissed) {
      const row = { ...identity, rep_crops: [], play_count: 0, tracklets: moved };
      setGone(g => [row, ...g]);
      setUndo(row);
    }
    setSelected([]); setSplitting(null);
  }

  // link a per-game identity to a global player (the durable identity). We
  // also copy the display_name into identities.name so existing labels, the
  // merge picker, and legacy stats keep working.
  async function linkPlayer(identId, player) {
    setRows(rs => rs.map(x => x.id === identId
      ? { ...x, player_id: player.id, name: player.display_name } : x));
    await patch(identId, { player_id: player.id, name: player.display_name });
  }
  async function createAndLink(identId, name) {
    const nm = name.trim();
    if (!nm) return;
    const res = await fetch("/api/players", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: nm }) });
    const player = await res.json();
    setPlayers(ps => [...ps, { ...player, games: 0 }]);
    await linkPlayer(identId, player);
  }

  async function setClean(id, val) {
    setRows(rs => rs.map(x => x.id === id ? { ...x, clean: val } : x));
    patch(id, { clean: val ? 1 : 0 });
  }

  async function setTeam(id, val) {
    setRows(rs => rs.map(x => x.id === id ? { ...x, team: val } : x));
    patch(id, { team: val });
  }
  async function applyTeamSuggestions() {
    for (const r of rows)
      if (!r.team && teamSuggest[r.id]) setTeam(r.id, teamSuggest[r.id].team);
  }
  const nSuggestable = rows.filter(r => !r.team && teamSuggest[r.id]).length;

  // Finished players collapse out of the working lists entirely — the two
  // counts below are then "what's left to do", which is the number that matters.
  const done = rows.filter(r => r.clean);
  const active = rows.filter(r => !r.clean && r.play_count > 0);
  const inactive = rows.filter(r => !r.clean && r.play_count === 0);
  const mergeRow = byId(mergeSrc);

  const ctx = { rows, players, splitting, selected, expanded, nameSuggestions,
    teamSuggest, setSelected, setSplitting, setExpanded, setMergeSrc, setClean,
    setTeam, reassign, linkPlayer, createAndLink, dismiss };

  return (
    <Grid.Provider value={ctx}>
      {nSuggestable > 0 && (
        <div className="card row" style={{ borderColor: "#2456c4" }}>
          <span>Team sides guessed from where each player's touches happen
            (A = left of net, B = right).</span>
          <button className="primary" onClick={applyTeamSuggestions}>
            Assign {nSuggestable} player{nSuggestable === 1 ? "" : "s"} to suggested teams
          </button>
        </div>
      )}
      {mergeRow && (
        <div className="modal-overlay" onClick={() => setMergeSrc(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>
                <img src={thumb(mergeRow)} alt="" style={{ height: 42, borderRadius: 6, verticalAlign: "middle", marginRight: 8 }} />
                {label(mergeRow)} is the same person as…
              </h2>
              <button onClick={() => setMergeSrc(null)}>✕</button>
            </div>
            <div className="modal-list">
              {/* only named identities: fragments always merge INTO a real person */}
              {rows.filter(r => r.id !== mergeSrc && r.name)
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
                .map(r => (
                <button key={r.id} className="modal-item" onClick={() => merge(mergeSrc, r.id)}>
                  {thumb(r) && <img src={thumb(r)} alt="" />}
                  <span>{label(r)}</span>
                  <span className="muted">{r.play_count} touches</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {courtOpen && courtVideo && (() => {
        // paused frame at a serve: everyone is on court, in position
        const t = (rallyStarts[shot] ?? 0) + 1;
        return (
          <div className="modal-overlay" onClick={() => setCourtOpen(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}>Court at rally {shot + 1} of {rallyStarts.length}</h2>
                <span className="row">
                  <button disabled={shot <= 0} onClick={() => setShot(s => s - 1)}>◀ prev rally</button>
                  <button disabled={shot >= rallyStarts.length - 1}
                    onClick={() => setShot(s => s + 1)}>next rally ▶</button>
                  <button onClick={() => setCourtOpen(false)}>✕</button>
                </span>
              </div>
              {/* keyed remount = seek to the new frame; no controls = a still */}
              <video key={t} src={`${courtVideo}#t=${t}`} preload="auto" muted
                style={{ maxWidth: "100%", marginTop: 10 }} />
              <p className="muted" style={{ marginBottom: 0 }}>
                A frame from each rally's serve — step through a few to see who's on which side.
              </p>
            </div>
          </div>
        );
      })()}
      {/* Finished work, parked: a name and a way back in, nothing more. Twelve
          of these are two rows, not two screens. */}
      {done.length > 0 && (
        <>
          <h2>Done ({done.length})</h2>
          <div className="done-grid">
            {done.map(r => (
              <div className="done-chip" key={r.id}
                title={(r.team ? `team ${r.team} · ` : "") +
                  (r.play_count > 0 ? `${r.play_count} touches` : "no touches")}>
                <b>{label(r)}</b>
                <button className="mini" onClick={() => setClean(r.id, 0)}>reopen</button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Involved in scored touches ({active.length})</h2>
        {courtVideo && rallyStarts.length > 0 && (
          <button onClick={() => setCourtOpen(true)}
            title="Show a still of the court so you can see who's on which team">
            📷 Court view</button>
        )}
      </div>
      {active.map(r => <Card r={r} key={r.id} />)}
      {inactive.length > 0 && (
        <details style={{ marginTop: 18 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            Never touch the ball ({inactive.length}) — naming optional
          </summary>
          {inactive.map(r => <Card r={r} key={r.id} />)}
        </details>
      )}
      {gone.length > 0 && (
        <details style={{ marginTop: 18 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            Not players ({gone.length}) — restore any of these
          </summary>
          {gone.map(r => (
            <div className="card clean-row" key={r.id}>
              {thumb(r) && <img src={thumb(r)} alt="" />}
              <b>{label(r)}</b>
              <span className="muted">
                {nCrops(r)} image{nCrops(r) === 1 ? "" : "s"}
                {r.play_count > 0 && ` · ${r.play_count} touches to restore`}
              </span>
              <span style={{ flex: 1 }} />
              <button onClick={() => restore(r)}>Restore</button>
            </div>
          ))}
        </details>
      )}
      {undo && (
        <div className="toast">
          {thumb(undo) && <img src={thumb(undo)} alt=""
            style={{ height: 34, borderRadius: 5 }} />}
          <span>Marked <b>{label(undo)}</b> as not a player.</span>
          <button className="primary" onClick={() => restore(undo)}>Undo</button>
          <button onClick={() => setUndo(null)} title="dismiss">✕</button>
        </div>
      )}
    </Grid.Provider>
  );
}

// typeahead over the roster: pick an existing player or create a new one.
function PlayerCombo({ r }) {
  const { players, linkPlayer, createAndLink } = useContext(Grid);
  const [q, setQ] = useState(r.name || "");
  const [open, setOpen] = useState(false);
  const linked = r.player_id != null;
  const query = q.trim();
  const ql = query.toLowerCase();
  const matches = query
    ? players.filter(p => p.display_name.toLowerCase().includes(ql)) : players;
  const exact = players.find(p => p.display_name.toLowerCase() === ql);
  return (
    <span className="combo">
      <input type="text" placeholder="Player name" value={q}
        className={linked ? "linked" : ""}
        title={linked ? "linked to a player — stats aggregate across games"
          : "not linked to a player yet"}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {linked && <span className="link-dot" title="linked">✓</span>}
      {open && (
        <div className="combo-menu">
          {matches.slice(0, 8).map(p => (
            <button key={p.id} className="combo-item" type="button"
              onMouseDown={() => { linkPlayer(r.id, p); setQ(p.display_name); setOpen(false); }}>
              <span>{p.display_name}</span>
              <span className="muted">{p.games} game{p.games === 1 ? "" : "s"}</span>
            </button>
          ))}
          {query && !exact && (
            <button className="combo-item combo-new" type="button"
              onMouseDown={() => { createAndLink(r.id, query); setOpen(false); }}>
              + Create “{query}”
            </button>
          )}
          {!matches.length && !query &&
            <div className="combo-item muted">No players yet — type a name</div>}
        </div>
      )}
    </span>
  );
}

// A/B toggle with the position-based suggestion highlighted (dashed)
function TeamToggle({ r }) {
  const { teamSuggest, setTeam } = useContext(Grid);
  const sug = teamSuggest[r.id];
  return (
    <span className="teamtoggle"
      title={sug ? `position suggests team ${sug.team} (${sug.conf}% of touches on that side)`
        : "assign a team so stats can tell overpasses from assists"}>
      {["A", "B"].map(t => (
        <button key={t}
          className={"teambtn" + (r.team === t ? " on" : "") +
            (!r.team && sug?.team === t ? " sug" : "")}
          onClick={() => setTeam(r.id, r.team === t ? null : t)}>
          {t}{!r.team && sug?.team === t ? "?" : ""}
        </button>
      ))}
    </span>
  );
}

function Card({ r }) {
  const { rows, splitting, selected, expanded, nameSuggestions, setSelected,
    setSplitting, setExpanded, setMergeSrc, setClean, reassign, linkPlayer,
    createAndLink, dismiss } = useContext(Grid);
  const inSplit = splitting === r.id;
  const isOpen = inSplit || expanded[r.id];
  const stacks = r.tracklets.length ? r.tracklets
    : r.rep_crops.map((src, i) => ({ id: `rep${i}`, crops: [src], rep: true }));
  const shown = isOpen ? stacks : stacks.slice(0, 1);
  return (
    <div className="card" style={inSplit ? { borderColor: "#c4762e" } : undefined}>
      <div className="row">
        <div className="crops" style={{ flex: 1 }}>
          {shown.map(t => (
            <div key={t.id} className="tstack"
              onClick={() => {
                if (!inSplit || t.rep) return;
                setSelected(s => s.includes(t.id)
                  ? s.filter(x => x !== t.id) : [...s, t.id]);
              }}
              style={{
                cursor: inSplit && !t.rep ? "pointer" : "default",
                outline: selected.includes(t.id) ? "3px solid #c4762e" : "none",
                borderRadius: 6,
              }}>
              <img src={t.crops[0]} alt="" />
              {t.crops.length > 1 && <span className="muted tcount">×{t.crops.length}</span>}
            </div>
          ))}
          {!isOpen && stacks.length > 1 && (
            <button onClick={() => setExpanded(e => ({ ...e, [r.id]: true }))}>
              +{stacks.length - 1} segments
            </button>
          )}
        </div>
        <div className="muted" style={{ whiteSpace: "nowrap" }}>
          {r.play_count > 0 ? `${r.play_count} touches` : "no touches"}
        </div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        {inSplit ? (
          <>
            <span className="muted">{selected.length} selected →</span>
            <button className="primary" disabled={!selected.length}
              onClick={() => reassign("new")}>New player</button>
            <select disabled={!selected.length} defaultValue=""
              onChange={e => e.target.value && reassign(+e.target.value)}>
              <option value="" disabled>Move to…</option>
              {rows.filter(x => x.id !== r.id).map(x => (
                <option key={x.id} value={x.id}>{label(x)}</option>
              ))}
            </select>
            <button className="danger" disabled={!selected.length}
              onClick={() => reassign("dismiss")}>Not a player</button>
            <button onClick={() => { setSplitting(null); setSelected([]); }}>done</button>
          </>
        ) : (
          <>
            <PlayerCombo r={r} />
            {!r.player_id && nameSuggestions[r.id] && (
              <button className="primary" onClick={() => {
                const s = nameSuggestions[r.id];
                if (s.player_id)
                  linkPlayer(r.id, { id: s.player_id, display_name: s.name });
                else createAndLink(r.id, s.name);
              }}>
                {nameSuggestions[r.id].name}? ({nameSuggestions[r.id].sim}%)
              </button>
            )}
            <TeamToggle r={r} />
            <button className="primary" onClick={() => setClean(r.id, 1)}>Done ✓</button>
            <button onClick={() => { setMergeSrc(r.id); setSplitting(null); }}>Duplicate…</button>
            {r.tracklets.length > 1 &&
              <button onClick={() => { setSplitting(r.id); setSelected([]);
                setExpanded(e => ({ ...e, [r.id]: true })); setMergeSrc(null); }}>
                Split…</button>}
            <button className="danger" onClick={() => dismiss(r)}
              title="hides this identity — undo from the toast or the “Not players” list below">
              Not a player</button>
          </>
        )}
      </div>
    </div>
  );
}
