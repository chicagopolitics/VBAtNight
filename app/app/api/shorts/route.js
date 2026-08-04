// Shorts queue — organizer only.
//
//   POST   queue a rally to be rendered as a Short
//   PATCH  publish a rendered Short to YouTube, or edit its caption,
//          or mark a whole game's Shorts finished (which unlocks purge)
//   DELETE drop a queued/rendered Short
//
// Rendering itself happens in scripts/shorts-worker.mjs. Nothing here blocks
// on ffmpeg: a render is 1-2 minutes on a 2-vCPU droplet, so the request just
// writes a 'queued' row and returns.
import fs from "fs";
import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { blockedReason, shortsDir, absFromUrl } from "@/lib/shorts";
import { uploadVideo, youtubeConfigured } from "@/lib/youtube";

// Shorts default to PUBLIC, unlike full games. That's not an oversight: an
// unlisted Short is invisible to the feed, so it does nothing at all. This is
// the one thing in the system that exposes the league publicly, so the UI
// confirms it explicitly and the value is overridable.
const SHORT_PRIVACY = () => process.env.YT_SHORTS_PRIVACY || "public";

async function guard() { return isOrganizer(await getSessionUser()); }

export async function POST(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  const { rally_id, play_id, caption, subcaption, zoom, lead } = await req.json();
  const d = db();

  // A Short is normally anchored on a PLAY — the kill, the dig, the block it
  // is actually about. rally_id alone still works (whole-rally clip), but
  // the play is what people share.
  let play = null;
  if (play_id) {
    play = d.prepare("SELECT * FROM plays WHERE id = ? AND deleted = 0").get(play_id);
    if (!play) return Response.json({ error: "no such play" }, { status: 404 });
  }
  const rid = play ? play.rally_id : rally_id;
  const rally = d.prepare("SELECT * FROM rallies WHERE id = ?").get(rid);
  if (!rally) return Response.json({ error: "no such rally" }, { status: 404 });
  const game = d.prepare("SELECT * FROM games WHERE id = ?").get(rally.game_id);

  // Fail here, loudly, rather than letting the worker discover it later —
  // a queued row that can never render is worse than a refused click.
  const blocked = blockedReason(game);
  if (blocked) return Response.json({ error: blocked }, { status: 409 });

  // Duplicate check is per MOMENT, not per rally: a rally can legitimately
  // yield two Shorts — the great dig, and the kill it set up.
  const dup = play
    ? d.prepare(`SELECT id, status FROM shorts
                 WHERE play_id = ? AND status != 'failed'`).get(play.id)
    : d.prepare(`SELECT id, status FROM shorts
                 WHERE rally_id = ? AND play_id IS NULL AND status != 'failed'`)
        .get(rid);
  if (dup) return Response.json(
    { error: `already ${dup.status} as short #${dup.id}` }, { status: 409 });

  const id = d.prepare(
    `INSERT INTO shorts (game_id, rally_id, play_id, lead, caption, subcaption, zoom)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(game.id, rid, play ? play.id : null, lead ?? 4,
         caption || null, subcaption || null, zoom ?? 1.0)
    .lastInsertRowid;
  return Response.json({ ok: true,
    short: d.prepare("SELECT * FROM shorts WHERE id = ?").get(id) });
}

export async function PATCH(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json();
  const d = db();

  // mark a game's Shorts finished (or un-finish it) — this is the purge gate
  if (body.game_id !== undefined && body.shorts_done !== undefined) {
    const game = d.prepare("SELECT * FROM games WHERE id = ?").get(body.game_id);
    if (!game) return Response.json({ error: "no such game" }, { status: 404 });
    const pendingRows = d.prepare(
      `SELECT count(*) n FROM shorts WHERE game_id = ? AND status IN
       ('queued','rendering')`).get(body.game_id).n;
    if (body.shorts_done && pendingRows)
      return Response.json(
        { error: `${pendingRows} short(s) still rendering — wait for them first` },
        { status: 409 });
    d.prepare("UPDATE games SET shorts_done = ? WHERE id = ?")
      .run(body.shorts_done ? 1 : 0, body.game_id);
    return Response.json({ ok: true, shorts_done: !!body.shorts_done });
  }

  const short = d.prepare("SELECT * FROM shorts WHERE id = ?").get(body.id);
  if (!short) return Response.json({ error: "no such short" }, { status: 404 });

  // requeue a failure
  if (body.requeue) {
    if (!["failed", "ready"].includes(short.status))
      return Response.json({ error: "only a failed or ready short can requeue" },
        { status: 409 });
    d.prepare("UPDATE shorts SET status='queued', error=NULL WHERE id=?").run(short.id);
    return Response.json({ ok: true });
  }

  // caption edit (takes effect on the next render)
  if (body.caption !== undefined || body.subcaption !== undefined) {
    if (body.caption !== undefined)
      d.prepare("UPDATE shorts SET caption=? WHERE id=?").run(body.caption || null, short.id);
    if (body.subcaption !== undefined)
      d.prepare("UPDATE shorts SET subcaption=? WHERE id=?")
        .run(body.subcaption || null, short.id);
    return Response.json({ ok: true });
  }

  // publish
  if (body.publish) {
    if (short.status !== "ready")
      return Response.json({ error: `short is ${short.status}, not ready` },
        { status: 409 });
    if (!youtubeConfigured())
      return Response.json({ error: "YouTube not configured — run `npm run yt-auth`" },
        { status: 400 });
    const abs = absFromUrl(short.file);
    if (!fs.existsSync(abs))
      return Response.json({ error: "rendered file is missing — requeue it" },
        { status: 404 });
    const game = d.prepare("SELECT * FROM games WHERE id = ?").get(short.game_id);
    const privacy = body.privacy || SHORT_PRIVACY();
    try {
      const v = await uploadVideo(abs, {
        title: (short.caption || `${game.name} highlight`).slice(0, 100),
        // YouTube classifies any <=3min 9:16 upload as a Short automatically;
        // the hashtag is belt-and-braces and costs nothing.
        description: `${short.subcaption || ""}\n\n${game.name}\n` +
          `Full stats: https://vbatnight.com/watch?game=${game.id}\n#Shorts`.trim(),
        tags: ["volleyball", "vbatnight", "shorts"],
        privacy,
      });
      d.prepare(
        `UPDATE shorts SET status='published', yt_video_id=?, published_at=?
         WHERE id=?`).run(v.id, new Date().toISOString(), short.id);
      return Response.json({ ok: true, ...v,
        warning: v.privacyStatus !== privacy
          ? `YouTube set this to "${v.privacyStatus}" instead of "${privacy}".` : null });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502 });
    }
  }

  return Response.json({ error: "nothing to do" }, { status: 400 });
}

export async function DELETE(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await req.json();
  const d = db();
  const short = d.prepare("SELECT * FROM shorts WHERE id = ?").get(id);
  if (!short) return Response.json({ error: "no such short" }, { status: 404 });
  if (short.status === "rendering")
    return Response.json({ error: "it's rendering right now — wait for it" },
      { status: 409 });
  // Deleting the row does NOT unpublish anything already on YouTube; say so
  // rather than implying a takedown we can't perform (upload-only scope).
  if (short.file) fs.rmSync(absFromUrl(short.file), { force: true });
  d.prepare("DELETE FROM shorts WHERE id = ?").run(id);
  return Response.json({ ok: true,
    note: short.yt_video_id
      ? "removed here; the video is still on YouTube — delete it in Studio"
      : null });
}
