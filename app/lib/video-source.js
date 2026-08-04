// The single place a rally becomes something you can play.
//
// Two transports, one concept — play [start, end] of a game's video:
//   file    <video src="/media/13/game.mp4#t=112.4,131.0">   (media fragment)
//   youtube <iframe src=".../embed/<id>?start=112&end=131">  (player params)
//
// Why this module exists: before it, the cue-window arithmetic lived inline
// in watch/ui.js and again in review/ui.js, so adding a transport meant
// editing playback logic in two places and hoping they agreed. Now the
// window math is shared and only the transport differs.
//
// IMPORTANT: the review page (/games/<id>/review) deliberately does NOT use
// this module's youtube branch. Review needs sub-second seeking, ±0.5s wheel
// scrubs and instant currentTime reads to timestamp touches; an iframe over
// the network can't do that. Review is local-file-only, forever — pass
// prefer:"file" and handle null. See YOUTUBE-PLAN.md.
//
// No imports: this is used from client components.

// Pad applied around a rally so you see the serve toss and the celebration.
export const PAD_BEFORE = 2;
export const PAD_AFTER = 2;

// Extra lead-in for YouTube only.
//
// YouTube picks playback quality by measuring the connection *while it
// streams*, starting from a conservative guess. On a 10-minute video you
// never notice the ramp; on a 15-second rally the ramp IS the clip, and the
// serve arrives while the picture is still mush.
//
// We can't override that — setPlaybackQuality and the suggestedQuality
// argument are both no-ops now. What we CAN do is give the ramp somewhere
// harmless to happen: start a few seconds earlier, so the blurry moment is
// players walking to position instead of the first contact.
export const YT_LEAD_IN = 3;

// Where the rally's media begins in GAME time.
// Old bundles cut per-rally clips (clip_file), so a clip's t=0 is somewhere
// into the game; v8 bundles ship the whole game, so t=0 is game t=0.
export function clipStart(rally) {
  if (!rally?.clip_file) return 0;
  return rally.clip_start_s ?? rally.start_s - PAD_BEFORE;
}

// The [from, to] window in GAME time for a rally.
//   at        - cue near this game-time instead of the rally start (a
//               specific touch the viewer filtered for)
//   atEnd     - cue near the rally's end (outcome stats: the point-winning
//               play, which is by definition the last thing that happens)
// Both clamp to the rally so a bad timestamp can't cue outside the action.
export function rallyWindow(rally, { at = null, atEnd = false } = {}) {
  const open = rally.start_s - PAD_BEFORE;
  let from = open;
  if (atEnd) from = Math.max(open, rally.end_s - 6);
  else if (at != null) from = Math.max(open, at - 3);
  return { from: Math.max(0, from), to: rally.end_s + PAD_AFTER };
}

// Does this game have a usable YouTube export?
// media_state null is read as 'local' so pre-migration rows need no backfill.
export function hasYouTube(game) {
  return !!(game?.yt_video_id && game.media_state !== "local");
}

// Is the local file still on disk? Only 'youtube' means reclaimed.
export function hasLocal(game) {
  return !!(game?.video_file?.startsWith("/media/")) &&
    (game.media_state ?? "local") !== "youtube";
}

// Resolve a rally to a playable source.
//
//   sourceFor(game, rally, { prefer: "file" })   -> file only, else null
//   sourceFor(game, rally, { at: 118.2 })        -> youtube if exported
//
// Returns null when nothing is playable (game archived to YouTube but the
// caller demanded a file, or media missing entirely) — callers render a
// placeholder rather than a broken <video>.
export function sourceFor(game, rally, opts = {}) {
  const { prefer = "youtube", ...cue } = opts;
  const { from, to } = rallyWindow(rally, cue);

  if (prefer !== "file" && hasYouTube(game)) {
    // start/end are integer seconds. Floor the start so we never clip the
    // first frame of the action; ceil the end for the same reason at the
    // tail. Sub-second cueing needs the IFrame API's seekTo(float) — see
    // the "sub-second cue points" note in YOUTUBE-PLAN.md.
    return { kind: "youtube", id: game.yt_video_id,
      start: Math.max(0, Math.floor(from - YT_LEAD_IN)), end: Math.ceil(to) };
  }

  // rally clip (legacy bundles) wins over the full-game file
  const base = rally.clip_file ||
    (game?.video_file?.startsWith("/media/") ? game.video_file : null);
  if (!base) return null;
  if (!rally.clip_file && (game.media_state ?? "local") === "youtube") return null;

  const cs = clipStart(rally);
  const frag = `#t=${Math.max(0, from - cs).toFixed(1)},${(to - cs).toFixed(1)}`;
  return { kind: "file", src: base + frag,
    start: Math.max(0, from - cs), end: to - cs };
}

// Privacy-preserving embed host: no cookie until the viewer hits play.
// Unlisted videos embed fine — the id is the capability.
//
// jsapi=true adds enablejsapi+origin so the parent page can drive playback
// via postMessage. That matters for warmed players: swapping the src to add
// autoplay=1 on click would reload the iframe and throw away the load, seek
// and buffering that warming just paid for.
export function embedUrl(src, { autoplay = false, jsapi = false, origin } = {}) {
  const p = new URLSearchParams({
    start: String(src.start), end: String(src.end),
    rel: "0", modestbranding: "1", playsinline: "1",
  });
  if (autoplay) p.set("autoplay", "1");
  if (jsapi) {
    p.set("enablejsapi", "1");
    // YouTube requires origin alongside enablejsapi; omitting it makes the
    // player reject our postMessage commands silently.
    const o = origin ?? (typeof window !== "undefined" ? window.location.origin : null);
    if (o) p.set("origin", o);
  }
  return `https://www.youtube-nocookie.com/embed/${src.id}?${p}`;
}
