import { db } from "@/lib/db";
import { deriveGrades, teamMap } from "@/lib/grades";
import Boards from "./ui";
export const dynamic = "force-dynamic";

export default async function Stats() {
  // public: stats cover published games only (enforced in the queries below)
  const d = db();

  // published games, game-phase rallies, with per-game identity resolution
  const rallies = d.prepare(`
    SELECT r.id, r.game_id, r.outcome_type, r.outcome_cluster
    FROM rallies r JOIN games g ON g.id = r.game_id AND g.published = 1
    WHERE r.phase = 'game'`).all().map(r => ({ ...r }));
  const plays = d.prepare(`
    SELECT p.id, p.rally_id, p.t, p.play_type, p.cluster_id, p.grade
    FROM plays p
    JOIN rallies r ON r.id = p.rally_id AND r.phase = 'game'
    JOIN games g ON g.id = r.game_id AND g.published = 1
    WHERE p.deleted = 0
    ORDER BY p.t`).all().map(p => ({ ...p }));
  const idents = d.prepare(`
    SELECT i.game_id, i.cluster_id, i.team, i.player_id,
           COALESCE(i.name, 'P' || i.cluster_id) AS name
    FROM identities i
    JOIN games g ON g.id = i.game_id AND g.published = 1
    WHERE i.dismissed = 0 AND i.merged_into IS NULL`).all().map(i => ({ ...i }));

  const rallyById = new Map(rallies.map(r => [r.id, r]));
  const byRally = new Map();
  for (const p of plays) {
    if (!byRally.has(p.rally_id)) byRally.set(p.rally_id, []);
    byRally.get(p.rally_id).push(p);
  }
  // aggregation key: a linked player unifies across games (pid:<id>); unlinked
  // identities fall back to name-dedup (old behavior) so nothing regresses.
  const identInfo = new Map(idents.map(i => [`${i.game_id}:${i.cluster_id}`,
    { key: i.player_id != null ? `pid:${i.player_id}` : `name:${i.name}`, name: i.name }]));
  // per-game team maps (identities are per-game, so cluster ids don't collide)
  const teamsByGame = new Map();
  for (const i of idents) {
    if (!teamsByGame.has(i.game_id)) teamsByGame.set(i.game_id, []);
    teamsByGame.get(i.game_id).push(i);
  }
  for (const [gid, list] of teamsByGame) teamsByGame.set(gid, teamMap(list));

  // per-player counters, keyed by the durable player (or name for unlinked)
  const players = {};
  const P = (gameId, cid) => {
    if (cid == null) return null;
    const info = identInfo.get(`${gameId}:${cid}`);
    if (!info) return null;   // dismissed / merged-away cluster
    players[info.key] ??= { key: info.key, name: info.name, games: new Set(),
      serve: 0, receive: 0, dig: 0, set: 0, attack: 0, block: 0,
      kill: 0, atkErr: 0, blocked: 0, ace: 0, srvErr: 0, stuff: 0,
      assist: 0, setErr: 0, digOk: 0, digErr: 0, recPos: 0, recErr: 0 };
    players[info.key].games.add(gameId);
    return players[info.key];
  };

  for (const [rid, touches] of byRally) {
    const rally = rallyById.get(rid);
    if (!rally) continue;
    const grades = deriveGrades(touches, rally, teamsByGame.get(rally.game_id));
    for (const t of touches) {
      const p = P(rally.game_id, t.cluster_id);
      if (!p || !t.play_type) continue;
      p[t.play_type] = (p[t.play_type] || 0) + 1;
      const g = grades.get(t.id);
      if (t.play_type === "attack" && g === "blocked") p.blocked++;
      if (t.play_type === "set" && g === "assist") p.assist++;
      if (t.play_type === "set" && g === "error") p.setErr++;
      if (t.play_type === "dig" && g === "success") p.digOk++;
      if (t.play_type === "dig" && g === "error") p.digErr++;
      if (t.play_type === "receive" && g === "positive") p.recPos++;
      if (t.play_type === "receive" && g === "error") p.recErr++;
    }
  }
  // points + faults come from rally outcomes (ground truth, robust to a
  // missed touch); attempts + quality come from graded touches above
  for (const r of rallies) {
    if (!r.outcome_type) continue;
    const p = P(r.game_id, r.outcome_cluster);
    if (!p) continue;
    if (r.outcome_type === "kill") p.kill++;
    else if (r.outcome_type === "attack_error") p.atkErr++;
    else if (r.outcome_type === "ace") p.ace++;
    else if (r.outcome_type === "service_error") p.srvErr++;
    else if (r.outcome_type === "block") p.stuff++;
  }

  const rows = Object.values(players)
    .map(p => ({ ...p, games: p.games.size }))
    .filter(p => p.serve + p.receive + p.dig + p.set + p.attack + p.block +
                 p.kill + p.ace + p.stuff > 0);

  return <Boards rows={rows}
    nGames={new Set(rallies.map(r => r.game_id)).size}
    nScored={rallies.filter(r => r.outcome_type).length} />;
}
