// Stage an uploaded bundle for the import queue — organizer only.
//
//   POST /api/import/stage?name=game_bundle_x.zip&size=123   body: the raw zip
//
// This is the durability boundary for locally-picked files. A file the user
// chose exists in exactly one place — the browser — so nothing about it can
// outlive the tab until the bytes are on the server's disk. Once they are, the
// job is an ordinary queued row like a Drive one, and the page can be closed.
//
// Raw body, not FormData, for the same reason as /api/import: undici buffers
// the whole multipart body in memory and its parser fails on large uploads.
import fs from "fs";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { stagingDir, stagedPath, touch } from "@/lib/import-queue";

// How often staging progress reaches the DB. Every chunk would be thousands
// of writes on a 3 GB upload; every 2s is enough for a progress bar and is
// also the heartbeat the stale-upload reaper reads.
const PROGRESS_MS = 2000;

export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  if (!req.body) return Response.json({ error: "missing file" }, { status: 400 });

  const url = new URL(req.url);
  const name = url.searchParams.get("name") || "bundle.zip";
  const size = Number(url.searchParams.get("size")) || 0;

  const d = db();
  // The row comes first so the id can name the file, and so a refresh mid-
  // upload still shows what's happening rather than nothing at all.
  const id = Number(d.prepare(
    `INSERT INTO import_jobs (source, name, size, status)
     VALUES ('upload', ?, ?, 'staging')`).run(name, size).lastInsertRowid);
  fs.mkdirSync(stagingDir(), { recursive: true });
  const dest = stagedPath(id);
  touch(id, { staged_path: dest });

  try {
    let bytes = 0, last = 0;
    // Counting in a Transform rather than on a 'data' listener: attaching one
    // before pipeline() flips the stream into flowing mode and can drop the
    // first chunks on the floor.
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        const now = Date.now();
        if (now - last > PROGRESS_MS) { last = now; touch(id, { bytes }); }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(req.body), meter, fs.createWriteStream(dest));

    // A truncated zip that the client thought it finished would fail later, in
    // the worker, as a confusing tar error. Catch it here where "re-upload"
    // is the obvious next step.
    const got = fs.statSync(dest).size;
    if (size && got < size)
      throw new Error(`upload ended early (${got} of ${size} bytes)`);

    d.prepare(
      `UPDATE import_jobs SET status='queued', bytes=?, updated_at=datetime('now')
       WHERE id = ?`).run(got, id);
    return Response.json({ ok: true, job_id: id });
  } catch (e) {
    // Navigating away mid-upload lands here (the request stream errors), which
    // is the good case — the row resolves immediately instead of waiting on
    // the reaper. Either way the partial zip goes.
    fs.rmSync(dest, { force: true });
    d.prepare(
      `UPDATE import_jobs SET status='failed', staged_path=NULL, error=?,
         finished_at=datetime('now'), updated_at=datetime('now') WHERE id = ?`)
      .run(String(e.message || e).slice(0, 2000), id);
    console.error("stage failed:", e);
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
