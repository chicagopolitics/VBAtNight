import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";

// Writing the roster mapping: which email IS which durable player.
//
// The matching itself is in lib/roster.js and runs in the browser — this route
// only records decisions the organizer has already confirmed, one row at a
// time. Nothing here guesses.

const bad = (error, status = 400) => Response.json({ error }, { status });

export async function POST(req) {
  if (!isOrganizer(await getSessionUser())) return bad("forbidden", 403);
  const body = await req.json().catch(() => null);
  if (!body) return bad("bad json");
  const d = db();

  if (body.action === "unlink") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return bad("email required");
    d.prepare("UPDATE users SET player_id = NULL WHERE email = ?").run(email);
    return Response.json({ ok: true });
  }

  const links = Array.isArray(body.links) ? body.links : null;
  if (!links?.length) return bad("links required");

  const saved = [];
  for (const l of links) {
    const email = String(l.email || "").trim().toLowerCase();
    const pid = l.player_id == null ? null : +l.player_id;
    if (!email || !pid) return bad(`bad link for ${email || "(no email)"}`);
    if (!d.prepare("SELECT 1 FROM players WHERE id = ?").get(pid))
      return bad(`no player ${pid}`);

    // The partial unique index would catch this, but as a 500 the UI can't
    // explain. Two people are never the same player; say which email has it.
    const held = d.prepare(
      "SELECT email FROM users WHERE player_id = ? AND email != ?").get(pid, email);
    if (held) return bad(`that player is already linked to ${held.email}`, 409);

    // A registrant who has never signed in still gets a row — it's the thing a
    // future claim link addresses. Name only fills a blank: whatever they typed
    // at Luma registration must not overwrite an edit made here later.
    const name = String(l.name || "").trim() || null;
    d.prepare(
      `INSERT INTO users (email, name, player_id) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         player_id = excluded.player_id,
         name = COALESCE(users.name, excluded.name)`).run(email, name, pid);
    saved.push({ email, player_id: pid });
  }
  return Response.json({ ok: true, saved });
}

// Current mapping, for the importer to mark already-linked rows.
export async function GET() {
  if (!isOrganizer(await getSessionUser())) return bad("forbidden", 403);
  const rows = db().prepare(
    `SELECT u.email, u.player_id, p.display_name
     FROM users u JOIN players p ON p.id = u.player_id
     ORDER BY p.display_name COLLATE NOCASE`).all().map(r => ({ ...r }));
  return Response.json({ links: rows });
}
