"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveGrades, teamMap, GRADE_OPTIONS, GOOD, BAD } from "@/lib/grades";

const TYPES = ["serve", "receive", "dig", "set", "attack", "block"];
// number-key -> type (1..6); shown in the row and the legend
const TYPE_KEY = Object.fromEntries(TYPES.map((t, i) => [String(i + 1), t]));

export default function Review({ rallies, idents, plays, video }) {
  const [sel, setSel] = useState(rallies[0]?.id);
  const [allPlays, setAllPlays] = useState(plays);
  const [focusedId, setFocusedId] = useState(null);   // keyboard-focused touch
  const [picker, setPicker] = useState(null);          // { filter, sel } or null
  const [now, setNow] = useState(-1);
  const vid = useRef(null);
  const pinput = useRef(null);

  const [rallyState, setRallyState] = useState(rallies);
  const [videoDur, setVideoDur] = useState(0);
  const [mediaDur, setMediaDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [full, setFull] = useState(false);
  const [muted, setMuted] = useState(false);
  const rally = rallyState.find(r => r.id === sel);
  const visible = rallyState.filter(r => r.phase !== "skipped");
  const skipped = rallyState.filter(r => r.phase === "skipped");

  async function saveRally(id, body) {
    setRallyState(rs => rs.map(r => r.id === id ? { ...r, ...body } : r));
    await fetch("/api/rallies", { method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }) });
  }
  const rallyPlays = useMemo(
    () => allPlays.filter(p => p.rally_id === sel).sort((a, b) => a.t - b.t),
    [allPlays, sel]);
  const teams = useMemo(() => teamMap(idents), [idents]);
  const grades = useMemo(
    () => rally ? deriveGrades(rallyPlays, rally, teams) : new Map(),
    [rallyPlays, rally, teams]);
  const sortedIdents = useMemo(() => [...idents].sort((a, b) =>
    a.name && b.name ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : a.name ? -1 : b.name ? 1 : a.cluster_id - b.cluster_id), [idents]);
  const nameOf = cid => {
    if (cid === null || cid === undefined) return "?";
    const i = idents.find(i => i.cluster_id === cid);
    return i?.name || `P${cid}`;
  };

  async function save(id, body) {
    setAllPlays(ps => ps.map(p => p.id === id ? { ...p, ...body, corrected: 1 } : p));
    await fetch("/api/plays", { method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }) });
  }
  async function remove(id) {
    const idx = rallyPlays.findIndex(p => p.id === id);
    setAllPlays(ps => ps.filter(p => p.id !== id));
    // keep focus on a neighbour so the keyboard flow continues
    const next = rallyPlays[idx + 1] || rallyPlays[idx - 1];
    setFocusedId(next ? next.id : null);
    await fetch("/api/plays", { method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, deleted: 1 }) });
  }
  async function removeAll() {
    if (!confirm(`Delete all ${rallyPlays.length} touches in this rally?`)) return;
    const ids = rallyPlays.map(p => p.id);
    setAllPlays(ps => ps.filter(p => p.rally_id !== sel));
    setFocusedId(null);
    for (const id of ids)
      await fetch("/api/plays", { method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, deleted: 1 }) });
  }
  async function removeAfter(p) {
    const after = rallyPlays.filter(x => x.t > p.t);
    if (!after.length) return;
    if (!confirm(`Delete ${after.length} touch${after.length > 1 ? "es" : ""} after this one?`)) return;
    const ids = after.map(x => x.id);
    setAllPlays(ps => ps.filter(x => !ids.includes(x.id)));
    for (const id of ids)
      await fetch("/api/plays", { method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, deleted: 1 }) });
  }

  const clipStart = r => r.clip_file ? (r.clip_start_s ?? r.start_s - 2) : 0;
  const mediaFor = r => {
    const base = r.clip_file || video;
    if (!base) return null;
    const t0 = Math.max(0, r.start_s - clipStart(r) - 2);
    return `${base}#t=${t0.toFixed(1)},${(r.end_s - clipStart(r) + 2).toFixed(1)}`;
  };

  async function addPlay() {
    const t = clipStart(rally) + (vid.current?.currentTime ?? 0);
    const res = await fetch("/api/plays", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rally_id: sel, t: Math.round(t * 10) / 10 }) });
    const { id } = await res.json();
    setAllPlays(ps => [...ps, { id, rally_id: sel, t, play_type: "attack",
      cluster_id: null, corrected: 1 }]);
    setFocusedId(id);
  }
  // seek to the EXACT frame of the touch (no lead-in) — the ±1s keys give
  // context on demand. Clicking a touch also focuses it for keyboard edits.
  function seekTo(p) {
    if (vid.current && rally) {
      if (full) setFull(false);
      vid.current.currentTime = Math.max(0, p.t - clipStart(rally));
      vid.current.pause();
    }
  }
  function nudge(dt) {
    const v = vid.current; if (!v) return;
    const t0 = Math.max(0, rally.start_s - clipStart(rally) - 2);
    const t1 = rally.end_s - clipStart(rally) + 2;
    const lo = full ? 0 : t0, hi = full ? (mediaDur || t1) : t1;
    v.currentTime = Math.max(lo, Math.min(hi, v.currentTime + dt));
    v.pause();
  }

  async function splitRally() {
    const at = clipStart(rally) + (vid.current?.currentTime ?? 0);
    const res = await fetch("/api/rallies/split", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rally.id, at: Math.round(at * 10) / 10 }) });
    const j = await res.json();
    if (!res.ok) { alert(j.error || "split failed"); return; }
    setRallyState(rs => rs.flatMap(r => r.id === rally.id ? [j.a, j.b] : [r]));
    setAllPlays(ps => ps.map(p =>
      p.rally_id === rally.id && p.t >= j.b.start_s ? { ...p, rally_id: j.b.id } : p));
  }

  const selIdx = visible.findIndex(r => r.id === sel);
  function go(d) {
    const j = selIdx + d;
    if (j >= 0 && j < visible.length) { setSel(visible[j].id); }
  }
  // when the rally changes: focus its first touch, reset scrubber to window
  useEffect(() => {
    setFull(false);
    setPicker(null);
    setFocusedId(rallyPlays[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // keyboard focus moves + edits (see legend). Enter = score + advance.
  const focusedIdx = rallyPlays.findIndex(p => p.id === focusedId);
  function moveFocus(d) {
    if (!rallyPlays.length) return;
    const j = Math.max(0, Math.min(rallyPlays.length - 1,
      (focusedIdx < 0 ? 0 : focusedIdx) + d));
    const p = rallyPlays[j];
    setFocusedId(p.id); seekTo(p);
  }
  // infer + set the rally outcome from the last touch, then advance
  function scoreAndNext() {
    if (rally && !rally.outcome_type && rallyPlays.length) {
      const last = rallyPlays[rallyPlays.length - 1];
      const g = grades.get(last.id);
      const ot =
        last.play_type === "serve" ? (g === "ace" ? "ace" : g === "error" ? "service_error" : null) :
        last.play_type === "attack" ? (g === "error" ? "attack_error" : g === "blocked" ? "block" : "kill") :
        last.play_type === "block" ? "block" : null;
      if (ot) saveRally(rally.id, { outcome_type: ot,
        outcome_cluster: last.cluster_id ?? rally.outcome_cluster ?? null });
    }
    go(1);
  }

  const pickList = useMemo(() => {
    if (!picker) return [];
    const f = picker.filter.toLowerCase();
    return sortedIdents.filter(i =>
      !f || (i.name || `P${i.cluster_id}`).toLowerCase().includes(f));
  }, [picker, sortedIdents]);

  useEffect(() => {
    const h = e => {
      // player picker owns the keyboard while open
      if (picker) {
        if (e.key === "Escape") { setPicker(null); e.preventDefault(); }
        else if (e.key === "Enter") {
          const pick = pickList[picker.sel];
          if (pick && focusedId != null) save(focusedId, { cluster_id: pick.cluster_id });
          setPicker(null); e.preventDefault();
        } else if (e.key === "ArrowDown") {
          setPicker(p => ({ ...p, sel: Math.min(p.sel + 1, pickList.length - 1) })); e.preventDefault();
        } else if (e.key === "ArrowUp") {
          setPicker(p => ({ ...p, sel: Math.max(p.sel - 1, 0) })); e.preventDefault();
        }
        return;
      }
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (!rally || rally.phase === "skipped") return;
      const f = rallyPlays[focusedIdx];
      switch (e.key) {
        case "ArrowUp": e.preventDefault(); moveFocus(-1); break;
        case "ArrowDown": e.preventDefault(); moveFocus(1); break;
        case "ArrowLeft": e.preventDefault(); nudge(-1); break;
        case "ArrowRight": e.preventDefault(); nudge(1); break;
        case "[": e.preventDefault(); go(-1); break;
        case "]": e.preventDefault(); go(1); break;
        case "Enter": e.preventDefault(); scoreAndNext(); break;
        case " ": {
          e.preventDefault();
          const v = vid.current; if (v) v.paused ? v.play() : v.pause();
          break;
        }
        case "a": case "A": e.preventDefault(); addPlay(); break;
        case "x": case "X": case "d": case "D":
          e.preventDefault(); if (f) remove(f.id); break;
        case "p": case "P":
          e.preventDefault(); if (f) { setPicker({ filter: "", sel: 0 });
            setTimeout(() => pinput.current?.focus(), 0); } break;
        default:
          if (TYPE_KEY[e.key] && f) { e.preventDefault(); save(f.id, { play_type: TYPE_KEY[e.key] }); }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const doneCount = visible.filter(r => r.outcome_type).length;

  return (
    <div>
      <h1>Play review</h1>
      {(() => {
        const lastEnd = Math.max(0, ...rallyState.map(r => r.end_s));
        const total = (video && videoDur) ? videoDur : lastEnd;
        return (
          <div className="timeline"
            title={video ? "click a gap to seek the video there" : undefined}
            onClick={video ? e => {
              if (e.target !== e.currentTarget || !vid.current) return;
              const rect = e.currentTarget.getBoundingClientRect();
              vid.current.currentTime =
                (e.clientX - rect.left) / rect.width * total;
              setFull(true);
            } : undefined}>
            {visible.map((r, i) => {
              const n = allPlays.filter(p => p.rally_id === r.id).length;
              return (
                <div key={r.id}
                  className={"tl-seg" + (r.id === sel ? " sel" : "") +
                    (r.outcome_type ? " done" : "") + (n === 0 ? " empty" : "")}
                  style={{ left: `${(r.start_s / total) * 100}%`,
                    width: `${Math.max(((r.end_s - r.start_s) / total) * 100, 0.55)}%` }}
                  title={`#${i + 1} · ${fmt(r.start_s)} · ${n} touch${n === 1 ? "" : "es"}` +
                    (r.outcome_type ? ` · ✓ ${r.outcome_type}` : "")}
                  onClick={() => setSel(r.id)} />
              );
            })}
            {now >= 0 && rally && total > 0 && (
              <div className="tl-playhead"
                style={{ left: `${Math.min(100, ((clipStart(rally) + now) / total) * 100)}%` }} />
            )}
          </div>
        );
      })()}
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <button onClick={() => go(-1)} disabled={selIdx <= 0}>◀ prev</button>
        <span className="muted">
          {rally && rally.phase !== "skipped" && <>
            <b style={{ color: "#2f333b" }}>Rally {selIdx + 1} of {visible.length}</b>
            {" · "}{fmt(rally.start_s)}
            {" · "}{rallyPlays.length} touch{rallyPlays.length === 1 ? "" : "es"}
          </>}
          {"  ·  "}✓ {doneCount}/{visible.length} scored
        </span>
        <span>
          {video && rally && (
            <button title="Detector missed a rally? Scrub to where it starts, then click"
              onClick={async () => {
                const at = Math.round((clipStart(rally) + (vid.current?.currentTime ?? 0)) * 10) / 10;
                const res = await fetch("/api/rallies", { method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ game_id: rally.game_id, start_s: at, end_s: at + 12 }) });
                const j = await res.json();
                if (!res.ok) { alert(j.error || "failed"); return; }
                setRallyState(rs => [...rs, j.rally].sort((a, b) => a.start_s - b.start_s));
                setSel(j.rally.id);
              }}>+ rally at playhead</button>
          )}{" "}
          <button onClick={() => go(1)} disabled={selIdx >= visible.length - 1}>next ▶</button>
        </span>
      </div>

      <div className="keyhint muted">
        <b>↑↓</b> touch · <b>1–6</b> type · <b>P</b> player · <b>←→</b> ±1s ·
        {" "}<b>A</b> add · <b>X</b> delete · <b>space</b> play · <b>[ ]</b> rally · <b>Enter</b> score + next
      </div>

      {skipped.length > 0 && (
        <details style={{ marginBottom: 10 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            {skipped.length} dismissed segment{skipped.length === 1 ? "" : "s"}
          </summary>
          <div className="row">
            {skipped.map(r => {
              const mm = Math.floor(r.start_s / 60), ss = String(Math.floor(r.start_s % 60)).padStart(2, "0");
              return (
                <button key={r.id} onClick={() => saveRally(r.id, { phase: "game" })}>
                  restore {mm}:{ss}
                </button>
              );
            })}
          </div>
        </details>
      )}

      {rally && rally.phase !== "skipped" && (
        <div className="playrow">
          <div>
            {mediaFor(rally) ? (() => {
              const t0 = Math.max(0, rally.start_s - clipStart(rally) - 2);
              const t1 = rally.end_s - clipStart(rally) + 2;
              const lo = full ? 0 : t0, hi = full ? (mediaDur || t1) : t1;
              return (<>
                <video ref={vid} preload="metadata" src={mediaFor(rally)} muted={muted}
                  onClick={e => e.target.paused ? e.target.play() : e.target.pause()}
                  onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                  onTimeUpdate={e => {
                    setNow(e.target.currentTime);
                    if (!full && e.target.currentTime >= t1 - 0.05 && !e.target.paused)
                      e.target.pause();
                  }}
                  onLoadedMetadata={e => {
                    setMediaDur(e.target.duration);
                    if (video) setVideoDur(e.target.duration);
                  }} />
                <div className="vidbar">
                  <button onClick={() => {
                    const v = vid.current; if (!v) return;
                    if (v.paused) { if (v.currentTime >= hi - 0.1) v.currentTime = lo; v.play(); }
                    else v.pause();
                  }}>{playing ? "⏸" : "▶"}</button>
                  <button title="back 1s (←)" onClick={() => nudge(-1)}>-1s</button>
                  <button title="forward 1s (→)" onClick={() => nudge(1)}>+1s</button>
                  <button title={muted ? "unmute" : "mute"}
                    onClick={() => setMuted(m => !m)}>{muted ? "🔇" : "🔊"}</button>
                  <span className="t">
                    {(Math.max(0, Math.min(now, hi) - lo)).toFixed(1)}s / {(hi - lo).toFixed(1)}s
                  </span>
                  <input type="range" min={lo} max={hi} step={0.05}
                    value={Math.max(lo, Math.min(now, hi))}
                    onChange={e => { if (vid.current) vid.current.currentTime = +e.target.value; }} />
                  <button title={full ? "scrub only this rally's window"
                      : "scrub the entire video (to extend boundaries or find missed rallies)"}
                    onClick={() => setFull(f => !f)}>{full ? "⇱ rally" : "⛶ full"}</button>
                </div>
              </>);
            })() : <p className="muted">No video for this rally.</p>}
            <div className="row muted" style={{ gap: 8 }}>
              <span>Rally: {fmt(rally.start_s)} – {fmt(rally.end_s)}</span>
              <button title="Rally starts earlier or later than detected? Scrub to the real start, then click"
                onClick={() => {
                  const t = Math.round((clipStart(rally) + (vid.current?.currentTime ?? 0)) * 10) / 10;
                  if (t < rally.end_s - 1) saveRally(rally.id, { start_s: t });
                }}>⇤ start here</button>
              <button title="Rally cut off early or runs long? Scrub to the real end, then click"
                onClick={() => {
                  const t = Math.round((clipStart(rally) + (vid.current?.currentTime ?? 0)) * 10) / 10;
                  if (t > rally.start_s + 1) saveRally(rally.id, { end_s: t });
                }}>end here ⇥</button>
              <button title="Two rallies merged into one? Scrub to where the second one starts, then click"
                onClick={splitRally}>✂ split</button>
              <button className="danger" title="Timeout / stray movement / not volleyball"
                onClick={() => {
                  saveRally(rally.id, { phase: "skipped" });
                  const next = visible[selIdx + 1] || visible[selIdx - 1];
                  if (next) setSel(next.id);
                }}>not a rally</button>
            </div>
            <div className="card row">
              <span className="muted">Point ended by:</span>
              <select value={rally.outcome_type || ""}
                onChange={e => saveRally(rally.id, { outcome_type: e.target.value || null })}>
                <option value="">— not set —</option>
                <option value="kill">kill</option>
                <option value="attack_error">attack error</option>
                <option value="ace">ace</option>
                <option value="service_error">service error</option>
                <option value="block">block</option>
                <option value="other_error">other error</option>
              </select>
              <select value={rally.outcome_cluster ?? ""}
                onChange={e => saveRally(rally.id, { outcome_cluster: e.target.value === "" ? null : +e.target.value })}>
                <option value="">by player…</option>
                {sortedIdents.map(i => (
                  <option key={i.cluster_id} value={i.cluster_id}>
                    {i.name || `P${i.cluster_id}`}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: "4px 0" }}>
                Touches{rallyPlays.length > 0 ? ` (${rallyPlays.length})` : ""}
              </h2>
              <span>
                <button title="Add a touch at the current playhead (A)"
                  onClick={addPlay}>+ add</button>{" "}
                {rallyPlays.length > 0 && (
                  <button className="danger" title="Delete every touch in this rally"
                    onClick={removeAll}>🗑 all</button>
                )}
              </span>
            </div>

            <div className="touchlist">
              {rallyPlays.map(p => {
                const abs = clipStart(rally) + now;
                const live = now >= 0 && Math.abs(abs - p.t) <= 0.3;
                const foc = p.id === focusedId;
                const chipT = p.t - clipStart(rally) -
                  (full ? 0 : Math.max(0, rally.start_s - clipStart(rally) - 2));
                const g = grades.get(p.id);
                return (
                  <div key={p.id}
                    className={"touch" + (foc ? " foc" : "") + (live ? " live" : "") +
                      (p.corrected ? " corrected" : "") +
                      (!p.corrected && p.cluster_id == null ? " noattr" : "")}
                    onClick={() => { setFocusedId(p.id); seekTo(p); }}>
                    <b className="ty">{p.play_type || "?"}</b>
                    <span className="pl">{nameOf(p.cluster_id)}</span>
                    {g && g !== "in_play" && (
                      <span className={"grade" + (GOOD.has(g) ? " good" : BAD.has(g) ? " bad" : g === "poor" ? " poor" : "")}
                        title={p.grade ? "grade set by you" : "auto-derived"}>
                        {g.replace("_", " ")}{p.grade ? " ✎" : ""}</span>
                    )}
                    <span className="t">{chipT.toFixed(1)}s</span>
                    {foc && (
                      <span className="focctl">
                        <select title="quality grade" value={p.grade || ""}
                          onClick={e => e.stopPropagation()}
                          onChange={e => {
                            const gv = e.target.value || null;
                            save(p.id, { grade: gv });
                            const isLast = rallyPlays[rallyPlays.length - 1]?.id === p.id;
                            const ot =
                              gv === "kill" && p.play_type === "attack" ? "kill" :
                              gv === "stuff" && p.play_type === "block" ? "block" :
                              gv === "ace" && p.play_type === "serve" ? "ace" :
                              gv === "error" && p.play_type === "serve" && isLast ? "service_error" :
                              gv === "error" && p.play_type === "attack" && isLast ? "attack_error" :
                              null;
                            if (ot) { saveRally(rally.id, { outcome_type: ot,
                              outcome_cluster: p.cluster_id ?? rally.outcome_cluster ?? null });
                              removeAfter(p); }
                          }}>
                          <option value="">auto: {g || "?"}</option>
                          {(GRADE_OPTIONS[p.play_type] || []).map(gg => (
                            <option key={gg} value={gg}>{gg.replace("_", " ")}</option>
                          ))}
                        </select>
                        <button className="danger" title="delete (X)"
                          onClick={e => { e.stopPropagation(); remove(p.id); }}>✕</button>
                      </span>
                    )}
                  </div>
                );
              })}
              {rallyPlays.length === 0 && <p className="muted">No touches — press A to add one from the video.</p>}
            </div>

            {picker && (
              <div className="picker">
                <input ref={pinput} placeholder="type a name…" autoComplete="off"
                  value={picker.filter}
                  onChange={e => setPicker(p => ({ ...p, filter: e.target.value, sel: 0 }))}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      const pick = pickList[picker.sel];
                      if (pick && focusedId != null) save(focusedId, { cluster_id: pick.cluster_id });
                      setPicker(null); e.preventDefault();
                    } else if (e.key === "Escape") { setPicker(null); e.preventDefault(); }
                    else if (e.key === "ArrowDown") { setPicker(p => ({ ...p, sel: Math.min(p.sel + 1, pickList.length - 1) })); e.preventDefault(); }
                    else if (e.key === "ArrowUp") { setPicker(p => ({ ...p, sel: Math.max(p.sel - 1, 0) })); e.preventDefault(); }
                  }} />
                <div className="picklist">
                  <div className={"pick" + (picker.sel === -1 ? " sel" : "")}
                    onClick={() => { if (focusedId != null) save(focusedId, { cluster_id: null }); setPicker(null); }}>
                    unknown player
                  </div>
                  {pickList.map((i, k) => (
                    <div key={i.cluster_id} className={"pick" + (k === picker.sel ? " sel" : "")}
                      onClick={() => { if (focusedId != null) save(focusedId, { cluster_id: i.cluster_id }); setPicker(null); }}>
                      {i.name || `P${i.cluster_id}`}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
