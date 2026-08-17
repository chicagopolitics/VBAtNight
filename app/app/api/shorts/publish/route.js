// Queue rendered Shorts for upload. Organizer only.
//
//   POST { short_ids: [...] }   the explicit set — what /shorts always sends
//   POST { game_id: N }         convenience: every ready Short of one game
//        { dest: 'youtube' }    optional; only one destination exists today
//
// This does NOT upload. It writes short_posts rows and returns in
// milliseconds; scripts/publish-worker.mjs drains them and the page polls.
// That indirection is the whole reason a night's worth of Shorts can go out
// in one action — eight resumable uploads is minutes of network, and no HTTP
// request should be holding that open.
//
// The response carries the full review batch so the caller can replace its
// state wholesale rather than patching rows locally and hoping they match.
import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { queuePosts, listReviewBatch, DESTS } from "@/lib/publish-queue";
import { youtubeConfigured } from "@/lib/youtube";

export async function POST(req) {
  if (!isOrganizer(await getSessionUser()))
    return Response.json({ error: "forbidden" }, { status: 403 });

  const { short_ids, game_id, dest = "youtube" } = await req.json();
  if (!DESTS.includes(dest))
    return Response.json({ error: `unknown destination "${dest}"` }, { status: 400 });
  // Refuse the whole batch up front rather than writing N rows that will each
  // fail with the same message the moment a worker looks at them.
  if (dest === "youtube" && !youtubeConfigured())
    return Response.json({ error: "YouTube not configured — run `npm run yt-auth`" },
      { status: 400 });

  let ids = short_ids;
  if (!ids && game_id !== undefined) {
    // 'ready' only: a game's already-published Shorts must not be swept back
    // into a batch by a click on "Publish all".
    ids = db().prepare(
      "SELECT id FROM shorts WHERE game_id = ? AND status = 'ready' ORDER BY id")
      .all(game_id).map(r => r.id);
  }
  if (!Array.isArray(ids) || !ids.length)
    return Response.json({ error: "nothing to publish" }, { status: 400 });

  const { queued, skipped } = queuePosts(ids, dest);
  return Response.json({ ok: true, queued, skipped, ...listReviewBatch() });
}
