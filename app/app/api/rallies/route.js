import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";

export async function PATCH(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, ...fields } = await req.json();
  const allowed = ["outcome_type", "outcome_cluster", "phase", "start_s", "end_s"];
  for (const k of Object.keys(fields))
    if (!allowed.includes(k)) return Response.json({ error: "bad field" }, { status: 400 });
  if ("start_s" in fields || "end_s" in fields) {
    const cur = db().prepare("SELECT start_s, end_s FROM rallies WHERE id = ?").get(id);
    if (!cur) return Response.json({ error: "no such rally" }, { status: 404 });
    const ns = fields.start_s ?? cur.start_s, ne = fields.end_s ?? cur.end_s;
    if (!(ns < ne - 0.5))
      return Response.json({ error: "start must be before end" }, { status: 400 });
  }
  for (const k of Object.keys(fields))
    db().prepare(`UPDATE rallies SET ${k} = ? WHERE id = ?`).run(fields[k], id);
  return Response.json({ ok: true });
}

// create a rally the detector missed entirely (idx -1 = no pipeline counterpart)
export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { game_id, start_s, end_s } = await req.json();
  if (!game_id || !(start_s >= 0) || !(end_s > start_s))
    return Response.json({ error: "bad boundaries" }, { status: 400 });
  const id = db().prepare(
    `INSERT INTO rallies (game_id, idx, start_s, end_s, phase) VALUES (?, -1, ?, ?, 'game')`)
    .run(game_id, start_s, end_s).lastInsertRowid;
  return Response.json({ ok: true,
    rally: { ...db().prepare("SELECT * FROM rallies WHERE id = ?").get(id) } });
}
