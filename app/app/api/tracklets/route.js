import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { loadGameJson } from "@/lib/gamejson";

// GET ?game_id=N — per-frame tracklet boxes for the review overlay.
//
// Boxes live only in the retained game.json (SQLite drops them at import);
// the join back to the DB matters because the client must store the DB
// tracklets.id in plays.tracklet_id, not the pipeline's src_id, and because
// the identity link must be CURRENT (splits/merges in the identities UI move
// tracklets.identity_id after import). Tracklets that don't join — a
// backfilled game.json from a different pipeline run, or a dismissed/merged
// identity — are still emitted with null id/cluster/name so the overlay can
// render the box and a click can at least capture position.
export async function GET(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const gid = Number(new URL(req.url).searchParams.get("game_id"));
  if (!gid) return Response.json({ error: "game_id required" }, { status: 400 });
  const game = loadGameJson(gid);
  if (!game || !game.tracklets)
    return Response.json({ error: "no game.json for this game" }, { status: 404 });
  const d = db();
  const rows = d.prepare(
    `SELECT t.id, t.src_id, i.cluster_id, i.name, i.dismissed
     FROM tracklets t LEFT JOIN identities i ON i.id = t.identity_id
     WHERE t.game_id = ?`).all(gid);
  const bySrc = new Map(rows.map(r => [r.src_id, r]));
  const tracklets = game.tracklets.map(tr => {
    const row = bySrc.get(tr.id);
    const live = row && !row.dismissed;
    return {
      id: row ? row.id : null,
      src_id: tr.id,
      cluster_id: live ? row.cluster_id : null,
      name: live ? row.name : null,
      // 1dp: sub-pixel float noise is ~80% of the payload and means nothing
      // at overlay scale.
      boxes: tr.boxes.map(b => b.map(v => Math.round(v * 10) / 10)),
    };
  });
  return Response.json({ tracklets });
}

// POST { game_id, tracklet_ids: [], target: "new" | "dismiss" | <identity_id> }
export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { game_id, tracklet_ids, target } = await req.json();
  if (!Array.isArray(tracklet_ids) || tracklet_ids.length === 0)
    return Response.json({ error: "no tracklets" }, { status: 400 });
  const d = db();

  let identity;
  if (target === "new" || target === "dismiss") {
    const maxc = d.prepare(
      "SELECT MAX(cluster_id) m FROM identities WHERE game_id = ?").get(game_id);
    const crops = tracklet_ids.flatMap(tid => {
      const t = d.prepare("SELECT crops FROM tracklets WHERE id = ?").get(tid);
      return t ? JSON.parse(t.crops).slice(0, 2) : [];
    }).slice(0, 6);
    const rid = d.prepare(
      `INSERT INTO identities (game_id, cluster_id, dismissed, rep_crops, n_boxes)
       VALUES (?, ?, ?, ?, 0)`)
      .run(game_id, (maxc.m ?? 0) + 1, target === "dismiss" ? 1 : 0,
           JSON.stringify(crops)).lastInsertRowid;
    identity = d.prepare("SELECT * FROM identities WHERE id = ?").get(rid);
  } else {
    identity = d.prepare("SELECT * FROM identities WHERE id = ?").get(target);
    if (!identity) return Response.json({ error: "bad target" }, { status: 400 });
  }

  const marks = tracklet_ids.map(() => "?").join(",");
  d.prepare(`UPDATE tracklets SET identity_id = ? WHERE id IN (${marks})`)
    .run(identity.id, ...tracklet_ids);
  // plays follow their tracklet
  d.prepare(`UPDATE plays SET cluster_id = ? WHERE tracklet_id IN (${marks})`)
    .run(identity.dismissed ? null : identity.cluster_id, ...tracklet_ids);
  return Response.json({ ok: true, identity: { ...identity } });
}
