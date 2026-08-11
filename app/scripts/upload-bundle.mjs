#!/usr/bin/env node
// Upload a processed game bundle to the shared Drive folder.
//
//   npm run upload-bundle -- C:\vb\bundles\game_bundle_g1.zip
//   npm run upload-bundle -- C:\vb\bundles\*.zip
//
// This is the local pipeline's replacement for the Colab notebook writing
// bundles straight to a mounted Drive. Once a bundle is here, the production
// app on the droplet imports it exactly as before — /api/drive lists this
// folder and streams the zip down — so nothing on the server side changes.
//
// Auth, folder resolution and upsert-by-name all come from lib/drive.js, so
// there is one implementation of "where do bundles live and who am I".
import "../lib/load-env.js";   // must precede anything that reads credentials
import fs from "fs";
import path from "path";
import { driveCanUpload, uploadLargeFile } from "../lib/drive.js";

const args = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!args.length) {
  console.error("usage: npm run upload-bundle -- <bundle.zip> [more.zip ...]");
  process.exit(2);
}
if (!driveCanUpload()) {
  console.error(
    "Drive upload is not configured.\n" +
    "  Needs GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN and\n" +
    "  DRIVE_FOLDER_ID in app/.env.local. A service account cannot upload to\n" +
    "  a personal Drive — see app/DRIVE-SETUP.md.\n" +
    "  If the refresh token is rejected (invalid_grant), re-run: npm run drive-auth");
  process.exit(1);
}

const human = b => b >= 1e9 ? (b / 1e9).toFixed(2) + " GB"
                            : (b / 1e6).toFixed(0) + " MB";

let failed = 0;
for (const file of args) {
  if (!fs.existsSync(file)) {
    console.error(`  ${file}: not found`);
    failed++;
    continue;
  }
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  process.stdout.write(`${name} (${human(size)}) `);
  const t0 = Date.now();
  let lastPct = -1;
  try {
    const r = await uploadLargeFile(file, name, "application/zip", (sent, total) => {
      const pct = Math.floor((sent / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        process.stdout.write(`${pct}% `);
        lastPct = pct;
      }
    });
    const mins = (Date.now() - t0) / 60000;
    console.log(`\n  ${r.updated ? "replaced" : "uploaded"} -> ${r.id} ` +
      `in ${mins.toFixed(1)} min (${human(size / (mins * 60))}/s)`);
  } catch (e) {
    console.error(`\n  FAILED: ${e.message}`);
    // invalid_grant surfaces from Google as the unhelpful "Bad Request". It
    // means the refresh token is dead, not that the request was malformed —
    // and an OAuth app left in "testing" status expires them quickly, so this
    // is the failure you will actually hit. Say what to do about it.
    if (/auth failed|invalid_grant|Bad Request|401|403/i.test(e.message))
      console.error(
        "  -> the Drive refresh token looks dead. Re-authorise with:\n" +
        "       npm run drive-auth\n" +
        "     then put the new GOOGLE_OAUTH_REFRESH_TOKEN in app/.env.local\n" +
        "     (last duplicate wins, so appending it at the bottom works).");
    failed++;
  }
}
process.exit(failed ? 1 : 0);
