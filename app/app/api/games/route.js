import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { resequenceNight } from "@/lib/import";
import { displayName } from "@/lib/game-name";

export async function PATCH(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, published, played_on, label } = await req.json();
  const d = db();
  if (published !== undefined)
    d.prepare("UPDATE games SET published = ? WHERE id = ?").run(published ? 1 : 0, id);

  // Setting the date is what turns an unnamed import into a named game, so
  // it has to renumber both the night it left and the night it joined —
  // otherwise a correction leaves a hole ("Game 1, Game 3") behind it.
  if (played_on !== undefined) {
    if (played_on !== null && !/^\d{4}-\d{2}-\d{2}$/.test(played_on))
      return Response.json({ error: "played_on must be YYYY-MM-DD" }, { status: 400 });
    const before = d.prepare("SELECT played_on FROM games WHERE id = ?").get(id)?.played_on;
    d.prepare("UPDATE games SET played_on = ?, slot = NULL WHERE id = ?")
      .run(played_on, id);
    if (before && before !== played_on) resequenceNight(before);
    resequenceNight(played_on);
  }

  // Empty string clears the override and hands the game back to the derived
  // name — distinct from `undefined`, which means "don't touch it".
  if (label !== undefined)
    d.prepare("UPDATE games SET label = ? WHERE id = ?")
      .run((label ?? "").trim() || null, id);

  const game = d.prepare("SELECT * FROM games WHERE id = ?").get(id);
  return Response.json({ ok: true, name: game ? displayName(game) : null });
}

export async function DELETE(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await req.json();
  const d = db();
  const night = d.prepare("SELECT played_on FROM games WHERE id = ?").get(id)?.played_on;
  d.prepare("DELETE FROM plays WHERE rally_id IN (SELECT id FROM rallies WHERE game_id = ?)").run(id);
  d.prepare("DELETE FROM rallies WHERE game_id = ?").run(id);
  d.prepare("DELETE FROM tracklets WHERE game_id = ?").run(id);
  d.prepare("DELETE FROM identities WHERE game_id = ?").run(id);
  d.prepare("DELETE FROM games WHERE id = ?").run(id);
  const fs = await import("fs");
  const path = await import("path");
  fs.rmSync(path.join(process.cwd(), "public", "media", String(id)),
    { recursive: true, force: true });
  // Close the gap the deleted game left, or the night reads "Game 1, Game 3".
  resequenceNight(night);
  return Response.json({ ok: true });
}
