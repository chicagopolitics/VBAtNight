// Sanity-check the leaderboard derivation against the live DB (read-only).
// Usage: node scripts/verify-boards.mjs [--all]  (--all ignores published flag)
import { DatabaseSync } from "node:sqlite";
import { deriveGrades } from "../lib/grades.js";

const all = process.argv.includes("--all");
const d = new DatabaseSync("data/balltime.db", { readOnly: true });
const pub = all ? "1=1" : "g.published = 1";

const rallies = d.prepare(`
  SELECT r.id, r.game_id, r.outcome_type, r.outcome_cluster
  FROM rallies r JOIN games g ON g.id = r.game_id AND ${pub}
  WHERE r.phase = 'game'`).all();
const plays = d.prepare(`
  SELECT p.id, p.rally_id, p.t, p.play_type, p.cluster_id,
         ${cols().includes("grade") ? "p.grade" : "NULL AS grade"}
  FROM plays p JOIN rallies r ON r.id = p.rally_id AND r.phase = 'game'
  JOIN games g ON g.id = r.game_id AND ${pub}
  WHERE p.deleted = 0 ORDER BY p.t`).all();
const idents = d.prepare(`
  SELECT i.game_id, i.cluster_id, COALESCE(i.name, 'P' || i.cluster_id) AS name
  FROM identities i JOIN games g ON g.id = i.game_id AND ${pub}
  WHERE i.dismissed = 0 AND i.merged_into IS NULL`).all();

function cols() {
  return d.prepare("SELECT name FROM pragma_table_info('plays')").all().map(r => r.name);
}

const rallyById = new Map(rallies.map(r => [r.id, r]));
const byRally = new Map();
for (const p of plays) (byRally.get(p.rally_id) ?? byRally.set(p.rally_id, []).get(p.rally_id)).push(p);
const identName = new Map(idents.map(i => [`${i.game_id}:${i.cluster_id}`, i.name]));

const players = {};
const P = (gid, cid) => {
  if (cid == null) return null;
  const name = identName.get(`${gid}:${cid}`);
  if (!name) return null;
  return players[name] ??= { games: new Set(), serve: 0, receive: 0, dig: 0,
    set: 0, attack: 0, block: 0, kill: 0, atkErr: 0, blocked: 0, ace: 0,
    srvErr: 0, stuff: 0, assist: 0, digOk: 0, recPos: 0, recErr: 0 };
};

const gradeTally = {};
for (const [rid, touches] of byRally) {
  const rally = rallyById.get(rid);
  if (!rally) continue;
  const grades = deriveGrades(touches, rally);
  for (const t of touches) {
    const g = grades.get(t.id);
    gradeTally[`${t.play_type}:${g}`] = (gradeTally[`${t.play_type}:${g}`] || 0) + 1;
    const p = P(rally.game_id, t.cluster_id);
    if (!p || !t.play_type) continue;
    p.games.add(rally.game_id);
    p[t.play_type] = (p[t.play_type] || 0) + 1;
    if (t.play_type === "attack" && g === "blocked") p.blocked++;
    if (t.play_type === "set" && g === "assist") p.assist++;
    if (t.play_type === "dig" && g === "success") p.digOk++;
    if (t.play_type === "receive" && g === "positive") p.recPos++;
    if (t.play_type === "receive" && g === "error") p.recErr++;
  }
}
for (const r of rallies) {
  if (!r.outcome_type) continue;
  const p = P(r.game_id, r.outcome_cluster);
  if (!p) continue;
  p.games.add(r.game_id);
  const k = { kill: "kill", attack_error: "atkErr", ace: "ace",
    service_error: "srvErr", block: "stuff" }[r.outcome_type];
  if (k) p[k]++;
}

console.log(`${all ? "ALL" : "published"} games: rallies=${rallies.length} ` +
  `scored=${rallies.filter(r => r.outcome_type).length} touches=${plays.length} ` +
  `players=${Object.keys(players).length}\n`);
console.log("grade distribution (type:grade):");
for (const k of Object.keys(gradeTally).sort()) console.log(`  ${k} = ${gradeTally[k]}`);

// consistency checks: outcome-derived grades should not exceed touch counts
const sum = k => Object.values(players).reduce((a, p) => a + p[k], 0);
const oc = t => rallies.filter(r => r.outcome_type === t).length;
console.log(`\nchecks:`);
console.log(`  kill grades ${gradeTally["attack:kill"] || 0} <= kill outcomes ${oc("kill")}: ` +
  `${(gradeTally["attack:kill"] || 0) <= oc("kill") ? "OK" : "FAIL"}`);
console.log(`  stuff grades ${gradeTally["block:stuff"] || 0} <= block outcomes ${oc("block")}: ` +
  `${(gradeTally["block:stuff"] || 0) <= oc("block") ? "OK" : "FAIL"}`);
console.log(`  assists ${sum("assist")} <= kills ${oc("kill")}: ` +
  `${sum("assist") <= oc("kill") ? "OK" : "FAIL"}`);

console.log("\ntop scorers (kills+stuffs+aces):");
Object.entries(players)
  .map(([n, p]) => [n, p.kill + p.stuff + p.ace, p])
  .sort((a, b) => b[1] - a[1]).slice(0, 8)
  .forEach(([n, t, p]) => console.log(
    `  ${n}: ${t} pts (K${p.kill} B${p.stuff} A${p.ace}) · atk ${p.attack} ` +
    `set ${p.set}/${p.assist}a dig ${p.dig}/${p.digOk} rec ${p.receive}/${p.recPos}+ ${p.recErr}-`));
