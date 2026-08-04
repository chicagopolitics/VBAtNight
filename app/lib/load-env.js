// Load app/.env.local into process.env. Import for side effect:
//
//   import "../lib/load-env.js";
//
// Next.js reads .env.local automatically, so anything running inside the app
// gets DRIVE_FOLDER_ID, GOOGLE_OAUTH_* and friends for free. A plain
// `node scripts/whatever.mjs` does not, and the failure is confusing: the
// script reports the credentials as missing while they're sitting right
// there in the file.
//
// Real values already in the environment win, so `FOO=x npm run …` and
// systemd Environment= lines still override the file.
//
// DUPLICATE KEYS: the last line in the file wins, and a warning is printed.
// This used to be first-wins, which quietly broke credential rotation — you
// paste a fresh token at the bottom of the file, the stale line above it
// keeps being used, and the failure surfaces later as an opaque auth error
// from the remote service rather than as anything about your config. It also
// disagreed with Next.js, which reads the same file last-wins for the web
// app: the script and the site could authenticate as different tokens.
import fs from "fs";
import path from "path";

const file = process.env.ENV_FILE || path.join(process.cwd(), ".env.local");

if (fs.existsSync(file)) {
  const fromFile = new Set();
  const dupes = new Set();
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // A real environment variable still wins — but only over the file as a
    // whole, not over a later line of the same file.
    if (process.env[key] !== undefined && !fromFile.has(key)) continue;
    if (fromFile.has(key)) dupes.add(key);
    fromFile.add(key);
    // strip matching quotes, and a trailing \r from a file edited on Windows
    process.env[key] = line.slice(eq + 1).trim()
      .replace(/\r$/, "").replace(/^(['"])(.*)\1$/, "$2");
  }
  for (const k of dupes)
    console.warn(`[env] WARNING: ${k} is set more than once in ` +
      `${path.basename(file)} — using the LAST one. Delete the stale lines.`);
}
