"use client";
import { useState } from "react";

// Every fetch on this page goes through here.
//
// `await res.json()` on its own is a trap: when a route handler throws, Next
// answers with a 500 and an EMPTY body, and the browser surfaces that as
// "Failed to execute 'json' on 'Response': Unexpected end of JSON input" —
// a message about the parser, not about the thing that broke. Read the body
// as text first so a bodyless or HTML error (a proxy timeout, a 502) reports
// as what it is.
export async function callJson(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let j = null;
  if (text) { try { j = JSON.parse(text); } catch { /* not JSON */ } }
  if (!res.ok) {
    throw new Error(j?.error
      || (text ? `HTTP ${res.status}: ${text.slice(0, 200)}`
               : `HTTP ${res.status} ${res.statusText || ""} — the server sent an ` +
                 `empty response. Check the server log for the real error.`));
  }
  if (j === null) throw new Error("the server sent a response that wasn't JSON");
  return j;
}

export function DeleteGame({ id, name }) {
  return (
    <button className="danger" onClick={async () => {
      if (!confirm(`Delete "${name}" and all its data? This cannot be undone.`)) return;
      await fetch("/api/games", { method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }) });
      window.location.reload();
    }}>Delete</button>
  );
}

// The date line under a game's name, and the only place a name is editable.
//
// A game with no date is not a cosmetic problem — it has no slot, so it can't
// be ordered within its night and its YouTube title would be a fallback. So
// an undated game shows an open date field rather than a quiet "unknown":
// the prompt is the point. See NAMING-PLAN.md.
export function GameDate({ id, playedOn, label, needsDate }) {
  const [date, setDate] = useState(playedOn || "");
  const [lab, setLab] = useState(label || "");
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(null);

  async function save(patch) {
    setStatus("…");
    try { await callJson("/api/games", "PATCH", { id, ...patch }); }
    catch (e) { setStatus("✗ " + e.message); return; }
    // The date drives slot numbering for every game that night, so a save
    // can rename siblings too — reload rather than patch one row's state.
    window.location.reload();
  }

  if (needsDate || editing) {
    return (
      <div className="row" style={{ gap: 6, marginTop: 4 }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ fontSize: 12 }} />
        <input placeholder="optional name override" value={lab}
          onChange={e => setLab(e.target.value)}
          title='Wins over the derived name. Use for the rare game that has a real name — "Championship final".'
          style={{ fontSize: 12, width: 190 }} />
        <button style={{ fontSize: 12 }} disabled={!date}
          onClick={() => save({ played_on: date, label: lab })}>Save</button>
        {!needsDate && (
          <button style={{ fontSize: 12 }} onClick={() => setEditing(false)}>
            Cancel</button>
        )}
        <span className="muted" style={{ fontSize: 12 }}>
          {status || (needsDate ? "← this bundle carried no recording date" : "")}
        </span>
      </div>
    );
  }
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
      {playedOn}
      {label ? " · named manually" : ""}
      {" · "}
      <a href="#" onClick={e => { e.preventDefault(); setEditing(true); }}>edit</a>
    </div>
  );
}

export function ExportButton({ id, driveReady = false }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);

  async function run(dest) {
    setOpen(false);
    setStatus("…");
    try {
      const res = await fetch(`/api/export/${id}${dest ? `?dest=${dest}` : ""}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "failed");
      setStatus((dest === "drive"
        ? `✓ ${j.file} → Drive${j.updated ? " (updated)" : ""}`
        : `✓ ${j.file}`));
    } catch (e) { setStatus("✗ " + e.message); }
  }

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button title="Export the reviewed transcript (training data)"
        onClick={() => setOpen(o => !o)}>
        {status || "Export corrections ▾"}
      </button>
      {open && (
        <>
          {/* click-away catcher */}
          <span onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div className="card" style={{ position: "absolute", right: 0, top: "100%",
            marginTop: 4, zIndex: 41, padding: 6, minWidth: 190, display: "flex",
            flexDirection: "column", gap: 4 }}>
            <button style={{ textAlign: "left" }} onClick={() => run(null)}>
              To project folder</button>
            <button style={{ textAlign: "left" }} disabled={!driveReady}
              title={driveReady ? "Upload straight to your Drive/VBAtNight folder"
                : "Needs user OAuth — run npm run drive-auth (see DRIVE-SETUP.md)"}
              onClick={() => run("drive")}>
              To Google Drive{driveReady ? "" : " (needs OAuth)"}</button>
            <a href={`/api/export/${id}?download=1`}
              onClick={() => setOpen(false)}>
              <button style={{ textAlign: "left", width: "100%" }}>Download file</button>
            </a>
          </div>
        </>
      )}
    </span>
  );
}

// YouTube state for one game. Three states, and the button reflects which
// one you're in rather than offering every action all the time:
//
//   local    → "YouTube ▾"     (link a manual upload, or push via the API)
//   both     → "YouTube ✓"     (view it, or reclaim the local GBs)
//   youtube  → "YouTube ✓ ⤓"   (archived — local file is gone)
//
// The manual-link path is first and always enabled: it needs no API audit,
// so it works today regardless of how the upload probe went. See
// YOUTUBE-PLAN.md.
export function YouTubeCell({ id, videoId, mediaState, canUpload }) {
  const [vid, setVid] = useState(videoId || null);
  const [state, setState] = useState(mediaState || "local");
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);

  async function call(method, body) {
    setOpen(false);
    setStatus("…");
    try {
      return await callJson("/api/youtube", method, { id, ...body });
    } catch (e) {
      setStatus("✗ " + e.message);
      // A reclaim can fail after the file is already gone; the details matter
      // too much to leave in a truncated button label.
      if (method === "DELETE") alert(e.message);
      return null;
    }
  }

  async function link() {
    const v = prompt("Paste the YouTube link (or just the video id):");
    if (!v) return;
    const j = await call("PATCH", { video: v });
    if (j) { setVid(j.video_id); setState("both"); setStatus("✓ linked"); }
  }

  async function upload() {
    if (!confirm("Upload this game's video to your channel? " +
      "This can take a while for a multi-GB file.")) return;
    const j = await call("POST", {});
    if (j) {
      setVid(j.id); setState("both");
      setStatus(j.warning ? "⚠ " + j.privacyStatus : "✓ uploaded");
      if (j.warning) alert(j.warning);
    }
  }

  async function reclaim() {
    if (!confirm("Delete the LOCAL video file? The game stays watchable via " +
      "YouTube, but you won't be able to re-review it until you re-import.")) return;
    const j = await call("DELETE", {});
    if (j) { setState("youtube"); setStatus(`✓ freed ${j.freed}`); }
  }

  const label = status || (vid
    ? (state === "youtube" ? "YouTube ✓ ⤓" : "YouTube ✓") : "YouTube ▾");
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button className={vid ? "primary" : ""} onClick={() => setOpen(o => !o)}
        title={vid ? `Video ${vid} · media ${state}` : "Not on YouTube yet"}>
        {label}
      </button>
      {open && (
        <>
          <span onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div className="card" style={{ position: "absolute", right: 0, top: "100%",
            marginTop: 4, zIndex: 41, padding: 6, minWidth: 230, display: "flex",
            flexDirection: "column", gap: 4 }}>
            {!vid && (
              <button style={{ textAlign: "left" }} onClick={link}
                title="Upload in YouTube Studio, then paste the link — no API audit needed">
                Link a manual upload…</button>
            )}
            {!vid && (
              <button style={{ textAlign: "left" }} disabled={!canUpload}
                title={canUpload ? "Push the local mp4 to your channel via the API"
                  : "Needs OAuth — run npm run yt-auth (see YOUTUBE-PLAN.md)"}
                onClick={upload}>
                Upload via API{canUpload ? "" : " (needs OAuth)"}</button>
            )}
            {vid && (
              <a href={`https://www.youtube.com/watch?v=${vid}`} target="_blank"
                rel="noreferrer" onClick={() => setOpen(false)}>
                <button style={{ textAlign: "left", width: "100%" }}>
                  Open on YouTube</button>
              </a>
            )}
            {vid && (
              <button style={{ textAlign: "left" }}
                title="Push the current derived name up to YouTube. The site name is live; the YouTube title is a snapshot taken at upload, so the two can drift."
                onClick={async () => {
                  const j = await call("PATCH", { retitle: true });
                  if (j) setStatus("✓ " + j.title);
                }}>Re-sync title</button>
            )}
            {vid && state === "both" && (
              <button className="danger" style={{ textAlign: "left" }}
                onClick={reclaim}
                title="Free the disk — the game stays watchable, but not reviewable">
                Reclaim local video…</button>
            )}
            {vid && state !== "youtube" && (
              <button style={{ textAlign: "left" }}
                onClick={async () => {
                  const j = await call("PATCH", { video: null });
                  if (j) { setVid(null); setState("local"); setStatus("✓ unlinked"); }
                }}>Unlink</button>
            )}
            {state === "youtube" && (
              <span className="muted" style={{ fontSize: 12, padding: "2px 6px" }}>
                Local file reclaimed — re-import the bundle to review this game again.
              </span>
            )}
          </div>
        </>
      )}
    </span>
  );
}

export default function PublishToggle({ id, published }) {
  const [pub, setPub] = useState(published);
  return (
    <button className={pub ? "primary" : ""} onClick={async () => {
      const next = !pub; setPub(next);
      await fetch("/api/games", { method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, published: next ? 1 : 0 }) });
    }}>{pub ? "Published ✓" : "Publish"}</button>
  );
}
