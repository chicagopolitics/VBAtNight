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
import { spawn } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require_ = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.DB_PATH || path.join(APP, "data", "prod-snapshot.db");

if (!fs.existsSync(DB)) {
  console.error(`no snapshot at ${DB}\n`
    + `run scripts/pull-prod-snapshot.sh first, or set DB_PATH.`);
  process.exit(1);
}

console.log(`snapshot: ${DB}\nhttp://localhost:3001\n`);
// Next's own JS entry point under this node, rather than the `next`/`npx`
// shim: Windows won't let child_process spawn a .cmd without a shell, and
// going through a shell would mean quoting a path with spaces in it.
spawn(process.execPath, [require_.resolve("next/dist/bin/next"), "dev", "-p", "3001"],
  { cwd: APP, stdio: "inherit", env: { ...process.env, DB_PATH: DB } })
  .on("exit", code => process.exit(code ?? 0));
