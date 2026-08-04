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
import fs from "fs";
import path from "path";

const file = process.env.ENV_FILE || path.join(process.cwd(), ".env.local");

if (fs.existsSync(file)) {
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;      // don't clobber
    // strip matching quotes, and a trailing \r from a file edited on Windows
    process.env[key] = line.slice(eq + 1).trim()
      .replace(/\r$/, "").replace(/^(['"])(.*)\1$/, "$2");
  }
}
