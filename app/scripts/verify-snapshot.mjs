#!/usr/bin/env node
// Assert that a database file carries no credentials and no real contact
// details, then describe what it does contain.
//
//   node scripts/verify-snapshot.mjs [path]     (default data/prod-snapshot.db)
//
// pull-prod-snapshot.sh already runs the same assertions on the droplet before
// letting the file leave. This is the second gate, on the file that actually
// landed — the remote check can only vouch for what it produced, not for what
// arrived, and a snapshot pulled months ago by other means gets no check at
// all unless one lives here.
//
// Writes nothing. Safe to run against production.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require_ = createRequire(import.meta.url);

const DB_PATH = process.argv[2]
  || process.env.DB_PATH
  || path.join(process.cwd(), "data", "prod-snapshot.db");
if (!fs.existsSync(DB_PATH)) {
  console.error(`no database at ${DB_PATH}`);
  process.exit(1);
}
let db;
try { db = new (require_("better-sqlite3"))(DB_PATH, { readonly: true }); }
catch { db = new (require_("node:sqlite").DatabaseSync)(DB_PATH, { readOnly: true }); }

const one = sql => Object.values(db.prepare(sql).get() ?? {})[0] ?? 0;
const tables = new Set(db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));

// Each check is "how many rows should not be here". A missing table counts as
// a pass — an older schema can't leak a column it never had.
const CHECKS = [
  ["sessions emptied", "sessions",
    "SELECT COUNT(*) FROM sessions"],
  ["auth_tokens emptied", "auth_tokens",
    "SELECT COUNT(*) FROM auth_tokens"],
  ["page_views emptied", "page_views",
    "SELECT COUNT(*) FROM page_views"],
  ["users.email scrubbed", "users",
    "SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@example.invalid'"],
  ["recaps.email scrubbed", "recaps",
    "SELECT COUNT(*) FROM recaps WHERE email NOT LIKE '%@example.invalid'"],
  ["recaps.error cleared", "recaps",
    "SELECT COUNT(*) FROM recaps WHERE error IS NOT NULL"],
];

console.log(`snapshot: ${DB_PATH}\n`);
let failed = 0;
for (const [label, table, sql] of CHECKS) {
  if (!tables.has(table)) { console.log(`  --  ${label} (no ${table} table)`); continue; }
  const bad = one(sql);
  console.log(`  ${bad === 0 ? "ok" : "!!"}  ${label}${bad ? ` — ${bad} row(s)` : ""}`);
  if (bad !== 0) failed++;
}

if (failed) {
  console.error(`\n${failed} check(s) FAILED — this file still carries live credentials or `
    + `real addresses.\nDelete it and re-run pull-prod-snapshot.sh.`);
  process.exit(1);
}

// --- what actually arrived --------------------------------------------------
console.log("\ncontents");
for (const t of ["games", "rallies", "plays", "identities", "players", "users",
                 "tracklets", "shorts", "recaps"]) {
  if (tables.has(t)) console.log(`  ${t.padEnd(12)} ${one(`SELECT COUNT(*) FROM ${t}`)}`);
}
const nights = db.prepare(
  `SELECT played_on AS day, COUNT(*) AS games FROM games
   WHERE published = 1 AND played_on IS NOT NULL
   GROUP BY played_on ORDER BY played_on DESC`).all();
console.log(`\n${nights.length} published night(s)`
  + (nights.length ? `, newest ${nights[0].day} (${nights[0].games} game(s))` : ""));
