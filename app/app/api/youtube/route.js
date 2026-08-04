// Link a game to a YouTube video, upload it, or reclaim the local file.
// Organizer-only — this writes to the channel and deletes multi-GB media.
//
// Three operations, deliberately separate because they carry very different
// risk:
//   PATCH  link an id (or clear it)   — reversible, no side effects
//   POST   upload the local mp4       — needs the API audit to be OK
//   DELETE reclaim the local mp4      — irreversible, gated on media_state
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { uploadVideo, youtubeConfigured, defaultPrivacy } from "@/lib/youtube";

// Accept a bare id, a watch URL, a youtu.be link or an embed URL — Ken will
// paste whatever YouTube Studio put on his clipboard, and all four are the
// same 11-char id.
function parseVideoId(input) {
  const s = String(input || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

async function guard() {
  return isOrganizer(await getSessionUser());
}

// PATCH — link (or unlink) a manually uploaded video.
// This is the path that works TODAY, no audit required: upload in YouTube
// Studio, paste the link here. See YOUTUBE-PLAN.md.
export async function PATCH(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, video, privacy } = await req.json();
  const game = db().prepare("SELECT * FROM games WHERE id = ?").get(id);
  if (!game) return Response.json({ error: "no such game" }, { status: 404 });

  if (video === null || video === "") {          // unlink
    if ((game.media_state ?? "local") === "youtube")
      return Response.json(
        { error: "local video was reclaimed — unlinking would leave no playable source" },
        { status: 409 });
    db().prepare(
      `UPDATE games SET yt_video_id = NULL, yt_privacy = NULL,
       yt_uploaded_at = NULL, media_state = 'local' WHERE id = ?`).run(id);
    return Response.json({ ok: true, video_id: null });
  }

  const vid = parseVideoId(video);
  if (!vid) return Response.json({ error: "couldn't find a video id in that" },
    { status: 400 });
  db().prepare(
    `UPDATE games SET yt_video_id = ?, yt_privacy = ?, yt_uploaded_at = ?,
     media_state = 'both' WHERE id = ?`)
    .run(vid, privacy || defaultPrivacy(), new Date().toISOString(), id);
  return Response.json({ ok: true, video_id: vid });
}

// POST — upload this game's local mp4 to the channel.
export async function POST(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!youtubeConfigured())
    return Response.json({ error: "YouTube not configured — run `npm run yt-auth`" },
      { status: 400 });
  const { id } = await req.json();
  const game = db().prepare("SELECT * FROM games WHERE id = ?").get(id);
  if (!game) return Response.json({ error: "no such game" }, { status: 404 });
  if (game.yt_video_id)
    return Response.json({ error: "already linked to " + game.yt_video_id },
      { status: 409 });
  if (!game.video_file?.startsWith("/media/"))
    return Response.json({ error: "this game has no full-game video to upload" },
      { status: 400 });

  const abs = path.join(process.cwd(), "public", game.video_file.replace(/^\//, ""));
  if (!fs.existsSync(abs))
    return Response.json({ error: "local video file is missing" }, { status: 404 });

  try {
    const v = await uploadVideo(abs, {
      title: game.name,
      description:
        `Full game. Rally-by-rally highlights and stats: https://vbatnight.com/watch?game=${game.id}`,
      tags: ["volleyball", "vbatnight"],
    });
    db().prepare(
      `UPDATE games SET yt_video_id = ?, yt_privacy = ?, yt_uploaded_at = ?,
       media_state = 'both' WHERE id = ?`)
      .run(v.id, v.privacyStatus, new Date().toISOString(), id);
    // Surface the privacy YouTube actually applied: if it silently locked
    // the video private, unlisted embeds won't work and Ken needs to know
    // now, not when a viewer reports a black player.
    return Response.json({ ok: true, ...v,
      warning: v.privacyStatus !== defaultPrivacy()
        ? `YouTube set this to "${v.privacyStatus}" instead of "${defaultPrivacy()}" — ` +
          `embeds will not play. See YOUTUBE-PLAN.md.` : null });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}

// DELETE — reclaim the local mp4 for a game that's safely on YouTube.
// The whole point of the migration, and the only irreversible step, so it
// refuses unless the game is at media_state 'both'.
export async function DELETE(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await req.json();
  const game = db().prepare("SELECT * FROM games WHERE id = ?").get(id);
  if (!game) return Response.json({ error: "no such game" }, { status: 404 });
  if (!game.yt_video_id)
    return Response.json({ error: "not on YouTube — refusing to delete the only copy" },
      { status: 409 });
  if ((game.media_state ?? "local") !== "both")
    return Response.json({ error: "local video already reclaimed" }, { status: 409 });
  // The local mp4 is the ONLY thing a Short can be rendered from — the
  // YouTube copy can't be pulled back down for that. So deleting it closes
  // the door on this game's highlights permanently, and that has to be a
  // decision, not a side effect of tidying up disk.
  if (!game.shorts_done)
    return Response.json({ error:
      "Shorts aren't marked done for this game. The local video is the only " +
      "source a Short can be rendered from, so this would permanently close " +
      "the door. Finish picking Shorts, then mark them done on /watch." },
      { status: 409 });
  const busy = db().prepare(
    `SELECT count(*) n FROM shorts WHERE game_id = ? AND status IN
     ('queued','rendering')`).get(id).n;
  if (busy)
    return Response.json({ error: `${busy} short(s) still rendering from this video` },
      { status: 409 });

  let freed = 0;
  if (game.video_file?.startsWith("/media/")) {
    const abs = path.join(process.cwd(), "public", game.video_file.replace(/^\//, ""));
    if (fs.existsSync(abs)) { freed = fs.statSync(abs).size; fs.rmSync(abs, { force: true }); }
  }
  db().prepare("UPDATE games SET media_state = 'youtube' WHERE id = ?").run(id);
  return Response.json({ ok: true, freed_bytes: freed,
    freed: (freed / 1e9).toFixed(2) + " GB" });
}
