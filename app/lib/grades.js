// Touch-grade derivation (pure — usable server- and client-side).
//
// Every rally-ending event is already annotated (outcome_type + player), and
// touch order within a rally is known, so per-touch quality can be derived
// with zero extra annotation:
//   - serve:   ace / error straight from the outcome
//   - attack:  kill / error from the outcome; "blocked" = last attack in a
//              rally that ended on a stuff block
//   - block:   "stuff" = outcome block by that player
//   - set:     "assist" = the set immediately preceding the kill attack
//   - dig:     "success" = the rally continued after it
//   - receive: "positive" = next touch was a set; "error" = last touch of an
//              ace rally (the shank)
//
// Team-awareness (identities.team, assigned in the name-players step): the
// naive rules assume consecutive touches are same-team, which breaks on
// overpasses — a shanked pass that sails over and gets killed would credit
// the passer. With teams known:
//   - credit (assist / positive / success) requires the next touch to be a
//     teammate's
//   - a touch whose direct successor is an opponent KILL is graded "error" —
//     the overpass handed them the point
// Where teams are unassigned, rules fall back to the naive same-team
// assumption. A reviewer override in plays.grade always wins.

export const GRADE_OPTIONS = {
  serve: ["ace", "in_play", "error"],
  attack: ["kill", "in_play", "blocked", "error"],
  block: ["stuff", "in_play", "error"],
  set: ["assist", "in_play", "error"],
  dig: ["success", "in_play", "error"],
  receive: ["positive", "in_play", "error"],
};

// grades that count as "excellent" per type (for chip coloring)
export const GOOD = new Set(["ace", "kill", "stuff", "assist", "success", "positive"]);
export const BAD = new Set(["error", "blocked"]);

// touches: rally's plays sorted by t, deleted excluded.
// rally: { outcome_type, outcome_cluster }
// teamOf: optional Map(cluster_id -> 'A'|'B') from identities.team
// Returns Map(play_id -> grade). Overrides (p.grade) are respected.
export function deriveGrades(touches, rally, teamOf) {
  const out = rally?.outcome_type || null;
  const oc = rally?.outcome_cluster ?? null;
  const n = touches.length;
  const matches = p => oc == null || p.cluster_id === oc;
  const team = p => (p?.cluster_id != null && teamOf?.get(p.cluster_id)) || null;
  // same-team unless both teams are known and differ (naive fallback)
  const sameTeam = (a, b) => {
    const ta = team(a), tb = team(b);
    return ta == null || tb == null || ta === tb;
  };
  const oppTeam = (a, b) => {
    const ta = team(a), tb = team(b);
    return ta != null && tb != null && ta !== tb;
  };
  const lastIdx = pred => {
    for (let i = n - 1; i >= 0; i--) if (pred(touches[i])) return i;
    return -1;
  };

  // rally-ending touches
  const killIdx = out === "kill" ? lastIdx(p => p.play_type === "attack" && matches(p)) : -1;
  const atkErrIdx = out === "attack_error" ? lastIdx(p => p.play_type === "attack" && matches(p)) : -1;
  // the attacker who got stuffed = last attack in a block-ended rally
  const blockedIdx = out === "block" ? lastIdx(p => p.play_type === "attack") : -1;
  const stuffIdx = out === "block" ? lastIdx(p => p.play_type === "block" && matches(p)) : -1;
  const lastRecIdx = out === "ace" ? lastIdx(p => p.play_type === "receive") : -1;

  const g = new Map();
  touches.forEach((p, i) => {
    if (p.grade) { g.set(p.id, p.grade); return; }
    const next = touches[i + 1];
    const isLast = i === n - 1;
    // this touch went straight to an opponent kill — the overpass gifted
    // the point (only detectable when both players' teams are known)
    const overpassKilled = i === killIdx - 1 && oppTeam(p, touches[killIdx]);
    let v = "in_play";
    switch (p.play_type) {
      case "serve":
        if (out === "ace" && matches(p)) v = "ace";
        else if (out === "service_error" && matches(p) && isLast) v = "error";
        break;
      case "attack":
        if (i === killIdx) v = "kill";
        else if (i === atkErrIdx) v = "error";
        else if (i === blockedIdx) v = "blocked";
        else if (overpassKilled) v = "error";
        break;
      case "block":
        if (i === stuffIdx) v = "stuff";
        break;
      case "set":
        if (killIdx >= 0 && i === killIdx - 1 && sameTeam(p, touches[killIdx])) v = "assist";
        else if (overpassKilled) v = "error";
        else if (out === "other_error" && isLast && matches(p)) v = "error";
        break;
      case "dig":
        if (overpassKilled) v = "error";
        else if (out === "other_error" && isLast && matches(p)) v = "error";
        else if (!isLast && sameTeam(p, next)) v = "success";
        break;
      case "receive":
        if (i === lastRecIdx) v = "error";                  // shanked an ace
        else if (overpassKilled) v = "error";               // overpass, killed
        else if (out === "other_error" && isLast && matches(p)) v = "error";
        else if (next?.play_type === "set" && sameTeam(p, next)) v = "positive";
        break;
    }
    g.set(p.id, v);
  });
  return g;
}

// Build Map(cluster_id -> team) from identity rows ({ cluster_id, team })
export function teamMap(idents) {
  const m = new Map();
  for (const i of idents || [])
    if (i.team === "A" || i.team === "B") m.set(i.cluster_id, i.team);
  return m.size ? m : null;
}
