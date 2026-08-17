// Reclaiming a game's local mp4 — the one irreversible step in the YouTube
// migration, and the only place in the app that deletes multi-GB media.
//
// Extracted from app/api/youtube/route.js (which now calls it) because the
// Finish-up batch on /shorts has to run the SAME preconditions and the same
// error taxonomy across N games. Two copies of this would drift, and the
// branch that matters most — the EACCES diagnostic — is thirty lines of
// hard-won detail about media folders created by a root CLI import not being
// writable by the service user.
//
// Two entry points, and the split is the point:
//   reclaimPreflight   read-only. Answers "could this game be reclaimed, and
//                      how many bytes would it free?" so the confirm dialog's
//                      GB total and the guard that enforces it are one piece
//                      of code rather than two that can disagree.
//   reclaimLocalVideo  does it. RETURNS a result, never throws — a batch
//                      action must not report one game's EACCES as a failure
//                      of the whole batch.
import fs from "fs";
import path from "path";
import { db } from "./db.js";
import { pendingWork } from "./shorts.js";

const absOf = videoFile =>
  path.join(process.cwd(), "public", String(videoFile).replace(/^\//, ""));

// A game video is always GB-scale, but a partial file or a batch total need
// not be — and "0.00 GB" after a successful delete reads as "freed nothing",
// which is the opposite of what happened. Same rule as the UI's formatter.
export const gb = bytes => bytes >= 2 ** 30
  ? (bytes / 2 ** 30).toFixed(2) + " GB"
  : Math.round(bytes / 2 ** 20) + " MB";

/**
 * Can this game's local video be reclaimed right now?
 *
 * @param {object} game  a games row
 * @param {object} [opts]
 * @param {boolean} [opts.assumeShortsDone]  treat shorts_done as already set.
 *   ONLY for the Finish-up preview: that action sets shorts_done and THEN
 *   reclaims, so a preview evaluated against the current row would report
 *   every game as un-reclaimable and total "0 MB" — while the action it is
 *   previewing goes on to delete several GB. A confirm dialog that understates
 *   what it is about to destroy is the one direction this must never fail in.
 *   Every enforcing caller leaves this off, so shorts_done stays a hard gate.
 * @returns {{ok: true, bytes: number} | {ok: false, reason: string,
 *            status: number, bytes: number}}
 */
export function reclaimPreflight(game, { assumeShortsDone = false } = {}) {
  const no = (reason, status = 409) => ({ ok: false, reason, status, bytes: 0 });
  if (!game) return no("no such game", 404);
  if (!game.yt_video_id)
    return no("not on YouTube — refusing to delete the only copy");
  if ((game.media_state ?? "local") !== "both")
    return no("local video already reclaimed");
  // The local mp4 is the ONLY thing a Short can be rendered from — the
  // YouTube copy can't be pulled back down for that. So deleting it closes
  // the door on this game's highlights permanently, and that has to be a
  // decision, not a side effect of tidying up disk.
  if (!assumeShortsDone && !game.shorts_done)
    return no("Shorts aren't marked done for this game. The local video is " +
      "the only source a Short can be rendered from, so this would " +
      "permanently close the door. Finish picking Shorts, then mark them " +
      "done on /shorts.");
  const { renders, posts } = pendingWork(game.id);
  if (renders)
    return no(`${renders} short(s) still rendering from this video`);
  // Reclaim doesn't touch the Shorts mp4s, so an upload in flight isn't a
  // corruption risk — but a game still uploading isn't finished, and letting
  // it through would put the purge ahead of the thing that gates it.
  if (posts) return no(`${posts} short(s) still uploading`);

  // Size is best-effort: a missing file is not a blocker (reclaim treats it
  // as "already gone, record the state"), it just frees nothing.
  let bytes = 0;
  if (game.video_file?.startsWith("/media/")) {
    try { bytes = fs.statSync(absOf(game.video_file)).size; } catch {}
  }
  return { ok: true, bytes };
}

/**
 * Delete the local mp4 and move the game to media_state='youtube'.
 *
 * Everything here touches the filesystem, and an uncaught throw in a route
 * handler makes Next return a 500 with an EMPTY body — which the browser then
 * reports as "Unexpected end of JSON input", a message that says nothing
 * about the actual failure. So every exit is a value.
 *
 * @returns {{ok: true, freed_bytes: number, freed: string} |
 *           {ok: false, error: string, stage: string, status: number}}
 */
export function reclaimLocalVideo(gameId) {
  const game = db().prepare("SELECT * FROM games WHERE id = ?").get(gameId);
  const pre = reclaimPreflight(game);
  if (!pre.ok) return { ok: false, error: pre.reason, stage: "preflight",
    status: pre.status };

  let stage = "start";
  let freed = 0;
  try {
    if (game.video_file?.startsWith("/media/")) {
      stage = "resolve";
      const abs = absOf(game.video_file);
      stage = "stat";
      // statSync rather than existsSync-then-stat: the two-call version has a
      // race, and a broken symlink passes existsSync but throws on stat.
      let st = null;
      try { st = fs.statSync(abs); }
      catch (e) { if (e.code !== "ENOENT") throw e; }

      if (st) {
        if (!st.isFile())
          return { ok: false, stage: "stat", status: 409,
            error: `${game.video_file} is not a regular file` };

        // Deleting a file needs write+execute on its DIRECTORY — the file's
        // own mode is irrelevant. Media folders created by a root CLI import
        // aren't writable by the service user, so reclaim fails per-game
        // depending on who imported it. Check before touching anything, so
        // this is a clean 409 rather than a half-done delete.
        stage = "access";
        const dir = path.dirname(abs);
        try { fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK); }
        catch {
          const d = fs.statSync(dir);
          return { ok: false, stage: "access", status: 409, error:
            `Can't delete files in ${path.dirname(game.video_file)} — the app ` +
            `doesn't have write permission on that directory (uid ${d.uid}, ` +
            `mode ${(d.mode & 0o777).toString(8)}; this process runs as uid ` +
            `${process.getuid?.() ?? "?"}). Unlinking needs write+execute on the ` +
            `FOLDER, not the file. Fix with: chown -R <service-user> ` +
            `public/media` };
        }

        freed = st.size;
        stage = "unlink";
        fs.rmSync(abs, { force: true });
      }
      // st === null means the file is already gone. Not an error: finish the
      // job by recording the state the disk is actually in.
    }

    stage = "db";
    db().prepare("UPDATE games SET media_state = 'youtube' WHERE id = ?")
      .run(gameId);
  } catch (e) {
    console.error(`reclaim failed for game ${gameId} at stage "${stage}":`, e);
    // If the file went but the DB update didn't, say so plainly — the row is
    // now lying about what's on disk and someone has to know.
    const orphaned = stage === "db";
    return { ok: false, stage, status: 500,
      error: `Reclaim failed while ${{
        resolve: "resolving the video path", stat: "reading the video file",
        access: "checking directory permissions",
        unlink: "deleting the video file", db: "updating the database",
      }[stage] || stage}: ${e.code ? e.code + " — " : ""}${e.message}` +
        (e.code === "EACCES" || e.code === "EPERM"
          ? " — deleting a file needs write permission on its FOLDER, not the " +
            "file. Likely this game was imported by a different user than the " +
            "one the app runs as; `chown -R <service-user> public/media` fixes it."
          : "") +
        (orphaned ? " ⚠ The local file WAS deleted but the game still says " +
          "'both'. Re-run reclaim to correct the record." : "") };
  }

  return { ok: true, freed_bytes: freed, freed: gb(freed) };
}
