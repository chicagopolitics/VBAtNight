import { Suspense } from "react";
import { db } from "@/lib/db";
import { deriveGrades, teamMap } from "@/lib/grades";
import Highlights from "./ui";
export const dynamic = "force-dynamic";

export default async function Watch() {
  // public: anyone can watch published games
  const d = db();
  const games = d.prepare("SELECT * FROM games WHERE published = 1 ORDER BY id DESC")
    .all().map(g => ({ ...g }));
  const data = games.map(g => {
    // per-game name resolution (cluster ids are game-local)
    const idents = d.prepare(
      `SELECT cluster_id, team, name IS NOT NULL AS named,
              COALESCE(name, 'P' || cluster_id) AS name FROM identities
       WHERE game_id = ? AND dismissed = 0 AND merged_into IS NULL`).all(g.id);
    const names = new Map(idents.map(i => [i.cluster_id, i.name]));
    const teams = teamMap(idents);
    const rallies = d.prepare(
      `SELECT r.*, i.name AS outcome_name FROM rallies r
       LEFT JOIN identities i ON i.game_id = r.game_id AND i.cluster_id = r.outcome_cluster
         AND i.dismissed = 0 AND i.merged_into IS NULL
       WHERE r.game_id = ? AND r.phase = 'game'
       ORDER BY r.start_s`).all(g.id).map(r => ({ ...r }));
    const touches = d.prepare(
      `SELECT p.id, p.rally_id, p.t, p.play_type, p.cluster_id, p.grade FROM plays p
       JOIN rallies r ON r.id = p.rally_id
       WHERE r.game_id = ? AND p.deleted = 0 AND p.play_type IS NOT NULL
       ORDER BY p.t`).all(g.id);
    const byRally = new Map();
    for (const t of touches) {
      if (!byRally.has(t.rally_id)) byRally.set(t.rally_id, []);
      byRally.get(t.rally_id).push({ ...t });
    }
    // named players per team for the collapsed game card (unnamed
    // auto-detected clusters are noise, so they're left off the roster)
    const roster = t => idents.filter(i => i.named && i.team === t).map(i => i.name);
    return { id: g.id, name: g.name, video_file: g.video_file,
      date: g.created_at?.slice(0, 10) ?? null,
      teamA: roster("A"), teamB: roster("B"),
      others: idents.filter(i => i.named && i.team !== "A" && i.team !== "B")
        .map(i => i.name),
      rallies: rallies.map(r => {
        // same derivation as the stats page, so leaderboard counts and the
        // clips a stat links to always agree
        const rows = byRally.get(r.id) || [];
        const grades = deriveGrades(rows, r, teams);
        return { ...r, touches: rows.map(t => ({ t: t.t, type: t.play_type,
          name: names.get(t.cluster_id) || null,
          grade: grades.get(t.id) || null })) };
      }) };
  });
  return <Suspense><Highlights games={data} /></Suspense>;
}
