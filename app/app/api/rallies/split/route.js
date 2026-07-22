import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";

// Split a rally in two at absolute game time `at` (seconds). The two halves
// share the original clip; touches move to whichever half they fall in.
// The outcome (point-ended-by) follows the SECOND half, since it describes
// how the segment ended.
export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, at } = await req.json();
  const d = db();
  const a = d.prepare("SELECT * FROM rallies WHERE id = ?").get(id);
  if (!a) return Response.json({ error: "no such rally" }, { status: 404 });
  if (!(at > a.start_s + 1 && at < a.end_s - 1))
    return Response.json({ error: "split point must be inside the rally " +
      "(and at least 1s from each end)" }, { status: 400 });
  const clipStart = a.clip_start_s ?? a.start_s - 2;
  const bId = d.prepare(
    `INSERT INTO rallies (game_id, idx, start_s, end_s, phase, clip_file,
       clip_start_s, outcome_type, outcome_cluster)
     VALUES (?, ?, ?, ?, 'game', ?, ?, ?, ?)`)
    .run(a.game_id, a.idx, at, a.end_s, a.clip_file, clipStart,
         a.outcome_type, a.outcome_cluster).lastInsertRowid;
  d.prepare(`UPDATE rallies SET end_s = ?, clip_start_s = ?,
       outcome_type = NULL, outcome_cluster = NULL WHERE id = ?`)
    .run(at, clipStart, id);
  d.prepare("UPDATE plays SET rally_id = ? WHERE rally_id = ? AND t >= ?")
    .run(bId, id, at);
  const row = x => ({ ...d.prepare("SELECT * FROM rallies WHERE id = ?").get(x) });
  return Response.json({ ok: true, a: row(id), b: row(bId) });
}
