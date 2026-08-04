import { Suspense } from "react";
import { db } from "@/lib/db";
import { deriveGrades, teamMap } from "@/lib/grades";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { blockedReason } from "@/lib/shorts";
import Highlights from "./ui";
export const dynamic = "force-dynamic";

export default async function Watch() {
  // public: anyone can watch published games
  const d = db();
  // ...but an organizer gets Shorts controls on the same page. This is where
  // the browsing tools already are (player + stat filters, outcome pills), so
  // hunting for clip-worthy rallies belongs here rather than in a second,
  // duplicate browser somewhere in the admin area.
  const admin = isOrganizer(await getSessionUser());
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
    // derived score: kill/ace/block = point for that player's team, errors
    // hand the point to the opponent. Approximate when an outcome belongs to
    // a player with no team assignment (that rally can't be counted).
    let ptsA = 0, ptsB = 0, uncounted = 0;
    for (const r of rallies) {
      if (!r.outcome_type) continue;
      const t = teams?.get(r.outcome_cluster);
      if (!t) { uncounted++; continue; }
      const wins = ["kill", "ace", "block"].includes(r.outcome_type);
      if ((wins ? t : t === "A" ? "B" : "A") === "A") ptsA++; else ptsB++;
    }
    const score = teams && ptsA + ptsB > 0
      ? { A: ptsA, B: ptsB, approx: uncounted > 0 } : null;
    // Shorts state, admin only — a public visitor gets none of this in their
    // payload, not merely a hidden button.
    const shorts = admin
      ? d.prepare("SELECT * FROM shorts WHERE game_id = ? ORDER BY id").all(g.id)
        .map(s => ({ ...s })) : [];
    return { id: g.id, name: g.name, video_file: g.video_file,
      // playback source resolution happens in lib/video-source.js — it needs
      // the YouTube export state as well as the local path
      yt_video_id: g.yt_video_id ?? null, media_state: g.media_state ?? "local",
      ...(admin ? { shorts, shorts_done: !!g.shorts_done,
        shorts_blocked: blockedReason(g) } : {}),
      date: g.created_at?.slice(0, 10) ?? null, score,
      teamA: roster("A"), teamB: roster("B"),
      others: idents.filter(i => i.named && i.team !== "A" && i.team !== "B")
        .map(i => i.name),
      rallies: rallies.map(r => {
        // same derivation as the stats page, so leaderboard counts and the
        // clips a stat links to always agree
        const rows = byRally.get(r.id) || [];
        const grades = deriveGrades(rows, r, teams);
        return { ...r, touches: rows.map(t => ({ t: t.t, type: t.play_type,
          // the play id is what a Short anchors on (admin only — a public
          // visitor has no use for it and shouldn't be handed row ids)
          ...(admin ? { id: t.id } : {}),
          name: names.get(t.cluster_id) || null,
          grade: grades.get(t.id) || null })) };
      }) };
  });
  return <Suspense><Highlights games={data} admin={admin} /></Suspense>;
}
