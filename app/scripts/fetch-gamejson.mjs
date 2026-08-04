#!/usr/bin/env node
// Pull a game's game.json out of its bundle in Google Drive.
//
//   npm run fetch-gamejson              # show what's missing and what matches
//   npm run fetch-gamejson -- 17        # fetch for game 17
//   npm run fetch-gamejson -- --all     # every game still missing one
//
// WHY: importing a game used to discard game.json, so games imported before
// that was fixed have no ball track on disk and can't produce Shorts. The
// bundles are still in Drive (deliberately — the retraining notebook needs
// them), and each has game.json at its root.
//
// Downloads the whole bundle, takes the one file, deletes the zip. That is
// ~3 GB of transfer for ~9 MB of payload, which is wasteful but honest: a
// zip's index lives at the END of the file, so fetching only game.json means
// range-requesting the central directory, parsing it (with ZIP64 variants),
// then range-requesting and inflating one member. That's a few hundred lines
// of zip-format edge cases to save bandwidth on a ONE-TIME backfill of five
// games. Not worth the bugs. If this ever becomes routine, revisit.
//
// Validation and the actual install are delegated to backfill-gamejson.mjs
// so there's exactly one implementation of "is this the right file".
import "../lib/load-env.js";   // must precede anything that reads credentials
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { db } from "../lib/db.js";
import { listBundles, downloadFile, driveConfigured } from "../lib/drive.js";

const MEDIA = path.join(process.cwd(), "public", "media");
const hasJson = gid => fs.existsSync(path.join(MEDIA, String(gid), "game.json"));

// "cca one" and "game_bundle_cca-one.zip" are the same thing with different
// punctuation habits.
const norm = s => String(s).toLowerCase()
  .replace(/^game_bundle[-_ ]?/, "").replace(/\.zip$/, "")
  .replace(/[^a-z0-9]/g, "");

function matchBundle(game, bundles) {
  const g = norm(game.name);
  return bundles.find(b => norm(b.name) === g)
    || bundles.find(b => norm(b.name).includes(g) || g.includes(norm(b.name)))
    || null;
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; }
  catch { return null; }
}

if (!driveConfigured()) {
  const has = k => (process.env[k] ? "set" : "MISSING");
  console.error("Drive isn't configured. Run this from the app directory " +
    "(where .env.local lives). Currently:");
  console.error(`  cwd                        ${process.cwd()}`);
  for (const k of ["DRIVE_FOLDER_ID", "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN", "GOOGLE_SA_KEY"])
    console.error(`  ${k.padEnd(27)}${has(k)}`);
  console.error("\nSee DRIVE-SETUP.md.");
  process.exit(1);
}

const args = process.argv.slice(2);
const wantAll = args.includes("--all");
const wantId = args.find(a => /^\d+$/.test(a));

const games = db().prepare("SELECT id, name FROM games ORDER BY id").all();
console.log("Listing bundles in Drive…");
const bundles = await listBundles();
if (!bundles.length) {
  console.error("No .zip bundles found in the Drive folder.");
  process.exit(1);
}

const plan = games.map(g => ({ game: g, bundle: matchBundle(g, bundles),
  have: hasJson(g.id) }));

if (!wantAll && !wantId) {
  console.log("\ngame  json?  name              bundle in Drive");
  for (const p of plan)
    console.log(String(p.game.id).padEnd(6) + (p.have ? "yes  " : "NO   ").padEnd(7) +
      String(p.game.name).padEnd(18) +
      (p.bundle ? `${p.bundle.name} (${(p.bundle.size / 1e9).toFixed(1)} GB)`
                : "— no match, fetch by hand"));
  console.log("\nFetch one:  npm run fetch-gamejson -- <game id>");
  console.log("Fetch all missing:  npm run fetch-gamejson -- --all");
  process.exit(0);
}

const todo = wantAll ? plan.filter(p => !p.have && p.bundle)
                     : plan.filter(p => String(p.game.id) === wantId);
if (!todo.length) { console.error("Nothing to do."); process.exit(1); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vbjson-"));
let failures = 0;
try {
  for (const { game, bundle } of todo) {
    if (!bundle) {
      console.error(`✗ game ${game.id} "${game.name}": no bundle in Drive matches ` +
        `that name. Fetch it by hand and use backfill-gamejson.mjs.`);
      failures++; continue;
    }
    const free = freeBytes(tmpDir);
    if (free !== null && free < bundle.size * 1.1) {
      console.error(`✗ game ${game.id}: needs ~${(bundle.size / 1e9).toFixed(1)} GB free, ` +
        `only ${(free / 1e9).toFixed(1)} GB available. Free some space first.`);
      failures++; continue;
    }

    const zip = path.join(tmpDir, `${game.id}.zip`);
    console.log(`\n[game ${game.id} "${game.name}"] downloading ${bundle.name} ` +
      `(${(bundle.size / 1e9).toFixed(1)} GB)…`);
    const t = Date.now();
    try {
      await downloadFile(bundle.id, zip);
    } catch (e) {
      console.error(`✗ download failed: ${e.message}`);
      fs.rmSync(zip, { force: true }); failures++; continue;
    }
    console.log(`  downloaded in ${((Date.now() - t) / 1000).toFixed(0)}s, ` +
      `extracting game.json…`);

    // system tar is bsdtar on Ubuntu via libarchive-tools; it reads zips and
    // can pull a single member. Extract ONLY game.json — the bundle also
    // holds the multi-GB video we emphatically do not want on disk again.
    let ok = false;
    for (const bin of ["bsdtar", "tar"]) {
      const r = spawnSync(bin, ["-xf", zip, "-C", tmpDir, "game.json"]);
      if (!r.error && r.status === 0) { ok = true; break; }
    }
    const extracted = path.join(tmpDir, "game.json");
    if (!ok || !fs.existsSync(extracted)) {
      const r = spawnSync("unzip", ["-o", "-j", zip, "game.json", "-d", tmpDir]);
      ok = !r.error && r.status === 0 && fs.existsSync(extracted);
    }
    fs.rmSync(zip, { force: true });          // reclaim the 3 GB immediately
    if (!ok) {
      console.error(`✗ couldn't extract game.json from ${bundle.name} ` +
        `(need bsdtar or unzip installed)`);
      failures++; continue;
    }

    const staged = path.join(tmpDir, `${game.id}.json`);
    fs.renameSync(extracted, staged);

    // Hand off to backfill-gamejson for validation + install, so "is this the
    // right file" has exactly one implementation.
    const r = spawnSync(process.execPath,
      [path.join(process.cwd(), "scripts", "backfill-gamejson.mjs"),
       String(game.id), staged],
      { stdio: "inherit" });
    fs.rmSync(staged, { force: true });
    if (r.status !== 0) failures++;
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(failures ? `\nDone, with ${failures} failure(s).`
                     : `\nDone. Render one clip from each game to confirm.`);
process.exit(failures ? 1 : 0);
