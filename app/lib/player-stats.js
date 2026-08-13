// Per-player counters from rallies + graded touches.
//
// Lifted out of app/stats/page.js so the recap page at /p/<slug>/<date> counts
// a night the SAME way the leaderboard does. This codebase already treats that
// divergence as a bug — app/watch/page.js carries the note "same derivation as
// the stats page, so leaderboard counts and the clips a stat links to always
// agree" — and a recap is the worst possible place to disagree: it's the one
// view a player reads about themselves, next to a link to the board it should
// match.
//
// Pure. Callers do their own scoping (a day, a game, everything) by choosing
// which rows to pass in; nothing here knows what a session is.

import { deriveGrades, teamMap } from "./grades";

const EMPTY = () => ({
  serve: 0, receive: 0, dig: 0, set: 0, attack: 0, block: 0,
  kill: 0, atkErr: 0, blocked: 0, ace: 0, srvErr: 0, stuff: 0,
  assist: 0, setErr: 0, digOk: 0, digErr: 0, recPos: 0, recErr: 0,
});

/** The attempt/point columns, so "did they do anything?" has one definition. */
export const isActive = p =>
  p.serve + p.receive + p.dig + p.set + p.attack + p.block +
  p.kill + p.ace + p.stuff > 0;

/**
 * @param rallies [{ id, game_id, outcome_type, outcome_cluster }]
 * @param plays   [{ id, rally_id, t, play_type, cluster_id, grade }] (t-ordered)
 * @param idents  [{ game_id, cluster_id, team, player_id, name }]
 * @returns rows keyed `pid:<id>` for linked players, `name:<name>` otherwise
 *
 * Points and faults come from rally OUTCOMES (ground truth, robust to a missed
 * touch); attempts and quality come from the graded touches.
 */
export function aggregate(rallies, plays, idents) {
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

  const players = {};
  const P = (gameId, cid) => {
    if (cid == null) return null;
    const info = identInfo.get(`${gameId}:${cid}`);
    if (!info) return null;   // dismissed / merged-away cluster
    players[info.key] ??= { key: info.key, name: info.name, games: new Set(), ...EMPTY() };
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

  return Object.values(players)
    .map(p => ({ ...p, games: p.games.size }))
    .filter(isActive);
}
