import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";

export async function PATCH(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, published } = await req.json();
  db().prepare("UPDATE games SET published = ? WHERE id = ?").run(published ? 1 : 0, id);
  return Response.json({ ok: true });
}

export async function DELETE(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await req.json();
  const d = db();
  d.prepare("DELETE FROM plays WHERE rally_id IN (SELECT id FROM rallies WHERE game_id = ?)").run(id);
  d.prepare("DELETE FROM rallies WHERE game_id = ?").run(id);
  d.prepare("DELETE FROM tracklets WHERE game_id = ?").run(id);
  d.prepare("DELETE FROM identities WHERE game_id = ?").run(id);
  d.prepare("DELETE FROM games WHERE id = ?").run(id);
  const fs = await import("fs");
  const path = await import("path");
  fs.rmSync(path.join(process.cwd(), "public", "media", String(id)),
    { recursive: true, force: true });
  return Response.json({ ok: true });
}
