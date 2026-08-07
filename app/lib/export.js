// Explicit .js extensions so plain-node ESM scripts (scripts/*.mjs) can
// import buildCorrections directly; Next resolves them the same either way.
import { db } from "./db.js";
import { displayName, slug } from "./game-name.js";

// Filesystem-safe stem. Shared with the export route so the filename and the
// `video_stem` field in the payload can't disagree.
export const stemOf = s => (s || "game").trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "game";

export function buildCorrections(gid) {
  const d = db();
  const game = d.prepare("SELECT * FROM games WHERE id = ?").get(gid);
  if (!game) return null;
  const identities = d.prepare(
    `SELECT id, cluster_id, name, dismissed, merged_into FROM identities WHERE game_id = ?`)
    .all(gid).map(r => ({ ...r }));   // id included: merged_into points at row ids
  const rallies = d.prepare("SELECT * FROM rallies WHERE game_id = ? ORDER BY idx")
    .all(gid).map(r => {
      const plays = d.prepare(
        `SELECT t, x, y, play_type, cluster_id, tracklet_id, corrected, deleted
         FROM plays WHERE rally_id = ? ORDER BY t`).all(r.id).map(p => ({ ...p }));
      return {
        idx: r.idx, start: r.start_s, end: r.end_s, phase: r.phase,
        outcome: r.outcome_type
          ? { type: r.outcome_type, cluster: r.outcome_cluster } : null,
        // Blind-recall completeness (ML-PLAN 0.4): 1 = the reviewer asserts
        // every real touch in this rally is present. Recall metrics and
        // derived negatives are only valid over rallies with this set —
        // elsewhere "no touch recorded" is ambiguous, not a negative.
        touches_complete: r.touches_complete ? 1 : 0,
        plays: plays.filter(p => !p.deleted).map(({ deleted, ...p }) => p),
        removed_plays: plays.filter(p => p.deleted).map(({ deleted, ...p }) => p),
      };
    });
  const nCorr = rallies.reduce((a, r) =>
    a + r.plays.filter(p => p.corrected).length + r.removed_plays.length, 0);
  return {
    // `slug` as well as `name`: corrections files get filed, diffed and
    // re-imported months later, and a stable machine key survives a rename
    // where a display string doesn't.
    game_id: +gid, name: displayName(game), slug: slug(game),
    played_on: game.played_on ?? null,
    // The stem the corrections file must be named after. NOT the display
    // name: the gen-2 ball notebook pairs corrections_<stem>.json with
    // <stem>.mp4, so this has to track the video, not the label. Falls back
    // to the legacy name for games imported before source_file existed, which
    // is exactly what those files are already called on disk.
    video_stem: stemOf(game.source_file
      ? game.source_file.replace(/\.[^.]+$/, "") : game.name),
    exported_at: new Date().toISOString(),
    review_stats: {
      corrected_or_removed: nCorr,
      outcomes_set: rallies.filter(r => r.outcome).length,
      complete_rallies: rallies.filter(r => r.touches_complete
                                            && r.phase === "game").length,
      named_identities: identities.filter(i => i.name).length,
    },
    // Which pipeline generation these labels describe. Everything in
    // `plays` that is model-relative — x/y, tracklet_id, cluster_id, and the
    // whole of removed_plays — is only valid against this exact pipeline, so
    // a training set must not pool across generations. Null means the game
    // was imported from a pre-1.0.0 bundle: EVALUATION ONLY. See ML-PLAN.md.
    pipeline: game.pipeline ? JSON.parse(game.pipeline) : null,
    identities, rallies,
  };
}
