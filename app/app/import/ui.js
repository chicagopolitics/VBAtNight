"use client";
import { useCallback, useEffect, useState } from "react";

// No filename parsing here any more. A game's identity is its recording
// date and its order in the night, both read from the bundle's own
// game.json (written by the pipeline against the original camera file).
// Bundles whose date can't be determined land on the games list asking for
// one. See NAMING-PLAN.md.
//
// Imports are QUEUED, not performed here: this page writes rows to
// import_jobs and polls them, and scripts/import-worker.mjs does the work. So
// the queue is server state, and closing the tab, refreshing, or navigating
// away costs nothing.
//
// That also decides where progress comes from. Every number below is read
// back from the server rather than kept in React — including the byte count
// of an upload in flight, which the stage route writes as it receives. A
// smoother client-side counter was the obvious alternative and the wrong one:
// it would show one thing in this tab and nothing in a reloaded one, which is
// precisely the confusion the queue exists to remove.
const gb = n => n >= 2 ** 30 ? (n / 2 ** 30).toFixed(1) + " GB"
  : Math.round(n / 2 ** 20) + " MB";

const PENDING = ["staging", "queued", "importing"];
const LABEL = {
  staging: "uploading…",
  queued: "queued",
  importing: "importing…",
  done: "✓ imported",
  failed: "✗ failed",
};

export default function ImportPage() {
  const [drive, setDrive] = useState(null);   // null=loading, {configured, files, error}
  const [picked, setPicked] = useState({});   // drive fileId -> true
  const [jobs, setJobs] = useState(null);     // null=loading
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(0);  // uploads left in this batch

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/import/jobs");
      const j = await r.json();
      if (j.jobs) setJobs(j.jobs);
    } catch { /* transient — the next poll will do */ }
  }, []);

  useEffect(() => {
    fetch("/api/drive").then(r => r.json()).then(setDrive)
      .catch(() => setDrive({ configured: false, files: [] }));
    refresh();
  }, [refresh]);

  const pending = (jobs || []).filter(j => PENDING.includes(j.status));

  // Poll while anything is moving. An idle queue stops polling entirely
  // rather than hitting the droplet every two seconds for a page left open.
  const live = pending.length > 0 || sending > 0;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [live, refresh]);

  const pickedIds = Object.keys(picked).filter(k => picked[k]);

  async function queueDrive() {
    const files = (drive?.files || []).filter(f => picked[f.id]);
    if (!files.length) return;
    setPicked({});
    const r = await fetch("/api/import/jobs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    const j = await r.json();
    if (j.jobs) setJobs(j.jobs);
    setNote(j.error ? j.error
      : j.skipped?.length
        ? `${j.queued.length} queued; skipped ${j.skipped.map(s => `${s.name} (${s.reason})`).join(", ")}`
        : `${j.queued?.length || 0} queued`);
  }

  // Upload the picked files one at a time. Sequential on purpose: six
  // parallel multi-GB uploads share one upstream link and just make every one
  // of them finish later, and this way each file becomes durable as its own
  // upload lands rather than at the end of the batch.
  async function addUploads(e) {
    e.preventDefault();
    const input = e.target.bundle;
    const files = [...input.files];
    if (!files.length) return;
    input.value = "";
    setNote("");
    setSending(files.length);
    for (const f of files) {
      // Give the poll a moment to pick up the 'staging' row the request
      // creates, so the queue shows the upload while it's happening.
      setTimeout(refresh, 300);
      try {
        // raw body upload (not FormData): bundles are multi-GB and the server
        // streams them straight to disk. FormData is not an option — undici
        // buffers the whole multipart body and its parser fails on large
        // uploads ("expected CRLF").
        const res = await fetch(
          `/api/import/stage?name=${encodeURIComponent(f.name)}&size=${f.size}`,
          { method: "POST", headers: { "content-type": "application/zip" }, body: f });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "upload failed");
      } catch (err) {
        setNote(`${f.name}: ${err.message}`);
      }
      setSending(n => n - 1);
      await refresh();
    }
  }

  async function act(method, body) {
    const r = await fetch("/api/import/jobs", {
      method, headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.jobs) setJobs(j.jobs);
    if (j.error) setNote(j.error);
  }

  return (
    <div className="card" style={{ maxWidth: 640, margin: "40px auto" }}>
      <h1>Import processed games</h1>
      <p className="muted">
        Queue as many bundles as you like — the importing happens on the server,
        so you can close this page and come back to it. Names are derived from
        each game&rsquo;s recording date and its order in the night, so the file
        name doesn&rsquo;t matter. If a bundle carries no date, the game appears
        on the games list asking for one.
      </p>

      {drive?.configured && (
        <div style={{ marginBottom: 18 }}>
          <h2 style={{ marginBottom: 4 }}>From Google Drive</h2>
          {drive.error && <p className="muted">Drive error: {drive.error}</p>}
          {!drive.error && drive.files.length === 0 &&
            <p className="muted">No bundle zips found in the shared folder.</p>}
          {(drive.files || []).map(f => (
            <label className="row" key={f.id}
              style={{ justifyContent: "space-between", padding: "4px 0", cursor: "pointer" }}>
              <span className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={!!picked[f.id]}
                  onChange={e => setPicked(p => ({ ...p, [f.id]: e.target.checked }))} />
                <span>{f.name} <span className="muted">{gb(f.size)}</span></span>
              </span>
            </label>
          ))}
          {drive.files?.length > 0 && (
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button className="primary" disabled={!pickedIds.length} onClick={queueDrive}>
                {pickedIds.length
                  ? `Queue ${pickedIds.length} bundle${pickedIds.length > 1 ? "s" : ""}`
                  : "Queue selected"}
              </button>
              <button onClick={() =>
                setPicked(Object.fromEntries(drive.files.map(f => [f.id, true])))}>
                Select all
              </button>
              {pickedIds.length > 0 && <button onClick={() => setPicked({})}>Clear</button>}
            </div>
          )}
        </div>
      )}

      {drive && !drive.configured && (
        <p className="muted">
          Tip: imports can pull straight from Google Drive — see
          {" "}<code>DRIVE-SETUP.md</code> in the repo to set it up (10 min, one
          time). A Drive bundle needs nothing from the browser at all, so the
          queue runs even with no tab open.
        </p>
      )}

      <h2 style={{ marginTop: 16 }}>Or upload files</h2>
      <p className="muted">
        Select one or more <code>game_bundle_….zip</code> files. They upload one
        at a time and join the queue as each one lands — so leaving this page
        keeps everything already uploaded and loses only the one still in
        flight, because a picked file exists nowhere but in this browser until
        its bytes arrive.
      </p>
      <form onSubmit={addUploads}>
        <div className="row" style={{ marginBottom: 14 }}>
          <input type="file" name="bundle" accept=".zip" multiple required />
        </div>
        <button className="primary" type="submit" disabled={sending > 0}>
          {sending > 0 ? `Uploading… (${sending} left)` : "Add to queue"}
        </button>
      </form>

      {note && <p className="muted" style={{ marginTop: 12 }}>{note}</p>}

      <h2 style={{ marginTop: 22 }}>
        Queue{pending.length ? ` — ${pending.length} pending` : ""}
      </h2>
      {jobs === null && <p className="muted">loading…</p>}
      {jobs?.length === 0 && <p className="muted">Nothing queued.</p>}
      {jobs?.map(j => <Job key={j.id} job={j} act={act} />)}

      <p style={{ marginTop: 18 }}><a href="/">→ back to games</a></p>
    </div>
  );
}

function Job({ job, act }) {
  const pct = job.status === "staging" && job.size
    ? ` ${Math.min(99, Math.floor((job.bytes / job.size) * 100))}%` : "";
  return (
    <div style={{ padding: "6px 0", borderTop: "1px solid rgba(128,128,128,.2)" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <span>
          {job.name}{" "}
          <span className="muted">
            {job.source === "drive" ? "Drive" : "upload"}
            {job.size ? ` · ${gb(job.size)}` : ""}
          </span>
        </span>
        <span className="row" style={{ gap: 8 }}>
          <span className="muted">{LABEL[job.status] || job.status}{pct}</span>
          {job.status === "done" && job.game_id &&
            <a href={`/games/${job.game_id}/identities`}>name players →</a>}
          {/* Only a Drive job can retry itself — an upload's zip is consumed by
              the attempt, so the honest offer there is the file picker. */}
          {job.status === "failed" && job.source === "drive" &&
            <button onClick={() => act("PATCH", { id: job.id, requeue: true })}>Retry</button>}
          {job.status !== "importing" &&
            <button onClick={() => act("DELETE", { id: job.id })}>Remove</button>}
        </span>
      </div>
      {job.error && <p className="muted" style={{ margin: "2px 0 0" }}>{job.error}</p>}
    </div>
  );
}
