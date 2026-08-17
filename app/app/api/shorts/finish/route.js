// Finish up: mark Shorts done and reclaim the local video, for N games at
// once. Organizer only. This is the last step of the /shorts flow and the
// only one that deletes anything.
//
//   POST { game_ids: [...] }
//
// Per game, in this order:
//   1. still busy?      skip it, record why. NEVER abort the batch.
//   2. shorts_done = 1  the assertion that Ken is finished picking
//   3. reclaim preflight  not reclaimable (e.g. never uploaded to YouTube)?
//                         stop here — the game is done, it just keeps its video
//   4. reclaim          delete the multi-GB mp4, media_state -> 'youtube'
//
// Always answers 200 with a per-game `results` array. A batch action must not
// report one game's EACCES as a failure of the whole batch — that failure is
// real and per-game (media folders created by a root CLI import aren't
// writable by the service user), so the UI has to be able to show four ticks
// and one cross.
//
// shorts_done is deliberately NOT rolled back when the reclaim fails: it's a
// true statement about intent regardless of whether the disk came back, and
// it's reversible per game from the panel.
import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { pendingWork } from "@/lib/shorts";
import { reclaimPreflight, reclaimLocalVideo, gb } from "@/lib/reclaim";
import { listReviewBatch } from "@/lib/publish-queue";
import { displayName } from "@/lib/game-name";

export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });

  const { game_ids } = await req.json();
  if (!Array.isArray(game_ids) || !game_ids.length)
    return Response.json({ error: "no games given" }, { status: 400 });

  const d = db();
  const results = [];
  for (const id of game_ids) {
    const game = d.prepare("SELECT * FROM games WHERE id = ?").get(id);
    if (!game) {
      results.push({ game_id: id, name: `game ${id}`, ok: false,
        error: "no such game" });
      continue;
    }
    const name = displayName(game);
    const { renders, posts } = pendingWork(id);
    if (renders || posts) {
      results.push({ game_id: id, name, ok: false, skipped: true,
        error: [renders && `${renders} still rendering`,
                posts && `${posts} still uploading`].filter(Boolean).join(", ") });
      continue;
    }

    d.prepare("UPDATE games SET shorts_done = 1 WHERE id = ?").run(id);

    // Re-read: shorts_done is one of reclaim's preconditions, and we just set
    // it. Passing the stale row would refuse every first-time finish.
    const fresh = d.prepare("SELECT * FROM games WHERE id = ?").get(id);
    const pre = reclaimPreflight(fresh);
    if (!pre.ok) {
      // Not a failure — a game that was never uploaded to YouTube is finished,
      // it just keeps its video. The UI says which bucket each game is in.
      results.push({ game_id: id, name, ok: true, shorts_done: true,
        reclaimed: false, freed_bytes: 0, reason: pre.reason });
      continue;
    }
    const r = reclaimLocalVideo(id);
    results.push({ game_id: id, name, ok: r.ok, shorts_done: true,
      reclaimed: !!r.ok, freed_bytes: r.freed_bytes || 0, freed: r.freed,
      error: r.ok ? null : r.error, stage: r.stage });
  }

  const freed_bytes_total = results.reduce((a, r) => a + (r.freed_bytes || 0), 0);
  return Response.json({ ok: true, results, freed_bytes_total,
    freed_total: gb(freed_bytes_total), ...listReviewBatch() });
}
