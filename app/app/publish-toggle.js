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
              title={driveReady ? "Upload straight to your Drive/balltime folder"
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
