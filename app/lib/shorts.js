// Shared helpers for the Shorts queue — used by both the API routes and the
// render worker, so the two can't drift on where files live or what a status
// means. See YOUTUBE-PLAN.md.
import fs from "fs";
import path from "path";

export const STATUSES = ["queued", "rendering", "ready", "published", "failed"];

export function mediaDir(gameId) {
  return path.join(process.cwd(), "public", "media", String(gameId));
}
export function shortsDir(gameId) {
  return path.join(mediaDir(gameId), "shorts");
}
// public URL <-> disk path. The DB stores the URL form (like video_file).
export function shortUrl(gameId, id) { return `/media/${gameId}/shorts/${id}.mp4`; }
export function shortPath(gameId, id) { return path.join(shortsDir(gameId), `${id}.mp4`); }

export function absFromUrl(url) {
  return path.join(process.cwd(), "public", String(url).replace(/^\//, ""));
}

// The two inputs a render needs, and why it might not have them.
export function renderInputs(game) {
  const video = game?.video_file?.startsWith("/media/")
    ? absFromUrl(game.video_file) : null;
  const json = path.join(mediaDir(game.id), "game.json");
  return {
    video, json,
    // the mp4 is gone once a game is purged — that's the whole reason purge
    // is gated on shorts_done
    hasVideo: !!video && fs.existsSync(video),
    // games imported before game.json was retained have no ball track;
    // scripts/backfill-gamejson.mjs fixes those
    hasJson: fs.existsSync(json),
  };
}

// Why can't this game have Shorts made right now? null = it can.
export function blockedReason(game) {
  if (!game) return "no such game";
  const { hasVideo, hasJson } = renderInputs(game);
  if ((game.media_state ?? "local") === "youtube" || !hasVideo)
    return "the local video was reclaimed — re-import the bundle to make Shorts";
  if (!hasJson)
    return "no game.json for this game (imported before it was retained) — " +
      "run: node scripts/backfill-gamejson.mjs " + game.id + " <path to game.json>";
  return null;
}

// CLI arguments locating this Short in the video.
//
// Rally index is how shorts.py addresses a rally (--rally N indexes
// game.json's rallies array), so a rally the reviewer ADDED by hand (idx -1,
// no pipeline counterpart) has to be given explicit timestamps instead.
//
// With an anchor play, the renderer builds a MOMENT window instead: that
// play plus `lead` touches of run-up. A hand-added rally can't do that —
// --anchor needs --rally to find the contact list — so it falls back to a
// fixed window around the play.
export function rallyRef(rally, short = {}, play = null, contacts = null) {
  const known = rally.idx >= 0;
  // Reviewed touches and boundaries, always when we have them. game.json's
  // own contacts are raw detections — on game 13, 274 of 606 are phantoms
  // the reviewer deleted — so counting touches through them puts the clip's
  // start in an arbitrary place. See moment_window in shorts.py.
  const reviewed = [];
  if (contacts?.length) reviewed.push("--contacts", contacts.join(","));
  reviewed.push("--bounds", `${rally.start_s},${rally.end_s}`);

  // After the play, swing back to the scoring side to catch the reaction.
  // The attacker's own contact x IS that side, so no team lookup is needed.
  // Only when we have a position — a touch the reviewer added by hand has
  // none, and guessing the wrong half of the court is worse than not moving.
  const reaction = play?.x != null ? ["--reaction-x", String(play.x)] : [];

  if (play && known)
    return ["--rally", String(rally.idx), "--anchor", String(play.t),
      "--lead", String(short.lead ?? 4), ...reviewed, ...reaction];
  // a hand-added rally has no counterpart in game.json, so --rally can't
  // name it and the moment gets a fixed window instead
  if (play)
    return ["--t0", String(Math.max(0, play.t - 6)), "--t1", String(play.t + 2.5)];
  return known
    ? ["--rally", String(rally.idx), ...reviewed]
    : ["--t0", String(rally.start_s - 1.5), "--t1", String(rally.end_s + 1.5)];
}
