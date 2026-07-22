"use client";
import { useEffect, useState } from "react";

const niceName = f => f.replace(/^game_bundle_/, "").replace(/\.zip$/, "")
  .replace(/[_-]+/g, " ");
const gb = n => n >= 2 ** 30 ? (n / 2 ** 30).toFixed(1) + " GB"
  : Math.round(n / 2 ** 20) + " MB";

export default function ImportPage() {
  const [items, setItems] = useState([]);   // {name, status}
  const [busy, setBusy] = useState(false);
  const [drive, setDrive] = useState(null); // null=loading, {configured, files, error}
  const [driveStatus, setDriveStatus] = useState({});   // fileId -> status text

  useEffect(() => {
    fetch("/api/drive").then(r => r.json()).then(setDrive)
      .catch(() => setDrive({ configured: false, files: [] }));
  }, []);

  async function importFromDrive(f) {
    setBusy(true);
    setDriveStatus(s => ({ ...s, [f.id]: "downloading + importing…" }));
    try {
      const res = await fetch("/api/drive", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: f.id, name: niceName(f.name) }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "failed");
      setDriveStatus(s => ({ ...s, [f.id]: "✓ imported" }));
      window.location.href = `/games/${j.game_id}/identities`;
    } catch (err) {
      setDriveStatus(s => ({ ...s, [f.id]: "✗ " + err.message }));
      setBusy(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    const files = [...e.target.bundle.files];
    if (!files.length) return;
    setBusy(true);
    setItems(files.map(f => ({ name: f.name, status: "waiting…" })));
    let lastId = null;
    for (let i = 0; i < files.length; i++) {
      setItems(it => it.map((x, j) => j === i ? { ...x, status: "importing…" } : x));
      // game name from filename: game_bundle_july24_g3.zip -> "july24 g3"
      const nice = files[i].name.replace(/^game_bundle_/, "").replace(/\.zip$/, "")
        .replace(/[_-]+/g, " ");
      try {
        // raw body upload (not FormData): bundles are multi-GB and the
        // server streams them straight to disk
        const res = await fetch(`/api/import?name=${encodeURIComponent(nice)}`, {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: files[i],
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "failed");
        lastId = j.game_id;
        setItems(it => it.map((x, jj) => jj === i ? { ...x, status: "✓ imported" } : x));
      } catch (err) {
        setItems(it => it.map((x, jj) => jj === i ? { ...x, status: "✗ " + err.message } : x));
      }
    }
    setBusy(false);
    if (files.length === 1 && lastId) window.location.href = `/games/${lastId}/identities`;
  }

  return (
    <div className="card" style={{ maxWidth: 560, margin: "40px auto" }}>
      <h1>Import processed games</h1>
      {drive?.configured && (
        <div style={{ marginBottom: 18 }}>
          <h2 style={{ marginBottom: 4 }}>From Google Drive</h2>
          {drive.error && <p className="muted">Drive error: {drive.error}</p>}
          {!drive.error && drive.files.length === 0 &&
            <p className="muted">No bundle zips found in the shared folder.</p>}
          {(drive.files || []).map(f => (
            <div className="row" key={f.id}
              style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{f.name} <span className="muted">{gb(f.size)}</span></span>
              <span className="row">
                <span className="muted">{driveStatus[f.id] || ""}</span>
                <button disabled={busy} onClick={() => importFromDrive(f)}>Import</button>
              </span>
            </div>
          ))}
          <h2 style={{ marginTop: 16 }}>Or upload a file</h2>
        </div>
      )}
      {drive && !drive.configured && (
        <p className="muted">
          Tip: imports can pull straight from Google Drive — see
          {" "}<code>DRIVE-SETUP.md</code> in the repo to set it up (10 min, one time).
        </p>
      )}
      <p className="muted">
        Select one or more <code>game_bundle_….zip</code> files (from
        Drive/balltime/bundles). Game names come from the file names — you can
        rename bundles before importing if you like.
      </p>
      <form onSubmit={submit}>
        <div className="row" style={{ marginBottom: 14 }}>
          <input type="file" name="bundle" accept=".zip" multiple required />
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Importing…" : "Import all"}
        </button>
      </form>
      {items.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {items.map((x, i) => (
            <div className="row" key={i} style={{ justifyContent: "space-between" }}>
              <span>{x.name}</span><span className="muted">{x.status}</span>
            </div>
          ))}
          {!busy && <p><a href="/">→ back to games</a></p>}
        </div>
      )}
    </div>
  );
}
