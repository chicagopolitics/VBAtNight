import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";

// The global player registry. A player is the durable identity that per-game
// identities link to (identities.player_id), so stats can aggregate one person
// across games/weeks even when names collide.

// GET -> every player with its linked per-game identities (game name + a crop
// for visual disambiguation, since duplicate display_names are allowed).
export async function GET() {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const d = db();
  const players = d.prepare(
    `SELECT id, display_name, created_at FROM players ORDER BY display_name COLLATE NOCASE`)
    .all().map(p => ({ ...p }));
  const idents = d.prepare(
    `SELECT i.id, i.player_id, i.name, i.game_id, i.rep_crops, g.name AS game_name
     FROM identities i JOIN games g ON g.id = i.game_id
     WHERE i.player_id IS NOT NULL AND i.dismissed = 0 AND i.merged_into IS NULL`)
    .all().map(i => {
      let crop = null;
      try { crop = JSON.parse(i.rep_crops)?.[0] ?? null; } catch {}
      return { id: i.id, player_id: i.player_id, name: i.name,
        game_id: i.game_id, game_name: i.game_name, crop };
    });
  const byPlayer = new Map(players.map(p => [p.id, []]));
  for (const i of idents) byPlayer.get(i.player_id)?.push(i);
  const rows = players.map(p => {
    const list = byPlayer.get(p.id) || [];
    return { ...p, identities: list, games: new Set(list.map(i => i.game_id)).size };
  });
  return Response.json({ players: rows });
}

// POST { display_name } -> create a player (returns it).
// POST { action: "merge", src, dst } -> re-point src's identities to dst, delete src.
export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json();
  const d = db();

  if (body.action === "merge") {
    const src = +body.src, dst = +body.dst;
    if (!src || !dst || src === dst)
      return Response.json({ error: "bad merge" }, { status: 400 });
    const dstRow = d.prepare("SELECT * FROM players WHERE id = ?").get(dst);
    if (!dstRow) return Response.json({ error: "no dst" }, { status: 400 });
    d.prepare("UPDATE identities SET player_id = ?, name = ? WHERE player_id = ?")
      .run(dst, dstRow.display_name, src);
    d.prepare("DELETE FROM players WHERE id = ?").run(src);
    return Response.json({ ok: true });
  }

  const name = (body.display_name || "").trim();
  if (!name) return Response.json({ error: "name required" }, { status: 400 });
  const id = d.prepare("INSERT INTO players (display_name) VALUES (?)")
    .run(name).lastInsertRowid;
  return Response.json({ id: Number(id), display_name: name });
}

// PATCH { id, display_name } -> rename a player; propagates to linked identities
// so per-game labels and stats stay in sync.
export async function PATCH(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, display_name } = await req.json();
  const name = (display_name || "").trim();
  if (!id || !name) return Response.json({ error: "bad request" }, { status: 400 });
  const d = db();
  d.prepare("UPDATE players SET display_name = ? WHERE id = ?").run(name, +id);
  d.prepare("UPDATE identities SET name = ? WHERE player_id = ?").run(name, +id);
  return Response.json({ ok: true });
}
