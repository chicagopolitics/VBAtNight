"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { callJson } from "../publish-toggle";

// The review-and-publish surface. See page.js for why it exists.
//
// One piece of state holds the WHOLE payload, and every mutating endpoint
// returns that same payload — so each handler is `setData(await callJson(…))`
// with no local patching to keep in sync. That's the import page's discipline
// (every number read back from the server) and it matters more here, because
// two of the actions on this page delete things.

const gb = n => n >= 2 ** 30 ? (n / 2 ** 30).toFixed(2) + " GB"
  : Math.round(n / 2 ** 20) + " MB";

const RENDER_TONE = { queued: "", rendering: "info", ready: "good",
  published: "good", failed: "bad" };
const RENDER_LABEL = { queued: "queued", rendering: "rendering…",
  ready: "ready", published: "published", failed: "✗ render failed" };
const POST_TONE = { queued: "info", posting: "info", posted: "good", failed: "bad" };
const POST_LABEL = { queued: "queued to publish", posting: "uploading…",
  posted: "✓ on YouTube", failed: "✗ publish failed" };

// This is the one thing in the system that puts the league on a PUBLIC
// channel, so it is confirmed every time — but once per batch rather than
// once per clip, which is the whole point of the page.
const publishWarning = n =>
  `Publish ${n} Short${n === 1 ? "" : "s"} to YouTube as PUBLIC?\n\n` +
  "Unlike your full games (unlisted), Shorts must be public to get any " +
  "reach — this makes them visible to anyone.";

function yt(post) { return post?.url || `https://www.youtube.com/watch?v=${post?.remote_id}`; }

// --- one Short -------------------------------------------------------------

function ShortCard({ short, act, eager }) {
  const [caption, setCaption] = useState(short.caption || "");
  const [editing, setEditing] = useState(false);

  const post = short.posts.find(p => p.dest === "youtube") || null;
  const inFlight = !!post && ["queued", "posting"].includes(post.status);
  const posted = post?.status === "posted";
  const postFailed = post?.status === "failed";
  const rendering = ["queued", "rendering"].includes(short.status);
  // Nothing may re-render or delete a Short whose bytes the publish worker is
  // streaming right now — the API refuses both, and offering the buttons
  // anyway would just produce a 409.
  const frozen = inFlight;

  return (
    <div className="card shortcard">
      {/* The inline player is the point of this page: previewing used to mean
          opening the mp4 in a new browser tab, one clip at a time. */}
      {short.file
        ? <video controls playsInline preload={eager ? "metadata" : "none"}
            src={short.file} />
        : <div className="shortcard-novid muted">
            {rendering ? "rendering…" : "no file"}</div>}

      <div className="row shortcard-pills">
        <span className={`pill ${RENDER_TONE[short.status] || ""}`}
          title={short.error || ""}>
          {RENDER_LABEL[short.status] || short.status}</span>
        {post && (
          <span className={`pill ${POST_TONE[post.status] || ""}`}
            title={post.error || ""}>
            {POST_LABEL[post.status] || post.status}</span>
        )}
      </div>

      {editing ? (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <input value={caption} onChange={e => setCaption(e.target.value)}
            style={{ flex: 1, fontSize: 13 }} placeholder="KILL - Sam" />
          <button className="mini primary" onClick={() => {
            // The caption is BURNED INTO the video as well as being the
            // YouTube title, so changing it on an already-rendered clip means
            // re-rendering — otherwise the words on screen and the words on
            // the listing would disagree.
            const rerender = short.status === "ready";
            act(async () => {
              await callJson("/api/shorts", "PATCH", { id: short.id, caption });
              if (rerender) await callJson("/api/shorts", "PATCH",
                { id: short.id, requeue: true });
              return callJson("/api/shorts", "GET");
            }, rerender ? "✓ saved — re-rendering" : "✓ saved");
            setEditing(false);
          }}>{short.status === "ready" ? "Save & re-render" : "Save"}</button>
          <button className="mini" onClick={() => {
            setCaption(short.caption || ""); setEditing(false);
          }}>Cancel</button>
        </div>
      ) : (
        <div className="shortcard-cap">
          <strong>{short.caption || `short #${short.id}`}</strong>
          {short.subcaption && <span className="muted"> · {short.subcaption}</span>}
          {!posted && !frozen && (
            <button className="mini linkish" onClick={() => setEditing(true)}
              title="The caption is burned into the video and becomes the YouTube title">
              edit</button>
          )}
        </div>
      )}

      {(short.error || post?.error) && (
        <p className="muted shortcard-err">{short.error || post.error}</p>
      )}

      <div className="row shortcard-actions">
        {short.status === "ready" && !posted && !inFlight && (
          <button className="primary mini" onClick={() => {
            if (!confirm(publishWarning(1))) return;
            act(() => callJson("/api/shorts/publish", "POST",
              { short_ids: [short.id] }), postFailed ? "✓ retrying" : "✓ queued");
          }}>{postFailed ? "Retry publish" : "Publish"}</button>
        )}
        {posted && (
          <a className="abtn mini" href={yt(post)} target="_blank" rel="noreferrer">
            On YouTube ↗</a>
        )}
        {inFlight && <span className="muted">uploading…</span>}
        {["failed", "ready"].includes(short.status) && !frozen && !posted && (
          <button className="mini" title={short.error || "Render this clip again"}
            onClick={() => act(() => callJson("/api/shorts", "PATCH",
              { id: short.id, requeue: true }), "✓ re-rendering")}>
            {short.status === "failed" ? "Retry render" : "Re-render"}</button>
        )}
        {!rendering && !frozen && (
          <button className="danger mini" onClick={() => {
            if (!confirm(posted
              ? "Remove this Short from the app? The video STAYS on YouTube — " +
                "delete it in Studio if you want it gone."
              : "Remove this Short?")) return;
            act(() => callJson("/api/shorts", "DELETE", { id: short.id }), "✓ removed");
          }}>✕</button>
        )}
      </div>
    </div>
  );
}

// --- one game --------------------------------------------------------------

function GameGroup({ game, act, busyBatch }) {
  const [open, setOpen] = useState(!game.done);
  const c = game.counts;
  const summary = [
    c.rendering && `${c.rendering} rendering`,
    c.ready && `${c.ready} ready`,
    c.posting && `${c.posting} uploading`,
    c.posted && `${c.posted} published`,
    c.failed && `${c.failed} render failed`,
    c.post_failed && `${c.post_failed} publish failed`,
  ].filter(Boolean).join(" · ") || `${c.total} short${c.total === 1 ? "" : "s"}`;

  return (
    <section className="card gamegroup">
      <div className="row gamegroup-head">
        <button className="mini linkish" onClick={() => setOpen(o => !o)}
          aria-expanded={open}>
          <span className={"chev" + (open ? " open" : "")}>▸</span></button>
        <strong style={{ flex: 1 }}>{game.name}</strong>
        <span className="muted">{summary}</span>
        {game.shorts_done && <span className="pill good">done</span>}
        {game.media_state === "youtube" && <span className="pill" title=
          "the local video has been reclaimed — no more Shorts can be made from this game">
          disk freed</span>}
        {c.ready > 0 && (
          <button className="primary mini" disabled={busyBatch} onClick={() => {
            if (!confirm(publishWarning(c.ready))) return;
            act(() => callJson("/api/shorts/publish", "POST",
              { game_id: game.id }), `✓ queued ${c.ready}`);
          }}>Publish {c.ready} ready</button>
        )}
        {!game.shorts_done && !game.busy && (
          <button className="mini" title=
            "Assert you're finished pulling Shorts from this game. Required before its video can be reclaimed."
            onClick={() => act(() => callJson("/api/shorts", "PATCH",
              { game_id: game.id, shorts_done: true }), "✓ marked done")}>
            Mark done</button>
        )}
      </div>

      {game.shorts_blocked && open &&
        <p className="muted">⚠ {game.shorts_blocked}</p>}

      {open && (
        <div className="grid-shorts">
          {game.shorts.map((s, i) => (
            <ShortCard key={s.id} short={s} act={act} eager={i < 4} />
          ))}
        </div>
      )}
    </section>
  );
}

// --- finish up -------------------------------------------------------------

// A modal rather than confirm(), because this has to LIST what it will delete
// and how much it frees. Everything shown comes from game.reclaim in the
// payload — the same preflight the server enforces — so the dialog can't
// promise something the server then refuses.
function FinishModal({ games, onCancel, onConfirm }) {
  const willFree = games.filter(g => g.reclaim.ok);
  const total = willFree.reduce((a, g) => a + (g.reclaim.bytes || 0), 0);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2 style={{ margin: 0 }}>Finish up {games.length} game
          {games.length === 1 ? "" : "s"}?</h2>
        <p className="muted">Marks Shorts done, then deletes the local game
          video for the ones that are safely on YouTube.</p>
        <div className="finish-list">
          {games.map(g => (
            <div className="row finish-row" key={g.id}>
              <span>{g.reclaim.ok ? "✓" : g.counts.post_failed ? "⚠" : "–"}</span>
              <span style={{ flex: 1 }}>{g.name}</span>
              <span className="muted">
                {g.reclaim.ok ? `frees ${gb(g.reclaim.bytes)}` : g.reclaim.reason}
                {g.counts.post_failed
                  ? ` · ${g.counts.post_failed} publish failed` : ""}
              </span>
            </div>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Total freed: <strong>{gb(total)}</strong>. This cannot be undone — a
          Short can only ever be rendered from the local video, so a reclaimed
          game can be watched but never re-reviewed or re-clipped.
          {games.some(g => g.counts.post_failed) && " A failed PUBLISH can " +
            "still be retried afterwards (that file stays); a failed RENDER cannot."}
        </p>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={onConfirm}>Yes, finish up</button>
        </div>
      </div>
    </div>
  );
}

// --- the page --------------------------------------------------------------

export default function ShortsReview({ initial }) {
  const [data, setData] = useState(initial);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [results, setResults] = useState(null);

  // Every mutating call answers with the whole batch, so a handler is just
  // "run it, replace state, say what happened".
  const act = useCallback(async (fn, ok) => {
    setBusy(true); setMsg("…");
    try {
      const j = await fn();
      if (j?.games) setData(d => ({ ...d, ...j }));
      // A partial success is the normal case for a batch, not an edge case.
      const skipped = j?.skipped?.length
        ? ` (${j.skipped.length} skipped: ${j.skipped[0].reason})` : "";
      setMsg((typeof ok === "function" ? ok(j) : ok) + skipped);
      return j;
    } catch (e) { setMsg("✗ " + e.message); return null; }
    finally { setBusy(false); }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const j = await callJson("/api/shorts", "GET");
      if (j?.games) setData(d => ({ ...d, ...j }));
    } catch { /* transient — the next tick retries */ }
  }, []);

  // Poll only while the workers owe us something. The moment both queues
  // drain the interval is torn down, so a page left open makes no requests.
  const live = data.batch.pending_render + data.batch.pending_post > 0;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [live, refresh]);

  const open = data.games.filter(g => !g.done);
  const done = data.games.filter(g => g.done);
  const readyIds = useMemo(() => open.flatMap(g => g.shorts
    .filter(s => s.status === "ready" &&
      !s.posts.some(p => p.status === "posted" || ["queued", "posting"].includes(p.status)))
    .map(s => s.id)), [data]);
  const finishable = open.filter(g => data.batch.finishable_game_ids.includes(g.id));

  const b = data.batch;
  const headline = [
    b.ready_to_publish && `${b.ready_to_publish} ready to publish`,
    b.pending_render && `${b.pending_render} rendering`,
    b.pending_post && `${b.pending_post} uploading`,
    b.post_failed && `${b.post_failed} publish failed`,
  ].filter(Boolean).join(" · ");

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Shorts</h1>
        <span className="muted">{msg || headline || "nothing pending"}</span>
      </div>

      {!data.youtube_configured && (
        <p className="muted">⚠ YouTube isn&apos;t configured — run{" "}
          <code>npm run yt-auth</code>. Rendering works; publishing won&apos;t.</p>
      )}

      {open.length === 0 && (
        <p className="muted">
          Nothing waiting. Pick plays with <strong>＋</strong> on{" "}
          <a href="/watch">Watch</a> and they&apos;ll show up here once rendered.
        </p>
      )}

      {open.map(g => (
        <GameGroup key={g.id} game={g} act={act} busyBatch={busy} />
      ))}

      {done.length > 0 && (
        <details className="card">
          <summary className="muted">Recently finished ({done.length})</summary>
          {done.map(g => <GameGroup key={g.id} game={g} act={act} busyBatch={busy} />)}
        </details>
      )}

      {results && (
        <div className="card">
          <strong>Finished up</strong>
          {results.map(r => (
            <div className="row" key={r.game_id}>
              <span>{r.ok ? "✓" : "✗"}</span>
              <span style={{ flex: 1 }}>{r.name}</span>
              <span className="muted">
                {r.reclaimed ? `freed ${r.freed}`
                  : r.error || r.reason || "marked done"}</span>
            </div>
          ))}
          <button className="mini" onClick={() => setResults(null)}>Dismiss</button>
        </div>
      )}

      {(readyIds.length > 0 || finishable.length > 0) && (
        <div className="row shorts-footer">
          {readyIds.length > 0 && (
            <button className="primary" disabled={busy} onClick={() => {
              if (!confirm(publishWarning(readyIds.length))) return;
              act(() => callJson("/api/shorts/publish", "POST",
                { short_ids: readyIds }), j => `✓ queued ${j.queued.length}`);
            }}>Publish all {readyIds.length} ready</button>
          )}
          {finishable.length > 0 && (
            <button className="danger" disabled={busy || !b.idle}
              title={b.idle ? "Mark Shorts done and reclaim local video"
                : "wait for renders and uploads to finish"}
              onClick={() => setConfirming(true)}>
              Finish up — {finishable.length} game{finishable.length === 1 ? "" : "s"}
              {b.freed_bytes_total > 0 && ` · ${gb(b.freed_bytes_total)}`}
            </button>
          )}
        </div>
      )}

      {confirming && (
        <FinishModal games={finishable} onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            const j = await act(() => callJson("/api/shorts/finish", "POST",
              { game_ids: finishable.map(g => g.id) }),
              k => `✓ freed ${k.freed_total}`);
            if (j?.results) setResults(j.results);
          }} />
      )}
    </div>
  );
}
