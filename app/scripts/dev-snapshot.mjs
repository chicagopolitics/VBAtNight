#!/usr/bin/env node
// `next dev` pointed at the sanitized production snapshot, on port 3001.
//
//   npm run dev:snapshot
//
// A wrapper rather than `DB_PATH=… next dev` in package.json, because npm runs
// scripts through cmd.exe on Windows, where that prefix syntax isn't a thing.
//
// Port 3001 so it runs ALONGSIDE the ordinary dev server rather than instead of
// it. Two databases reachable at once, and which one a page is showing is never
// a guess — 3000 is your working data, 3001 is the snapshot.
//
// lib/db.js already honours DB_PATH; nothing in the app changes for this.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

const require_ = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.DB_PATH || path.join(APP, "data", "prod-snapshot.db");
const PORT = process.env.PORT || "3001";

if (!fs.existsSync(DB)) {
  console.error(`no snapshot at ${DB}\n`
    + `run scripts/pull-prod-snapshot.sh first, or set DB_PATH.`);
  process.exit(1);
}

console.log(`snapshot: ${DB}\nhttp://localhost:${PORT}\n`);

// Next's CLI is loaded INTO this process rather than spawned as a child.
// Two reasons, both learned the hard way:
//   - Windows refuses to spawn the `next`/`npx` .cmd shim without a shell,
//     and going through a shell means quoting a path with spaces in it.
//   - A child outlives a parent that gets force-killed (which is exactly how
//     a preview runner stops a server), leaving an orphan holding the port
//     and serving a database you think you deleted. One process, one PID,
//     nothing to leak.
process.env.DB_PATH = DB;
process.chdir(APP);                        // next resolves config from cwd
process.argv = [process.argv[0], "next", "dev", "-p", String(PORT)];
await import(pathToFileURL(require_.resolve("next/dist/bin/next")).href);
