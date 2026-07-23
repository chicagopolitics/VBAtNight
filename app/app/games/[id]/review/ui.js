"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveGrades, teamMap, GRADE_OPTIONS, GOOD, BAD } from "@/lib/grades";

const TYPES = ["serve", "receive", "dig", "set", "attack", "block"];

export default function Review({ rallies, idents, plays, video }) {
  const [sel, setSel] = useState(rallies[0]?.id);
  const [allPlays, setAllPlays] = useState(plays);
  const [editing, setEditing] = useState(null);
  const [now, setNow] = useState(-1);
  const vid = useRef(null);

  const [rallyState, setRallyState] = useState(rallies);
  const [videoDur, setVideoDur] = useState(0);   // full recording length (from metadata)
  const [mediaDur, setMediaDur] = useState(0);   // duration of the current media file
  const [playing, setPlaying] = useState(false);
  const [full, setFull] = useState(false);       // scrubber: rally window vs whole file
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
    () => allPlays.filter(p => p.rally_id === sel).sort((a,b) => a.t - b.t),
    [allPlays, sel]);
  // per-touch quality, derived from touch order + rally outcome (lib/grades);
  // team-aware if teams were assigned in the name-players step (catches
  // overpasses); a manual override (p.grade) wins — recomputes live
  const teams = useMemo(() => teamMap(idents), [idents]);
  const grades = useMemo(
    () => rally ? deriveGrades(rallyPlays, rally, teams) : new Map(),
    [rallyPlays, rally, teams]);
  // named players alphabetically, then unnamed P-clusters by number
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
    setAllPlays(ps => ps.filter(p => p.id !== id));
    await fetch("/api/plays", { method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, deleted: 1 }) });
    setEditing(null);
  }
  async function removeAll() {
    if (!confirm(`Delete all ${rallyPlays.length} touches in this rally?`)) return;
    const ids = rallyPlays.map(p => p.id);
    setAllPlays(ps => ps.filter(p => p.rally_id !== sel));
    setEditing(null);
    for (const id of ids)
      await fetch("/api/plays", { method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, deleted: 1 }) });
  }
  // delete every touch in this rally after touch p — the usual junk is a
  // suffix of spurious contacts detected after the point actually ended
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
  // game time where this rally's media begins: 0 for the full-game video
  // (video time == game time), else the clip's start (2s lead-in default)
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
    setEditing(id);
  }
  function seekTo(p) {
    if (vid.current && rally) vid.current.currentTime = Math.max(0, p.t - clipStart(rally) - 1);
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
    setEditing(null);
  }

  const selIdx = visible.findIndex(r => r.id === sel);
  function go(d) {
    const j = selIdx + d;
    if (j >= 0 && j < visible.length) { setSel(visible[j].id); setEditing(null); }
  }
  useEffect(() => { setFull(false); }, [sel]);   // new rally -> back to window scrubber
  useEffect(() => {
    const h = e => {
      if (["INPUT", "SELECT", "TEXTAREA", "VIDEO"].includes(e.target.tagName)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      if ((e.key === "a" || e.key === "A") && rally && rally.phase !== "skipped") {
        e.preventDefault(); addPlay();   // hotkey: add touch at playhead
      }
      if ((e.key === "d" || e.key === "D") && editing) {
        e.preventDefault(); remove(editing);   // hotkey: delete the open touch
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
        // x-axis = the entire recording; rallies sit at their true position,
        // so gaps show exactly where nothing was detected
        const lastEnd = Math.max(0, ...rallyState.map(r => r.end_s));
        const total = (video && videoDur) ? videoDur : lastEnd;
        return (
          <div className="timeline"
            title={video ? "click a gap to seek the video there" : undefined}
            onClick={video ? e => {
              if (e.target !== e.currentTarget || !vid.current) return;
              const rect = e.currentTarget.getBoundingClientRect();
              vid.current.currentTime =
                (e.clientX - rect.left) / rect.width * total;   // video time == game time
              setFull(true);   // seeking a gap = leaving the rally window
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
                  onClick={() => { setSel(r.id); setEditing(null); }} />
              );
            })}
            {/* "you are here" playhead in absolute recording time */}
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
          <span style={{ marginLeft: 14, fontSize: 11 }}>
            <span className="tl-key done" /> outcome set
            <span className="tl-key empty" style={{ marginLeft: 8 }} /> no touches
            &nbsp;· ←/→ rallies · A adds touch
          </span>
        </span>
        <span>
          {video && rally && (
            <button title="Detector missed a rally? Scrub to where it starts, then click — then use 'end at playhead' to set its end"
              onClick={async () => {
                const at = Math.round((clipStart(rally) + (vid.current?.currentTime ?? 0)) * 10) / 10;
                const res = await fetch("/api/rallies", { method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ game_id: rally.game_id, start_s: at, end_s: at + 12 }) });
                const j = await res.json();
                if (!res.ok) { alert(j.error || "failed"); return; }
                setRallyState(rs => [...rs, j.rally].sort((a, b) => a.start_s - b.start_s));
                setSel(j.rally.id); setEditing(null);
              }}>+ rally at playhead</button>
          )}{" "}
          <button onClick={() => go(1)} disabled={selIdx >= visible.length - 1}>next ▶</button>
        </span>
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
              // custom controls: native ones always show the full file's
              // duration, but the scrubber should span just the rally window
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
                      e.target.pause();   // stop at the rally's (possibly edited) end
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
                  <button title="back 5s" onClick={() => {
                    if (vid.current) vid.current.currentTime =
                      Math.max(full ? 0 : t0, vid.current.currentTime - 5);
                  }}>-5s</button>
                  <button title="forward 5s" onClick={() => {
                    if (vid.current) vid.current.currentTime =
                      Math.min(hi, vid.current.currentTime + 5);
                  }}>+5s</button>
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
                Touches{rallyPlays.length > 0 ? ` (${rallyPlays.length})` : ""}{" "}
                <span className="muted" style={{ fontWeight: 400, cursor: "help" }}
                  title={"Chip border colors:\ngreen — corrected by you\namber — attribution was a stretch, double-check\nred dashed — no player assigned"}>ⓘ</span>
              </h2>
              <span>
                <button title="Add a touch at the current playhead (hotkey: A)"
                  onClick={addPlay}>+ add</button>{" "}
                {rallyPlays.length > 0 && (
                  <button className="danger" title="Delete every touch in this rally (to re-create them from scratch)"
                    onClick={removeAll}>🗑 all</button>
                )}
              </span>
            </div>
            {rallyPlays.map(p => {
              const abs = clipStart(rally) + now;
              const live = now >= 0 && abs >= p.t - 0.1 && abs < p.t + 1.0;
              // match the scrubber: window-relative in rally mode, absolute in full mode
              const chipT = p.t - clipStart(rally) -
                (full ? 0 : Math.max(0, rally.start_s - clipStart(rally) - 2));
              if (editing === p.id) return (
                // the chip itself becomes the editor — no detached menu
                // (keeps the playhead-sync pulse so you can see the touch land
                // while its editor is open)
                <div key={p.id} className={"chip-edit" + (live ? " live" : "")}
                  onKeyDown={e => {   // Enter/Esc closes the editor, freeing the A hotkey
                    if (e.key === "Enter" || e.key === "Escape") { e.target.blur(); setEditing(null); }
                    // D deletes the touch even while focus is in a dropdown
                    // (costs select type-ahead for "d" — deleting wins)
                    if (e.key === "d" || e.key === "D") { e.preventDefault(); remove(p.id); }
                  }}>
                  <select autoFocus value={p.play_type || ""}
                    onChange={e => save(p.id, { play_type: e.target.value })}>
                    <option value="" disabled>type…</option>
                    {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={p.cluster_id ?? ""}
                    onChange={e => save(p.id, { cluster_id: e.target.value === "" ? null : +e.target.value })}>
                    <option value="">unknown player</option>
                    {sortedIdents.map(i => (
                      <option key={i.cluster_id} value={i.cluster_id}>
                        {i.name || `P${i.cluster_id}`}
                      </option>
                    ))}
                  </select>
                  <select title="Touch quality — auto-derived from touch order + rally outcome; pick a value only when the derivation is wrong. Decisive grades (kill / stuff / ace / final error) also fill in the rally outcome."
                    value={p.grade || ""}
                    onChange={e => {
                      const g = e.target.value || null;
                      save(p.id, { grade: g });
                      // decisive grades imply how the rally ended — fill in
                      // the outcome so it doesn't need a second annotation.
                      // kill/stuff/ace are rally-enders by definition; "error"
                      // only when this is the last touch (a mid-rally error
                      // is an overpass, not the point)
                      const isLast = rallyPlays[rallyPlays.length - 1]?.id === p.id;
                      const ot =
                        g === "kill" && p.play_type === "attack" ? "kill" :
                        g === "stuff" && p.play_type === "block" ? "block" :
                        g === "ace" && p.play_type === "serve" ? "ace" :
                        g === "error" && p.play_type === "serve" && isLast ? "service_error" :
                        g === "error" && p.play_type === "attack" && isLast ? "attack_error" :
                        null;
                      if (ot) {
                        saveRally(rally.id, { outcome_type: ot,
                          outcome_cluster: p.cluster_id ?? rally.outcome_cluster ?? null });
                        // the rally ended on this touch — anything after it is
                        // junk the detector picked up post-point; offer to clear
                        removeAfter(p);
                      }
                    }}>
                    <option value="">auto: {grades.get(p.id) || "?"}</option>
                    {(GRADE_OPTIONS[p.play_type] || []).map(g => (
                      <option key={g} value={g}>{g.replace("_", " ")}</option>
                    ))}
                  </select>
                  <span className="t">{chipT.toFixed(1)}s</span>
                  <button className="danger" title="hotkey: D"
                    onClick={() => remove(p.id)}>delete</button>
                  {rallyPlays.some(x => x.t > p.t) && (
                    <button className="danger" title="Delete every touch after this one in the rally"
                      onClick={() => removeAfter(p)}>🗑 after</button>
                  )}
                  <button onClick={() => setEditing(null)}>done</button>
                </div>
              );
              return (
              <div key={p.id}>
                <span className={"chip" + (p.corrected ? " corrected" : "") + (live ? " live" : "") +
                    (!p.corrected && p.cluster_id != null && p.dist_px >= 80 ? " lowconf" : "") +
                    (!p.corrected && p.cluster_id == null ? " noattr" : "")}
                  title={p.cluster_id == null ? "no player was near this contact — set one"
                    : p.dist_px != null ? `attributed from ${Math.round(p.dist_px)}px away` : undefined}
                  onClick={() => { seekTo(p); setEditing(p.id); }}>
                  <b>{p.play_type || "?"}</b> {nameOf(p.cluster_id)}
                  {(() => {   // quality badge: only notable grades, to keep chips quiet
                    const g = grades.get(p.id);
                    if (!g || g === "in_play") return null;
                    return <span className={"grade" + (GOOD.has(g) ? " good" : BAD.has(g) ? " bad" : g === "poor" ? " poor" : "")}
                      title={p.grade ? "grade set by you" : "grade derived from touch order + rally outcome"}>
                      {g.replace("_", " ")}{p.grade ? " ✎" : ""}</span>;
                  })()}
                  {/* scrubber time, so the number matches the video player */}
                  <span className="t">{chipT.toFixed(1)}s</span>
                </span>
              </div>
            );})}
            {rallyPlays.length === 0 && <p className="muted">No touches detected — add them from the video.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
