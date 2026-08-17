#!/usr/bin/env node
// Uploads queued Shorts. The `short_posts` table is the queue; this drains it.
//
//   npm run publish-worker            # drain once and exit (good for testing)
//   npm run publish-worker -- --watch # stay running (what systemd uses)
//
// Why a worker at all: publishing used to happen inside the request that asked
// for it, which is fine for one Short and impossible for eight — a batch is N
// resumable YouTube uploads, minutes of network. Now the page flips rows to
// 'queued' and polls, and a closed tab or a droplet reboot doesn't lose a
// half-finished batch.
//
// Why NOT part of scripts/shorts-worker.mjs: that one is deliberately
// single-threaded because a render is ffmpeg + OpenCV on 2 vCPUs, and it caps
// a render at 15 minutes. An upload is network-bound and shares none of that.
// Folded together, "Publish all 8" could sit dead behind one slow render —
// which is the exact frustration the /shorts page exists to remove.
import "../lib/load-env.js";   // must precede anything that reads credentials
import fs from "fs";
import { db } from "../lib/db.js";
import { absFromUrl, shortMeta, shortPrivacy } from "../lib/shorts.js";
import { claimNextPost, finishPost, reconcileMirrors } from "../lib/publish-queue.js";
import { uploadVideo, youtubeConfigured } from "../lib/youtube.js";

const POLL_MS = 5000;
const watch = process.argv.includes("--watch");

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function publish(row) {
  const d = db();
  const short = d.prepare("SELECT * FROM shorts WHERE id = ?").get(row.short_id);
  if (!short) return fail(row, "the short row disappeared");
  const game = d.prepare("SELECT * FROM games WHERE id = ?").get(short.game_id);
  if (!game) return fail(row, "the game disappeared");

  // Don't spin on a misconfigured box: fail each row with the fix, so the
  // page shows N clear errors instead of a queue that never moves.
  if (!youtubeConfigured())
    return fail(row, "YouTube not configured — run `npm run yt-auth`");

  // Re-check rather than trusting the queue: the file can be removed between
  // queueing and now, exactly as render() re-checks hasVideo.
  const abs = absFromUrl(short.file || "");
  if (!short.file || !fs.existsSync(abs))
    return fail(row, "the rendered file is gone — requeue the render");

  const privacy = shortPrivacy();
  const meta = shortMeta(short, game);
  log(`  post ${row.id}: short ${short.id} "${meta.title}" -> ${row.dest} (${privacy})`);
  const t = Date.now();
  try {
    const v = await uploadVideo(abs, { ...meta, privacy });
    // The privacy YouTube ACTUALLY applied. This used to be the `warning`
    // field of the publish response; with no request left to return it in, it
    // rides on the row and the page renders it beside the pill. It is not a
    // failure — the video is up — but an unlisted Short gets no reach at all,
    // so it must not pass silently.
    const note = v.privacyStatus !== privacy
      ? `⚠ YouTube set this to "${v.privacyStatus}" instead of "${privacy}" — ` +
        `an unlisted Short gets no reach. See YOUTUBE-PLAN.md.`
      : null;
    finishPost(row, { status: "posted", remote_id: v.id, url: v.url, error: note });
    log(`  ✓ post ${row.id} -> ${v.url} in ${((Date.now() - t) / 1000).toFixed(0)}s` +
      (note ? `\n     ${note}` : ""));
  } catch (e) {
    fail(row, e.message);
  }
}

function fail(row, msg) {
  log(`  ✗ post ${row.id}: ${msg}`);
  finishPost(row, { status: "failed", error: String(msg).slice(0, 2000) });
}

async function drain() {
  let n = 0;
  for (let r = claimNextPost(); r; r = claimNextPost()) { await publish(r); n++; }
  return n;
}

// A worker killed mid-upload leaves a row in 'posting'. Unlike an interrupted
// RENDER, this is NOT requeued: YouTube may well have committed the video
// before we died, and a blind retry would put a second copy of the clip on a
// public channel — the one failure this whole design exists to prevent. Fail
// it loudly with the check to make instead. Same reasoning as an interrupted
// import, which also mutates state and so is never blindly retried.
const stuck = db().prepare(
  `UPDATE short_posts SET status='failed', error=?,
     finished_at=datetime('now'), updated_at=datetime('now')
   WHERE status='posting'`).run(
  "interrupted by a restart part-way through the upload. Check the channel " +
  "for a copy of this Short BEFORE retrying — the upload may have completed.");
if (stuck.changes) log(`failed ${stuck.changes} upload(s) left in flight — check the channel`);

// Repair any Short whose published-mirror disagrees with its post row (a crash
// between finishPost's two writes). Cheap, and it means the page never has to
// reconcile them itself.
const fixed = reconcileMirrors();
if (fixed) log(`reconciled ${fixed} short(s) against their post rows`);

log(`worker up (youtube=${youtubeConfigured() ? "configured" : "NOT CONFIGURED"})`);
const n = await drain();
if (!watch) {
  // "processed", not "published": a drained row may have failed, and the
  // summary line is the first thing read when this is run by hand.
  log(n ? `processed ${n} (see above for outcomes)` : "queue empty");
  process.exit(0);
}
log("watching for new work…");
setInterval(() => { drain().catch(e => log("drain error:", e.message)); }, POLL_MS);
