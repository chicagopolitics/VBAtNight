#!/usr/bin/env node
// Imports queued game bundles. The `import_jobs` table is the queue; this
// drains it.
//
//   npm run import-worker             # drain once and exit (good for testing)
//   npm run import-worker -- --watch  # stay running (what systemd uses)
//
// Why a worker at all: importing a bundle is downloading a multi-GB zip from
// Drive, unzipping it, and moving the video into public/media. That is minutes
// of work, far past what an HTTP request should hold — and doing it here is
// exactly what lets a batch of six survive the page being closed.
//
// Deliberately single-threaded, like the Shorts worker. Two imports at once on
// a 2-vCPU droplet means two multi-GB streams competing for the same disk, and
// the box is also serving the site.
import "../lib/load-env.js";   // must precede anything that reads credentials
import fs from "fs";
import os from "os";
import path from "path";
import { db } from "../lib/db.js";
import { downloadFile, driveConfigured } from "../lib/drive.js";
import { importGameFromZip } from "../lib/import.js";
import { claimNext, reapStaleStaging } from "../lib/import-queue.js";

const POLL_MS = 5000;
const watch = process.argv.includes("--watch");

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
const gb = b => b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(0) + " MB";

function finish(job, fields) {
  db().prepare(
    `UPDATE import_jobs SET status=?, game_id=?, error=?, staged_path=?,
       finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .run(fields.status, fields.game_id ?? null,
         fields.error ? String(fields.error).slice(0, 2000) : null,
         fields.staged_path ?? null, job.id);
}

async function runJob(job) {
  log(`  job ${job.id}: ${job.name} (${job.source})`);
  const t = Date.now();
  // Each job gets its own tmp dir, and it is the same shape as the two
  // request-time paths this replaces — download/stage to tmp, extract, import.
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btimport-"));
    const zipPath = path.join(tmp, "bundle.zip");

    if (job.source === "drive") {
      if (!driveConfigured()) throw new Error("Drive is not configured on this server");
      if (!job.drive_id) throw new Error("job has no Drive file id");
      await downloadFile(job.drive_id, zipPath);
      log(`    downloaded ${gb(fs.statSync(zipPath).size)}`);
      // NB: bundles are intentionally LEFT in Drive — the gen-2 ball notebook
      // re-detects each game's video from its bundle. Clear them manually.
    } else {
      if (!job.staged_path || !fs.existsSync(job.staged_path))
        throw new Error("the staged upload is gone — pick the file again");
      // Move rather than copy: the staged zip and the tmp copy would be two
      // multi-GB files for no reason, and rename is free on the same volume.
      try { fs.renameSync(job.staged_path, zipPath); }
      catch { fs.copyFileSync(job.staged_path, zipPath); fs.rmSync(job.staged_path, { force: true }); }
    }

    // From here the zip is consumed either way: importGameFromZip deletes it
    // after extracting, to free the disk the extracted bundle needs. So the
    // staged_path is cleared on both outcomes — a failed upload job cannot be
    // retried server-side, and the UI says so rather than offering a button
    // that would fail.
    const gid = await importGameFromZip(zipPath, tmp, null);
    fs.rmSync(tmp, { recursive: true, force: true });
    finish(job, { status: "done", game_id: gid });
    log(`  ✓ job ${job.id} -> game ${gid} in ${((Date.now() - t) / 1000).toFixed(0)}s`);
    return true;
  } catch (e) {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    finish(job, { status: "failed", error: e.message || e });
    log(`  ✗ job ${job.id}: ${e.message || e}`);
    return false;
  }
}

async function drain() {
  let ok = 0, bad = 0;
  for (let j = claimNext(); j; j = claimNext())
    (await runJob(j)) ? ok++ : bad++;
  return { ok, bad };
}

// A worker killed mid-import (deploy, reboot, OOM) leaves a row in
// 'importing'. Unlike a Short, this is NOT requeued automatically: an import
// mutates the DB as it goes, so the interrupted attempt may have left a
// partial game row behind and a blind retry would quietly produce a duplicate.
// Fail it loudly with the check to make instead.
const stuck = db().prepare(
  `UPDATE import_jobs SET status='failed', staged_path=NULL, error=?,
     finished_at=datetime('now'), updated_at=datetime('now')
   WHERE status='importing'`).run(
  "interrupted by a server restart — check the games list for a half-imported " +
  "copy of this bundle and delete it before retrying");
if (stuck.changes) log(`marked ${stuck.changes} import(s) interrupted by a restart`);
const stale = reapStaleStaging();
if (stale) log(`dropped ${stale} abandoned upload(s)`);

log(`worker up (drive=${driveConfigured() ? "configured" : "not configured"})`);
const { ok, bad } = await drain();
if (!watch) {
  log(ok + bad ? `imported ${ok}, failed ${bad}` : "queue empty");
  process.exit(bad ? 1 : 0);
}
log("watching for new work…");
setInterval(() => {
  reapStaleStaging();
  drain().catch(e => log("drain error:", e.message));
}, POLL_MS);
