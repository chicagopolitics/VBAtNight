"use client";
import { useState } from "react";

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
      const res = await fetch("/api/youtube", { method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "failed");
      return j;
    } catch (e) { setStatus("✗ " + e.message); return null; }
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
