// Shared helpers for the Shorts PUBLISH queue — used by the API routes and by
// scripts/publish-worker.mjs, so the two can't drift on what a status means.
// Mirrors lib/import-queue.js, which mirrors lib/shorts.js; this completes the
// trio, and all three are the same shape for the same reason.
//
// Why a queue at all: publishing used to happen inside the PATCH request that
// asked for it, which is fine for one Short and impossible for eight — a batch
// is N resumable YouTube uploads, minutes of network. Now "Publish all" flips
// N rows to 'queued' and returns in milliseconds while the page polls.
//
// The other reason is destinations. A Short will soon go to Instagram as well
// (YOUTUBE-PLAN.md), so state lives per (short, dest) rather than on the Short.
// Nothing here knows about Instagram yet — DESTS has one entry, and adding the
// second should be a worker branch plus a row, not a migration.
//
// One invariant governs everything below: NEVER put two copies of a clip on a
// public channel. Four guards, and all four are load-bearing —
//   1. short_posts_once, the UNIQUE index (schema.sql)
//   2. claimNextPost's conditional UPDATE, so two workers can't take one row
//   3. a row that already has a remote_id is never re-queued (queuePosts)
//   4. rows stuck in 'posting' are FAILED on worker startup, never retried
import fs from "fs";
import { db } from "./db.js";
import { absFromUrl, blockedReason, RENDER_PENDING, pendingWork } from "./shorts.js";
import { reclaimPreflight } from "./reclaim.js";
import { displayName } from "./game-name.js";

export const POST_STATUSES = ["queued", "posting", "posted", "failed"];
// Statuses that mean the queue still owes this destination an upload.
export const POST_PENDING = ["queued", "posting"];
// Instagram lands here. See YOUTUBE-PLAN.md before adding it — the API path
// is real but needs a Meta app and a token-refresh cron, and TikTok has no
// unaudited path to a public post at all.
export const DESTS = ["youtube"];

const nowISO = () => new Date().toISOString();

/**
 * Queue one or more rendered Shorts for upload.
 *
 * @returns {{queued: number[], skipped: {short_id: number, reason: string}[]}}
 *   the same shape /api/import/jobs POST already returns, so a partial
 *   success reads the same way in both places.
 */
export function queuePosts(shortIds, dest = "youtube") {
  if (!DESTS.includes(dest)) throw new Error(`unknown destination "${dest}"`);
  const d = db();
  const queued = [];
  const skipped = [];

  for (const id of shortIds) {
    const short = d.prepare("SELECT * FROM shorts WHERE id = ?").get(id);
    if (!short) { skipped.push({ short_id: id, reason: "no such short" }); continue; }

    // The destination row is checked FIRST, before anything about the local
    // file. A Short already on the channel whose mp4 has since been deleted
    // must report "already on youtube", not "the file is missing — requeue
    // it": the second is true but sends you off to re-render something that
    // is already published.
    const existing = d.prepare(
      "SELECT * FROM short_posts WHERE short_id = ? AND dest = ?").get(id, dest);
    if (existing?.remote_id) {
      // Guard 3. A row with a remote_id has ALREADY put a video on the
      // channel; re-queueing it would upload a second copy, and no amount of
      // "it failed" in the error column changes that.
      skipped.push({ short_id: id,
        reason: `already on ${dest} as ${existing.remote_id}` });
      continue;
    }
    if (existing && POST_PENDING.includes(existing.status)) {
      skipped.push({ short_id: id, reason: `already ${existing.status}` });
      continue;
    }

    // 'published' is allowed as well as 'ready' so a legacy row (published
    // before short_posts existed) can still be sent to a NEW destination.
    if (!["ready", "published"].includes(short.status)) {
      skipped.push({ short_id: id, reason: `it's ${short.status}, not ready` });
      continue;
    }
    if (!short.file || !fs.existsSync(absFromUrl(short.file))) {
      skipped.push({ short_id: id, reason: "the rendered file is missing — requeue it" });
      continue;
    }

    if (existing) {
      // failed → retry re-queues THIS row rather than inserting a second one.
      d.prepare(
        `UPDATE short_posts SET status='queued', error=NULL, started_at=NULL,
           finished_at=NULL, updated_at=datetime('now') WHERE id = ?`)
        .run(existing.id);
      queued.push(id);
      continue;
    }

    d.prepare(
      "INSERT INTO short_posts (short_id, dest, status) VALUES (?, ?, 'queued')")
      .run(id, dest);
    queued.push(id);
  }
  return { queued, skipped };
}

/**
 * Take the next queued post. The claim is the conditional UPDATE, not the
 * SELECT: `AND status='queued'` means only one caller can move a given row, so
 * the systemd worker and a dev `npm run publish-worker` can both be running
 * without ever uploading the same Short twice. A lost race tries the next row.
 */
export function claimNextPost() {
  const d = db();
  for (;;) {
    const row = d.prepare(
      "SELECT id FROM short_posts WHERE status='queued' ORDER BY id LIMIT 1").get();
    if (!row) return null;
    const r = d.prepare(
      `UPDATE short_posts SET status='posting', error=NULL,
         started_at=datetime('now'), updated_at=datetime('now'),
         attempts = attempts + 1
       WHERE id = ? AND status = 'queued'`).run(row.id);
    if (r.changes)
      return { ...d.prepare("SELECT * FROM short_posts WHERE id = ?").get(row.id) };
  }
}

/**
 * Record the outcome of one upload.
 *
 * The post row is the truth; shorts.status/yt_video_id are a mirror written
 * here and nowhere else. There are no transactions anywhere in this codebase
 * (better-sqlite3's are unavailable on the node:sqlite fallback in db.js), so
 * a crash between the two writes is possible — reconcileMirrors repairs it.
 */
export function finishPost(row, { status, remote_id = null, url = null,
                                  error = null }) {
  const d = db();
  d.prepare(
    `UPDATE short_posts SET status=?, remote_id=?, url=?, error=?,
       finished_at=datetime('now'), updated_at=datetime('now') WHERE id = ?`)
    .run(status, remote_id, url, error, row.id);
  if (row.dest === "youtube" && status === "posted")
    d.prepare(
      `UPDATE shorts SET status='published', yt_video_id=?, published_at=?
       WHERE id = ?`).run(remote_id, nowISO(), row.short_id);
}

/**
 * Repair any Short whose mirror disagrees with its youtube post row.
 *
 * Called at worker startup and from GET /api/shorts, for the same reason
 * /api/import/jobs GET calls reapStaleStaging: the UI must self-heal even when
 * no worker is running. Only ever moves a Short FORWARD to published — it
 * never un-publishes, because the video really is on the channel.
 */
export function reconcileMirrors() {
  const r = db().prepare(
    `UPDATE shorts SET status='published',
       yt_video_id = (SELECT remote_id FROM short_posts
                       WHERE short_id = shorts.id AND dest='youtube'),
       published_at = COALESCE(published_at, datetime('now'))
     WHERE EXISTS (SELECT 1 FROM short_posts
                    WHERE short_id = shorts.id AND dest='youtube'
                      AND status='posted' AND remote_id IS NOT NULL)
       AND (status != 'published' OR yt_video_id IS NULL)`).run();
  return r.changes || 0;
}

// --- the /shorts payload ---------------------------------------------------

// A game is still "open" if any part of the flow is unfinished: a Short not
// rendered, not posted, Shorts not marked done, or a local video still to
// reclaim. Everything else is history.
function isOpen(game, shorts, reclaim) {
  if (shorts.some(s => s.status !== "published")) return true;
  if (shorts.some(s => s.posts.some(p => p.status !== "posted"))) return true;
  if (!game.shorts_done) return true;
  return reclaim.ok;
}

/**
 * Everything /shorts renders, in one call.
 *
 * The page's server component calls this DIRECTLY and the API calls it too,
 * so first paint and first poll cannot disagree — there is no second query
 * shape to keep in sync.
 *
 * Membership mirrors listJobs(): everything unfinished, plus recent history so
 * a batch doesn't vanish out from under you the moment the last one publishes.
 */
export function listReviewBatch({ doneLimit = 5 } = {}) {
  const d = db();
  reconcileMirrors();

  // Scope matches /watch exactly — Shorts are picked there, so a game that
  // page can't show is a game with no way to pick from.
  const games = d.prepare(
    `SELECT * FROM games WHERE published = 1
      ORDER BY played_on IS NULL, played_on DESC, slot DESC, id DESC`).all();

  const open = [];
  const done = [];
  for (const g of games) {
    const shorts = d.prepare("SELECT * FROM shorts WHERE game_id = ? ORDER BY id")
      .all(g.id).map(s => ({ ...s,
        posts: d.prepare(
          "SELECT * FROM short_posts WHERE short_id = ? ORDER BY id").all(s.id)
          .map(p => ({ ...p })) }));
    // A game nobody has picked from is not part of this flow at all — it
    // would be every published game, forever.
    if (!shorts.length) continue;

    // assumeShortsDone: this payload feeds the Finish-up confirm dialog, and
    // that action marks Shorts done before reclaiming. Previewing against the
    // un-flagged row would tell Ken "0 MB will be freed" and then delete
    // several GB. See reclaimPreflight.
    const reclaim = reclaimPreflight(g, { assumeShortsDone: true });
    const counts = {
      total: shorts.length,
      rendering: shorts.filter(s => RENDER_PENDING.includes(s.status)).length,
      ready: shorts.filter(s => s.status === "ready" &&
        !s.posts.some(p => POST_PENDING.includes(p.status) || p.status === "posted")).length,
      failed: shorts.filter(s => s.status === "failed").length,
      posting: shorts.filter(s => s.posts.some(p => POST_PENDING.includes(p.status))).length,
      posted: shorts.filter(s => s.posts.some(p => p.status === "posted")).length,
      post_failed: shorts.filter(s => s.posts.some(p => p.status === "failed")).length,
    };
    const row = {
      id: g.id, name: displayName(g),
      date: g.played_on ?? g.created_at?.slice(0, 10) ?? null,
      shorts_done: !!g.shorts_done,
      media_state: g.media_state ?? "local",
      yt_video_id: g.yt_video_id ?? null,
      shorts_blocked: blockedReason(g),
      busy: pendingWork(g.id).busy,
      counts, reclaim, shorts,
    };
    (isOpen(g, shorts, reclaim) ? open : done).push(row);
  }

  const all = [...open, ...done.slice(0, doneLimit).map(g => ({ ...g, done: true }))];
  const sum = (list, f) => list.reduce((a, g) => a + f(g), 0);
  const batch = {
    games: open.length,
    pending_render: sum(open, g => g.counts.rendering),
    pending_post: sum(open, g => g.counts.posting),
    ready_to_publish: sum(open, g => g.counts.ready),
    post_failed: sum(open, g => g.counts.post_failed),
    // Finish up is gated on nothing being IN FLIGHT, not on everything having
    // succeeded: a failed publish is retryable after a reclaim (that deletes
    // the game video, not the Short's mp4), so it must not hold the batch open
    // forever. The confirm names the games with failures instead.
    finishable_game_ids: open.filter(g => !g.busy &&
      (!g.shorts_done || g.reclaim.ok)).map(g => g.id),
    freed_bytes_total: sum(open.filter(g => !g.busy), g => g.reclaim.bytes || 0),
  };
  batch.idle = batch.pending_render + batch.pending_post === 0;
  return { games: all, batch };
}
