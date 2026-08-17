import { redirect } from "next/navigation";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { listReviewBatch } from "@/lib/publish-queue";
import { youtubeConfigured } from "@/lib/youtube";
import ShortsReview from "./ui";
export const dynamic = "force-dynamic";

// One page for everything that happens to a Short after it's picked: watch
// it, fix its caption, publish it, and — once the night's batch is out —
// mark the games done and take their disk back.
//
// It exists because that work used to be spread across two pages and a game's
// worth of scrolling: pick on /watch, scroll back up to that game's panel,
// open the mp4 in a new tab to preview, publish, then leave for the games
// list to reclaim. Picking still happens on /watch (its player and stat
// filters ARE the picking tool); everything after it happens here.
//
// listReviewBatch is called directly rather than through the API, so the
// first paint and the first poll are produced by the same code and cannot
// disagree.
export default async function ShortsPage() {
  if (!isOrganizer(await getSessionUser())) redirect("/watch");
  return <ShortsReview initial={{ ...listReviewBatch(),
    youtube_configured: youtubeConfigured() }} />;
}
