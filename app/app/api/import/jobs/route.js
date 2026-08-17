// The import queue — organizer only.
//
//   GET     current queue + recent history (the import page polls this)
//   POST    queue Drive bundles: { drive_ids: [...] }
//   PATCH   { id, requeue: true } — retry a failed job
//   DELETE  { id } — drop a job (and its staged zip)
//
// Importing itself happens in scripts/import-worker.mjs. Nothing here does any
// of the work: a bundle is minutes of downloading and unzipping multi-GB
// video, so the request just writes 'queued' rows and returns. That's also
// what makes the queue survive a refresh — the page holds no state worth
// losing. Uploads are staged by the sibling route, /api/import/stage.
import fs from "fs";
import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { listJobs, reapStaleStaging, canRequeue } from "@/lib/import-queue";
import { driveConfigured } from "@/lib/drive";

async function guard() { return isOrganizer(await getSessionUser()); }

export async function GET() {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  // Reap here as well as in the worker so a dead upload resolves itself even
  // when no worker is running — otherwise a dev box with the site up and the
  // worker down shows an "uploading…" row that will never move.
  reapStaleStaging();
  return Response.json({ ok: true, jobs: listJobs() });
}

export async function POST(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!driveConfigured())
    return Response.json({ error: "Drive is not configured" }, { status: 400 });
  const { files } = await req.json();          // [{ id, name, size }]
  if (!Array.isArray(files) || !files.length)
    return Response.json({ error: "no files given" }, { status: 400 });

  const d = db();
  const queued = [], skipped = [];
  for (const f of files) {
    if (!f?.id) continue;
    // Queueing the same bundle twice would import the same night twice, and
    // the second copy is only obvious later, on the games list. Refuse while
    // one is still pending; a finished job is NOT a bar, because re-importing
    // a bundle after deleting a bad game is a real thing to want.
    const dup = d.prepare(
      `SELECT id, status FROM import_jobs WHERE drive_id = ?
         AND status IN ('staging','queued','importing')`).get(f.id);
    if (dup) { skipped.push({ name: f.name, reason: `already ${dup.status}` }); continue; }
    const id = d.prepare(
      `INSERT INTO import_jobs (source, drive_id, name, size)
       VALUES ('drive', ?, ?, ?)`)
      .run(f.id, f.name || f.id, Number(f.size) || 0).lastInsertRowid;
    queued.push(Number(id));
  }
  return Response.json({ ok: true, queued, skipped, jobs: listJobs() });
}

export async function PATCH(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, requeue } = await req.json();
  const d = db();
  const job = d.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id);
  if (!job) return Response.json({ error: "no such job" }, { status: 404 });
  if (!requeue) return Response.json({ error: "nothing to do" }, { status: 400 });
  if (job.status !== "failed")
    return Response.json({ error: `job is ${job.status}, not failed` }, { status: 409 });
  if (!canRequeue(job))
    return Response.json(
      { error: "the uploaded zip was consumed by the failed attempt — pick the file again" },
      { status: 409 });
  d.prepare(
    `UPDATE import_jobs SET status='queued', error=NULL, started_at=NULL,
       finished_at=NULL, updated_at=datetime('now') WHERE id = ?`).run(id);
  return Response.json({ ok: true, jobs: listJobs() });
}

export async function DELETE(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await req.json();
  const d = db();
  const job = d.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id);
  if (!job) return Response.json({ error: "no such job" }, { status: 404 });
  // Mid-import there is a half-written game and half-moved video on disk;
  // deleting the row would just hide that. Same rule as a rendering Short.
  if (job.status === "importing")
    return Response.json({ error: "it's importing right now — wait for it" },
      { status: 409 });
  if (job.staged_path) fs.rmSync(job.staged_path, { force: true });
  d.prepare("DELETE FROM import_jobs WHERE id = ?").run(id);
  // Removing a job never touches the game it produced — that's the games
  // list's job, and deleting media from here would be a nasty surprise.
  return Response.json({ ok: true, jobs: listJobs() });
}
