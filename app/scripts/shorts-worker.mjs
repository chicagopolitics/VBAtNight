#!/usr/bin/env node
// Renders queued Shorts. The `shorts` table is the queue; this drains it.
//
//   npm run shorts-worker            # drain once and exit (good for testing)
//   npm run shorts-worker -- --watch # stay running (what systemd uses)
//
// Why a worker at all: a 20-second Short is 1-2 minutes of ffmpeg + OpenCV on
// a 2-vCPU droplet. An HTTP request can't hold that, so the UI queues and
// this renders.
//
// Deliberately single-threaded. Two renders on 2 vCPUs is slower than one
// after one, and the box is also serving the site.
//
// Needs python3 with numpy + opencv-python-headless, and ffmpeg on PATH.
// Point SHORTS_PYTHON at a venv interpreter if the system python lacks them
// (deploy/01-setup-server.sh creates one).
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { db } from "../lib/db.js";
import { shortsDir, shortPath, shortUrl, renderInputs, rallyRef } from "../lib/shorts.js";

const PY = process.env.SHORTS_PYTHON || "python3";
// x264 preset. "fast" rather than the library default "medium": the droplet
// has 2 vCPUs and is also serving the site, and at 1080x1920 the quality
// difference is invisible on a phone while the time difference is minutes.
const PRESET = process.env.SHORTS_PRESET || "fast";
const PIPELINE = process.env.PIPELINE_DIR ||
  path.resolve(process.cwd(), "..", "pipeline");
const POLL_MS = 5000;
const watch = process.argv.includes("--watch");

// A render that hangs would wedge the queue forever; a render that takes ten
// minutes is already wrong. Cap it.
const TIMEOUT_MS = Number(process.env.SHORTS_TIMEOUT_MS || 15 * 60 * 1000);

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

function claim() {
  const d = db();
  // Mark 'rendering' immediately so a second worker (or a restarted one)
  // can't pick up the same row.
  const row = d.prepare(
    "SELECT * FROM shorts WHERE status = 'queued' ORDER BY id LIMIT 1").get();
  if (!row) return null;
  d.prepare("UPDATE shorts SET status='rendering', error=NULL WHERE id=?").run(row.id);
  return row;
}

function fail(short, msg) {
  log(`  ✗ short ${short.id}: ${msg}`);
  db().prepare("UPDATE shorts SET status='failed', error=? WHERE id=?")
    .run(String(msg).slice(0, 2000), short.id);
}

function run(cmd, args, cwd) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd });
    let err = "", out = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); err += "\n[worker] timed out"; },
      TIMEOUT_MS);
    p.stdout.on("data", b => { out += b; });
    p.stderr.on("data", b => { err += b; });
    p.on("error", e => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    p.on("close", code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function render(short) {
  const d = db();
  const game = d.prepare("SELECT * FROM games WHERE id = ?").get(short.game_id);
  const rally = d.prepare("SELECT * FROM rallies WHERE id = ?").get(short.rally_id);
  if (!game || !rally) return fail(short, "game or rally disappeared");

  const { video, json, hasVideo, hasJson } = renderInputs(game);
  // Re-check rather than trusting the queue: the local video may have been
  // reclaimed between queueing and rendering.
  if (!hasVideo) return fail(short, "local video is gone (reclaimed?)");
  if (!hasJson) return fail(short,
    `no game.json — run: node scripts/backfill-gamejson.mjs ${game.id} <path>`);

  fs.mkdirSync(shortsDir(game.id), { recursive: true });
  const out = shortPath(game.id, short.id);
  // A render killed part-way (deploy, reboot, OOM) leaves the pre-mux
  // intermediate behind. Clear both before retrying, or a stale file could
  // be mistaken for a successful render.
  for (const stale of [out, out + ".silent.mp4"]) fs.rmSync(stale, { force: true });
  // the play this Short is about, if any — turns the window into a moment
  const play = short.play_id
    ? d.prepare("SELECT * FROM plays WHERE id = ?").get(short.play_id) : null;
  if (short.play_id && !play)
    return fail(short, "the anchor play was deleted — requeue or remove this short");

  // The REVIEWED touches for this rally — deleted ones excluded. This is the
  // list the lead-in is counted through, and it must not be game.json's.
  const contacts = d.prepare(
    `SELECT t FROM plays WHERE rally_id = ? AND deleted = 0 AND play_type IS NOT NULL
     ORDER BY t`).all(rally.id).map(p => +(+p.t).toFixed(2));

  const args = ["-m", "vbpipe.shorts", video, "-g", json, "-o", out,
    ...rallyRef(rally, short, play, contacts), "--zoom", String(short.zoom ?? 1.0),
    "--preset", PRESET];
  if (short.caption) args.push("--caption", short.caption);
  if (short.subcaption) args.push("--subcaption", short.subcaption);

  log(`  short ${short.id}: ${play ? `${play.play_type || "play"} @${play.t}s` : "whole rally"}` +
    ` in rally ${rally.idx} of "${game.name}" -> ${path.basename(out)}`);
  const t = Date.now();
  const r = await run(PY, args, PIPELINE);
  if (r.code !== 0)
    return fail(short, (r.err || r.out || `exit ${r.code}`).trim().split("\n").slice(-6).join("\n"));
  if (!fs.existsSync(out) || fs.statSync(out).size < 10_000)
    return fail(short, "renderer exited 0 but produced no usable file");

  d.prepare("UPDATE shorts SET status='ready', file=?, rendered_at=? WHERE id=?")
    .run(shortUrl(game.id, short.id), new Date().toISOString(), short.id);
  log(`  ✓ short ${short.id} ready in ${((Date.now() - t) / 1000).toFixed(0)}s ` +
    `(${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}

async function drain() {
  let n = 0;
  for (let s = claim(); s; s = claim()) { await render(s); n++; }
  return n;
}

// A worker killed mid-render leaves a row stuck in 'rendering' forever.
// Reclaim those on startup — nothing else is holding them.
const stuck = db().prepare(
  "UPDATE shorts SET status='queued' WHERE status='rendering'").run();
if (stuck.changes) log(`requeued ${stuck.changes} short(s) left mid-render`);

log(`worker up (python=${PY}, pipeline=${PIPELINE})`);
const n = await drain();
if (!watch) {
  log(n ? `rendered ${n}` : "queue empty");
  process.exit(0);
}
log("watching for new work…");
setInterval(() => { drain().catch(e => log("drain error:", e.message)); }, POLL_MS);
