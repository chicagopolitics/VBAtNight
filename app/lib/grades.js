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
  // "poor" = kept the ball playable but out of system (setter had to chase;
  // the 1-2 band of the classic 0-3 passing scale). Only ever set manually —
  // the auto-derivation can't see pass quality, only what happened next.
  dig: ["success", "in_play", "poor", "error"],
  receive: ["positive", "in_play", "poor", "error"],
};

// grades that count as "excellent" per type (for chip coloring)
export const GOOD = new Set(["ace", "kill", "stuff", "assist", "success", "positive"]);
export const BAD = new Set(["error", "blocked"]);

// Filterable stats — the one vocabulary for "show me the X". Three kinds:
//   touch    — plain attempt counts (matches touch.type)
//   +grade   — quality subset of a touch type (derived below)
//   outcome  — rally-ending points/faults (matches rally.outcome_*)
//
// `field` names the counter in lib/player-stats.js, so a filter chip can show
// its own count without a second definition of what "an assist" is.
//
// Lived in app/watch/ui.js until the recap page needed the same words. It sits
// here rather than there because a `"use client"` module can't be imported by
// a server component, and because these keys are already a contract: /stats
// deep-links as ?stat=<key>, and now /p/<slug>/<date> reads the same param.
export const STATS = {
  serve: { label: "serves", touch: "serve", field: "serve" },
  receive: { label: "receives", touch: "receive", field: "receive" },
  dig: { label: "digs", touch: "dig", field: "dig" },
  set: { label: "sets", touch: "set", field: "set" },
  attack: { label: "attacks", touch: "attack", field: "attack" },
  block: { label: "block touches", touch: "block", field: "block" },
  kill: { label: "kills", outcome: "kill", field: "kill" },
  ace: { label: "aces", outcome: "ace", field: "ace" },
  stuff: { label: "stuff blocks", outcome: "block", field: "stuff" },
  attack_error: { label: "attack errors", outcome: "attack_error", field: "atkErr" },
  service_error: { label: "serve errors", outcome: "service_error", field: "srvErr" },
  assist: { label: "assists", touch: "set", grade: "assist", field: "assist" },
  set_error: { label: "set errors", touch: "set", grade: "error", field: "setErr" },
  dig_kept: { label: "digs kept in play", touch: "dig", grade: "success", field: "digOk" },
  dig_error: { label: "dig errors", touch: "dig", grade: "error", field: "digErr" },
  rec_pos: { label: "positive receptions", touch: "receive", grade: "positive", field: "recPos" },
  rec_error: { label: "reception errors", touch: "receive", grade: "error", field: "recErr" },
  blocked: { label: "blocked attacks", touch: "attack", grade: "blocked", field: "blocked" },
};

export const GROUPS = [
  ["Touches", ["serve", "receive", "dig", "set", "attack", "block"]],
  ["Points & faults", ["kill", "ace", "stuff", "attack_error", "service_error"]],
  ["Quality", ["assist", "rec_pos", "dig_kept", "blocked", "set_error", "dig_error", "rec_error"]],
];

/** The stats that cost the team a point — kept apart so a recap can offer
 *  them without leading with them. */
export const FAULTS = new Set(["attack_error", "service_error", "set_error",
  "dig_error", "rec_error", "blocked"]);

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

// How a rally outcome READS: label + pill tone. Presentation, but it belongs
// with the vocabulary rather than inside one page — a clip card on /watch and
// a rally permalink must not name the same outcome two different ways.
export const OUTCOME = {
  kill: ["Kill", "good"], block: ["Stuff block", "good"], ace: ["Ace", "info"],
  attack_error: ["Attack error", "bad"], service_error: ["Serve error", "bad"],
  other_error: ["Error", "bad"],
};

// [label, tone] for any outcome_type, including ones the table doesn't name.
// [null, ""] for a rally that never resolved to an outcome at all.
export const outcomeLabel = t =>
  OUTCOME[t] ?? (t ? [String(t).replace(/_/g, " "), ""] : [null, ""]);

// Derived score from rally outcomes.
//
// kill/ace/block win the point for that player's team; every error hands it
// to the opponent. A rally whose outcome belongs to a player with no team
// assignment can't be counted either way, so the result carries `approx`
// rather than silently reading low.
//
// Shared so the game card on /watch and a rally permalink can't drift: the
// permalink passes only the rallies UP TO one moment and gets the score as it
// stood then, which is this same arithmetic stopped early.
export function scoreFrom(rallies, teamOf) {
  if (!teamOf) return null;
  let A = 0, B = 0, uncounted = 0;
  for (const r of rallies || []) {
    if (!r.outcome_type) continue;
    const t = teamOf.get(r.outcome_cluster);
    if (!t) { uncounted++; continue; }
    const wins = ["kill", "ace", "block"].includes(r.outcome_type);
    if ((wins ? t : t === "A" ? "B" : "A") === "A") A++; else B++;
  }
  return A + B > 0 ? { A, B, approx: uncounted > 0 } : null;
}
