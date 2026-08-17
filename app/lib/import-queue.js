// Shared helpers for the bundle import queue — used by the API routes and by
// scripts/import-worker.mjs, so the two can't drift on where staged zips live
// or what a status means. Mirrors lib/shorts.js for the render queue.
//
// The queue exists to make a batch of imports DURABLE. Six bundles queued at
// 9pm keep importing whether or not the page is still open, because the only
// state that matters is `import_jobs` rows on the server. See schema.sql.
import fs from "fs";
import path from "path";
import { db } from "./db.js";

export const STATUSES = ["staging", "queued", "importing", "done", "failed"];
// Statuses that mean "the queue still owes you a game".
export const PENDING = ["staging", "queued", "importing"];

// Uploaded zips land here before the worker picks them up. Under data/ (with
// the DB) rather than public/ — these are multi-GB and must never be served,
// and os.tmpdir() is wrong because a reboot would silently empty the queue's
// backing store while the rows survived.
export function stagingDir() {
  return process.env.IMPORT_STAGING_DIR ||
    path.join(process.cwd(), "data", "staging");
}
export function stagedPath(jobId) {
  return path.join(stagingDir(), `${jobId}.zip`);
}

// An upload whose bytes stopped arriving this long ago is dead: the tab was
// closed, the laptop slept, the connection dropped. The route usually catches
// this itself (the request stream errors), but a proxy can hold a half-open
// socket for a long time and a server crash never gets to run a catch block —
// so `updated_at` going stale is the backstop that stops a 'staging' row
// sitting there forever claiming to be in progress.
export const STALE_STAGING_MS = 3 * 60 * 1000;

export function touch(id, fields = {}) {
  const cols = Object.keys(fields);
  const sql = `UPDATE import_jobs SET updated_at = datetime('now')` +
    cols.map(c => `, ${c} = ?`).join("") + ` WHERE id = ?`;
  db().prepare(sql).run(...cols.map(c => fields[c]), id);
}

// The jobs the UI shows: everything unfinished, plus recent history so a
// finished batch doesn't vanish out from under you on the next poll.
export function listJobs(doneLimit = 20) {
  const d = db();
  const pending = d.prepare(
    `SELECT * FROM import_jobs WHERE status IN ('staging','queued','importing')
     ORDER BY id`).all();
  const recent = d.prepare(
    `SELECT * FROM import_jobs WHERE status IN ('done','failed')
     ORDER BY id DESC LIMIT ?`).all(doneLimit);
  return [...pending, ...recent].map(j => ({ ...j }));
}

// Mark 'staging' rows whose upload stopped arriving. Called from the worker
// loop and from the jobs GET, so the UI self-heals even if no worker is up.
export function reapStaleStaging() {
  const d = db();
  const cutoff = new Date(Date.now() - STALE_STAGING_MS).toISOString();
  const dead = d.prepare(
    `SELECT * FROM import_jobs WHERE status = 'staging'
       AND updated_at < datetime(?)`).all(cutoff);
  for (const j of dead) {
    if (j.staged_path) fs.rmSync(j.staged_path, { force: true });
    d.prepare(
      `UPDATE import_jobs SET status='failed', staged_path=NULL, error=?,
         finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
      .run("upload stopped part-way — pick the file again to retry", j.id);
  }
  return dead.length;
}

// Take the next queued job. The claim is the conditional UPDATE, not the
// SELECT: `AND status='queued'` means only one caller can move a given row,
// so the systemd worker and a dev `npm run import-worker` can both be running
// without ever importing the same bundle twice. A lost race just tries the
// next row.
export function claimNext() {
  const d = db();
  for (;;) {
    const row = d.prepare(
      "SELECT id FROM import_jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
    if (!row) return null;
    const r = d.prepare(
      `UPDATE import_jobs SET status='importing', error=NULL,
         started_at=datetime('now'), updated_at=datetime('now')
       WHERE id = ? AND status = 'queued'`).run(row.id);
    if (r.changes)
      return { ...d.prepare("SELECT * FROM import_jobs WHERE id = ?").get(row.id) };
  }
}

// Can this failed job be retried without the browser's help? A Drive job
// always can — the bytes are still in Drive. An upload can't once its staged
// zip has been consumed: extraction deletes the zip to free disk before the
// (equally large) extracted bundle lands, so there is nothing left to retry
// from and the honest answer is "pick the file again".
export function canRequeue(job) {
  if (job.status !== "failed") return false;
  if (job.source === "drive") return true;
  return !!(job.staged_path && fs.existsSync(job.staged_path));
}
