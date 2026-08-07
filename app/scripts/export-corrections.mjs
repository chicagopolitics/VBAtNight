#!/usr/bin/env node
// Export a reviewed game as a labeled dataset for pipeline evaluation/training.
// Usage: node scripts/export-corrections.mjs <game_id> [out.json]
//
// Thin wrapper around lib/export.js buildCorrections — the SAME builder the
// app's export route uses, so the CLI can never drift from it again. (Its
// predecessor duplicated the queries inline and had already gone stale:
// missing slug, played_on, video_stem and the pipeline stamp, and writing a
// corrections_game<id>.json filename that broke the stem-pairing contract
// eval_corrections.py depends on.)
import fs from "fs";
import { buildCorrections } from "../lib/export.js";

const [, , gid, outPath] = process.argv;
if (!gid) {
  console.error("usage: export-corrections.mjs <game_id> [out.json]");
  process.exit(1);
}
const data = buildCorrections(gid);
if (!data) { console.error("no such game"); process.exit(1); }
const fp = outPath || `corrections_${data.video_stem}.json`;
fs.writeFileSync(fp, JSON.stringify(data, null, 1));
const s = data.review_stats;
console.log(`wrote ${fp}: ${data.rallies.length} rallies, ` +
  `${s.corrected_or_removed} corrections, ${s.outcomes_set} outcomes, ` +
  `${s.complete_rallies} complete, ${s.named_identities} named players`);
