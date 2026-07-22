"use client";
import { useRef, useState } from "react";

const STEPS = [
  { key: "playing_area", color: "#4c9aff", poly: true, min: 4,
    label: "1/5 · Playing area: click around ALL floor players can stand on (generous, 4+ points), then Next." },
  { key: "court_corners", color: "#7ce38b", poly: true, exact: 4,
    label: "2/5 · Court corners: click the 4 corners of the painted court IN ORDER — near-left, near-right, far-right, far-left." },
  { key: "net_base", color: "#ffcf4c", exact: 2,
    label: "3/5 · Net post BASES: click where the LEFT post meets the floor, then the RIGHT." },
  { key: "net_top", color: "#ff9d4c", exact: 2, optional: true,
    label: "4/5 · Net TOP corners: click the top of the net at the LEFT post, then the RIGHT (skip if hard to see)." },
  { key: "attack_lines", color: "#d67cff", exact: 4, optional: true,
    label: "5/5 · Attack (3m) lines: click where each 3m line meets each sideline — near court left, near court right, far court left, far court right (skip if unclear)." },
];
const EMPTY = Object.fromEntries(STEPS.map(s => [s.key, []]));

export default function Setup() {
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  const [step, setStep] = useState(0);
  const [pts, setPts] = useState(EMPTY);
  const [results, setResults] = useState({});
  const [prev, setPrev] = useState(null);
  const [dur, setDur] = useState(0);
  const [t, setT] = useState(0);
  const mediaRef = useRef(null);

  function onFiles(e) {
    setQueue([...e.target.files].map(f => ({ name: f.name, url: URL.createObjectURL(f),
                                             isVideo: f.type.startsWith("video") })));
    setIdx(0); setStep(0); setPts(EMPTY); setResults({});
  }

  const cur = queue[idx];
  const allDone = idx >= queue.length && queue.length > 0;
  const S = STEPS[step];

  function advanceIfComplete(nextPts) {
    if (S.exact && nextPts[S.key].length >= S.exact) setStep(s => s + 1);
  }

  function click(e) {
    if (!cur || !S) return;
    const r = mediaRef.current.getBoundingClientRect();
    const x = +((e.clientX - r.left) / r.width).toFixed(4);
    const y = +((e.clientY - r.top) / r.height).toFixed(4);
    setPts(p => {
      const np = { ...p, [S.key]: [...p[S.key], [x, y]] };
      advanceIfComplete(np);
      return np;
    });
  }

  function confirm(geometry) {
    const g = geometry || Object.fromEntries(
      Object.entries(pts).filter(([, v]) => v.length));
    setResults(rs => ({ ...rs, [cur.name.replace(/\.[^.]+$/, "")]: g }));
    setPrev(g);
    setIdx(i => i + 1); setStep(0); setPts(EMPTY);
  }

  function download() {
    const blob = new Blob([JSON.stringify(
      { version: 2, per_video: results, _default: prev }, null, 1)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "courts_config.json";
    a.click();
  }

  const videoDone = step >= STEPS.length;
  return (
    <div>
      <h1>Camera setup — per-recording court calibration</h1>
      <p className="muted">
        Select the night's videos (read locally, nothing uploads). For each: pause on
        a clear frame, then follow the prompts. <b>Same as previous</b> reuses the last
        video's geometry when the tripod hasn't moved. Save the downloaded{" "}
        <code>courts_config.json</code> into Drive/balltime with the videos.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="file" accept="video/*,image/*" multiple onChange={onFiles} />
      </div>
      {cur && (
        <div>
          <div className="row" style={{ marginBottom: 8 }}>
            <b>{idx + 1}/{queue.length}: {cur.name}</b>
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            {!videoDone && <span style={{ color: S.color }}>{S.label}</span>}
            <button onClick={() => setPts(p => {
              const k = STEPS[Math.min(step, STEPS.length - 1)].key;
              return { ...p, [k]: p[k].slice(0, -1) };
            })}>undo</button>
            {!videoDone && S.poly && !S.exact && pts[S.key].length >= (S.min || 1) &&
              <button className="primary" onClick={() => setStep(s => s + 1)}>Next</button>}
            {!videoDone && S.optional &&
              <button onClick={() => setStep(s => s + 1)}>skip this step</button>}
            {videoDone &&
              <button className="primary" onClick={() => confirm()}>Confirm → next video</button>}
            {prev && <button onClick={() => confirm(prev)}>Same as previous</button>}
          </div>
          <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
            {cur.isVideo
              ? <video ref={mediaRef} src={cur.url} onClick={click} muted
                  preload="metadata"
                  onLoadedMetadata={e => { setDur(e.target.duration || 0); setT(0); }}
                  style={{ maxWidth: "100%", cursor: videoDone ? "default" : "crosshair", borderRadius: 8 }} />
              : <img ref={mediaRef} src={cur.url} alt="" onClick={click}
                  style={{ maxWidth: "100%", cursor: videoDone ? "default" : "crosshair", borderRadius: 8 }} />}
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                          pointerEvents: "none" }} viewBox="0 0 1 1" preserveAspectRatio="none">
              {STEPS.map(st => {
                const P = pts[st.key];
                if (!P.length) return null;
                return (
                  <g key={st.key}>
                    {st.poly && P.length > 1 &&
                      <polygon points={P.map(p => p.join(",")).join(" ")}
                        fill={st.key === "playing_area" ? "rgba(76,154,255,.15)" : "none"}
                        stroke={st.color} strokeWidth="0.0025" />}
                    {!st.poly && P.length === 2 &&
                      <line x1={P[0][0]} y1={P[0][1]} x2={P[1][0]} y2={P[1][1]}
                        stroke={st.color} strokeWidth="0.003" />}
                    {st.key === "attack_lines" && P.length >= 2 &&
                      <line x1={P[0][0]} y1={P[0][1]} x2={P[1][0]} y2={P[1][1]}
                        stroke={st.color} strokeWidth="0.0025" />}
                    {st.key === "attack_lines" && P.length === 4 &&
                      <line x1={P[2][0]} y1={P[2][1]} x2={P[3][0]} y2={P[3][1]}
                        stroke={st.color} strokeWidth="0.0025" />}
                    {P.map((p, i) =>
                      <circle key={i} cx={p[0]} cy={p[1]} r="0.005" fill={st.color} />)}
                  </g>
                );
              })}
            </svg>
          </div>
          {cur.isVideo && (
            <div className="row" style={{ marginTop: 6 }}>
              <input type="range" min="0" max={dur || 0} step="0.5" value={t}
                style={{ flex: 1 }}
                onChange={e => {
                  const v = +e.target.value;
                  setT(v);
                  if (mediaRef.current) mediaRef.current.currentTime = v;
                }} />
              <span className="muted" style={{ whiteSpace: "nowrap" }}>
                {Math.floor(t / 60)}:{String(Math.floor(t % 60)).padStart(2, "0")}
                {" / "}
                {Math.floor(dur / 60)}:{String(Math.floor(dur % 60)).padStart(2, "0")}
              </span>
            </div>
          )}
          <p className="muted">Scrub with the slider (controls are outside the frame so
            every pixel is clickable). Colors: blue = playing area · green = court corners ·
            yellow = net floor line · orange = net top · purple = 3m lines.</p>
        </div>
      )}
      {allDone && (
        <div className="card">
          <p>Calibrated {Object.keys(results).length} recording{Object.keys(results).length === 1 ? "" : "s"}.</p>
          <button className="primary" onClick={download}>Download courts_config.json</button>
          <p className="muted">Put it in Drive/balltime next to the videos, then run the notebook.</p>
        </div>
      )}
    </div>
  );
}
