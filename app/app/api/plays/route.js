import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { loadGameJson, boxesAt } from "@/lib/gamejson";
import { PLAY_TYPES, predictPlayType } from "@/lib/play-types";

// D3 (ML-PLAN 0.1): keep `tracklet_id` meaning "the tracked body that made
// this touch" whenever the reviewer names a player.
//
// The two correction types must not be conflated, and in practice almost all
// of them are the FIRST kind:
//   (a) GEOMETRY  — "I thought Bob touched it, it was actually Steve."
//                   Both are labelled correctly; the pipeline picked the
//                   wrong nearby body. Truth = Steve's tracked body.
//   (b) IDENTITY  — "the body I called Bob is really Steve."
//                   A clustering error, fixed on the identities page.
//
// So on a cluster change we re-link to a tracklet OF THE NAMED PLAYER. The
// tempting alternative — nearest body to the ball, regardless of cluster —
// records (cluster=Steve, tracklet=Bob's body), which downstream reads as
// exactly (b) and would teach a re-ID fine-tune that Bob looks like Steve.
// Measured on game 14: 51 of 88 linked touches carried that false pairing.
//
// No distance gate: the reviewer's judgement outranks geometry, and the
// clusterer's temporal cannot-link guarantees at most one tracklet per
// cluster at any instant, so "which body is this player right now" is
// unambiguous. Position only breaks ties left by an app-side merge.
// No match (the named player untracked here) => NULL, which is honest;
// pointing at someone else's body is not.
// Returns the resolved tracklet_id (or null when the named player has no
// body here); `undefined` means it could not act and left the row alone. The
// caller sends this back to the client — without it the browser keeps the
// PREVIOUS player's tracklet in local state and the overlay goes on drawing
// their box, flagged as a bogus identity mismatch.
function relinkTracklet(d, playId, clusterId) {
  const p = d.prepare(
    `SELECT p.t, p.x, p.y, r.game_id FROM plays p
     JOIN rallies r ON r.id = p.rally_id WHERE p.id = ?`).get(playId);
  if (!p) return undefined;
  const game = loadGameJson(p.game_id);
  if (!game) return undefined;    // can't resolve bodies; leave as-is
  const mine = d.prepare(
    `SELECT t.id, t.src_id FROM tracklets t
     JOIN identities i ON i.id = t.identity_id
     WHERE t.game_id = ? AND i.cluster_id = ? AND i.dismissed = 0`)
    .all(p.game_id, clusterId);
  const bySrc = new Map(mine.map(r => [r.src_id, r.id]));
  let best = null;
  for (const { src_id, box } of boxesAt(game, p.t)) {
    if (!bySrc.has(src_id)) continue;
    let d2 = 0;
    if (p.x != null && p.y != null) {
      const [, bx, by, bw, bh] = box;
      d2 = Math.hypot(bx + bw / 2 - p.x, (by + bh * 0.35 - p.y) * 0.6);
    }
    if (!best || d2 < best.d2) best = { id: bySrc.get(src_id), d2 };
  }
  const resolved = best ? best.id : null;
  d.prepare("UPDATE plays SET tracklet_id = ? WHERE id = ?").run(resolved, playId);
  return resolved;
}

export async function PATCH(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, ...fields } = await req.json();
  const allowed = ["play_type", "cluster_id", "deleted", "t", "grade",
                   "x", "y", "tracklet_id"];
  const d = db();
  for (const k of Object.keys(fields)) {
    if (!allowed.includes(k)) return Response.json({ error: "bad field" }, { status: 400 });
    d.prepare(`UPDATE plays SET ${k} = ?, corrected = 1 WHERE id = ?`).run(fields[k], id);
  }
  // Clicking a player box sends tracklet_id explicitly — that wins. The
  // typeahead sends only cluster_id, so resolve the body here. Skipped for
  // "unknown player" (cluster_id null): the reviewer is withdrawing a name,
  // not asserting a different body.
  let relinked;
  if ("cluster_id" in fields && !("tracklet_id" in fields) && fields.cluster_id != null)
    relinked = relinkTracklet(d, id, fields.cluster_id);
  return Response.json(relinked === undefined
    ? { ok: true } : { ok: true, tracklet_id: relinked });
}

export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { rally_id, t, x, y, cluster_id, tracklet_id, play_type } = await req.json();
  const d = db();
  // The client predicts the type from the preceding touch and sends it. When it
  // doesn't (older client, or a value outside the vocabulary), predict the same
  // way here rather than falling back to a blanket 'attack' — one rule, no
  // drift between the two sides. An unknown value falls through silently rather
  // than 400ing, which would block an otherwise valid insert.
  let type = PLAY_TYPES.includes(play_type) ? play_type : null;
  if (!type) {
    const prev = d.prepare(
      `SELECT play_type FROM plays
       WHERE rally_id = ? AND deleted = 0 AND t < ? ORDER BY t DESC LIMIT 1`)
      .get(rally_id, t);
    type = predictPlayType(prev?.play_type ?? null);
  }
  const r = d.prepare(
    `INSERT INTO plays (rally_id, t, x, y, play_type, cluster_id, tracklet_id, corrected)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(rally_id, t, x ?? null, y ?? null, type, cluster_id ?? null, tracklet_id ?? null);
  return Response.json({ id: Number(r.lastInsertRowid) });
}
