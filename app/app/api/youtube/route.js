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
import { uploadVideo, updateVideoTitle, youtubeConfigured, defaultPrivacy }
  from "@/lib/youtube";
import { reclaimLocalVideo } from "@/lib/reclaim";
import { youtubeTitle, displayName } from "@/lib/game-name";

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
  const { id, video, privacy, retitle } = await req.json();
  const game = db().prepare("SELECT * FROM games WHERE id = ?").get(id);
  if (!game) return Response.json({ error: "no such game" }, { status: 404 });

  // Re-sync the title. Separate from linking because it's the one PATCH that
  // talks to YouTube rather than just to our own row.
  if (retitle) {
    if (!game.yt_video_id)
      return Response.json({ error: "not on YouTube yet" }, { status: 409 });
    if (!youtubeConfigured())
      return Response.json({ error: "YouTube not configured — run `npm run yt-auth`" },
        { status: 400 });
    try {
      const r = await updateVideoTitle(game.yt_video_id, youtubeTitle(game));
      return Response.json({ ok: true, ...r });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502 });
    }
  }

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
      title: youtubeTitle(game),
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
// The whole point of the migration, and the only irreversible step.
//
// The preconditions and the filesystem work live in lib/reclaim.js, because
// the Finish-up batch on /shorts runs exactly the same thing across N games
// and two copies would drift. This route is now the single-game door to it.
export async function DELETE(req) {
  if (!await guard()) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await req.json();
  const r = reclaimLocalVideo(id);
  if (!r.ok)
    return Response.json({ error: r.error, stage: r.stage }, { status: r.status });
  return Response.json({ ok: true, freed_bytes: r.freed_bytes, freed: r.freed });
}
