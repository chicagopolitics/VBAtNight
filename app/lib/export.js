import { db } from "./db";

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
        plays: plays.filter(p => !p.deleted).map(({ deleted, ...p }) => p),
        removed_plays: plays.filter(p => p.deleted).map(({ deleted, ...p }) => p),
      };
    });
  const nCorr = rallies.reduce((a, r) =>
    a + r.plays.filter(p => p.corrected).length + r.removed_plays.length, 0);
  return {
    game_id: +gid, name: game.name, exported_at: new Date().toISOString(),
    review_stats: {
      corrected_or_removed: nCorr,
      outcomes_set: rallies.filter(r => r.outcome).length,
      named_identities: identities.filter(i => i.name).length,
    },
    identities, rallies,
  };
}
