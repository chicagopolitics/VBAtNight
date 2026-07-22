import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
import PlayersAdmin from "./ui";
export const dynamic = "force-dynamic";

// normalized name for duplicate detection: lowercase, trimmed, trailing count
// suffix stripped ("Julio 2" -> "julio") so hand-disambiguated dupes surface.
const norm = s => s.toLowerCase().trim().replace(/\s+\d+$/, "").replace(/\s+/g, " ");
function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 1) return 2;          // we only care about <= 1
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const t = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return dp[m];
}

export default async function Page() {
  if (!isOrganizer(await getSessionUser())) redirect("/login");
  const d = db();
  const players = d.prepare(
    `SELECT id, display_name FROM players ORDER BY display_name COLLATE NOCASE`)
    .all().map(p => ({ ...p }));
  const idents = d.prepare(
    `SELECT i.id, i.player_id, i.game_id, i.cluster_id, i.rep_crops, g.name AS game_name
     FROM identities i JOIN games g ON g.id = i.game_id
     WHERE i.player_id IS NOT NULL AND i.dismissed = 0 AND i.merged_into IS NULL`)
    .all().map(i => {
      let crop = null;
      try { crop = JSON.parse(i.rep_crops)?.[0] ?? null; } catch {}
      return { id: i.id, player_id: i.player_id, game_id: i.game_id,
        cluster_id: i.cluster_id, game_name: i.game_name, crop };
    });

  // per (game, cluster) touches and points, keyed to identities below
  const touchRows = d.prepare(
    `SELECT r.game_id, p.cluster_id, COUNT(*) n FROM plays p
     JOIN rallies r ON r.id = p.rally_id
     WHERE p.deleted = 0 AND p.cluster_id IS NOT NULL
     GROUP BY r.game_id, p.cluster_id`).all();
  const pointRows = d.prepare(
    `SELECT game_id, outcome_cluster AS cluster_id, COUNT(*) n FROM rallies
     WHERE outcome_type IN ('kill','ace','block') AND outcome_cluster IS NOT NULL
     GROUP BY game_id, outcome_cluster`).all();
  const touchMap = new Map(touchRows.map(r => [`${r.game_id}:${r.cluster_id}`, r.n]));
  const pointMap = new Map(pointRows.map(r => [`${r.game_id}:${r.cluster_id}`, r.n]));

  const byPlayer = {};
  for (const p of players) byPlayer[p.id] = [];
  for (const i of idents) {
    i.touches = touchMap.get(`${i.game_id}:${i.cluster_id}`) || 0;
    i.points = pointMap.get(`${i.game_id}:${i.cluster_id}`) || 0;
    (byPlayer[i.player_id] ??= []).push(i);
  }
  const rows = players.map(p => {
    const list = byPlayer[p.id] || [];
    return { ...p, identities: list, games: new Set(list.map(i => i.game_id)).size,
      touches: list.reduce((s, i) => s + i.touches, 0),
      points: list.reduce((s, i) => s + i.points, 0) };
  });

  // candidate duplicates: exact normalized-name match, or a 1-char typo. Only
  // suggestions — the organizer confirms each merge.
  const dupes = [];
  for (let a = 0; a < rows.length; a++)
    for (let b = a + 1; b < rows.length; b++) {
      const na = norm(rows[a].display_name), nb = norm(rows[b].display_name);
      let reason = null;
      if (na === nb) reason = "same name";
      else if (lev(rows[a].display_name.toLowerCase(),
        rows[b].display_name.toLowerCase()) <= 1) reason = "similar name";
      if (reason) dupes.push({ a: rows[a].id, b: rows[b].id, reason });
    }

  return <PlayersAdmin players={rows} dupes={dupes} />;
}
