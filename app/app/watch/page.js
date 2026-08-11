import { Suspense } from "react";
import { db } from "@/lib/db";
import { deriveGrades, teamMap, scoreFrom } from "@/lib/grades";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { blockedReason, publicCaption } from "@/lib/shorts";
import { displayName } from "@/lib/game-name";
import { nextSession } from "@/lib/luma";
import NightTheme from "../theme";
import TrackPageView from "../track";
import Highlights from "./ui";
export const dynamic = "force-dynamic";

export default async function Watch() {
  // public: anyone can watch published games
  const d = db();
  // ...but an organizer gets Shorts controls on the same page. This is where
  // the browsing tools already are (player + stat filters, outcome pills), so
  // hunting for clip-worthy rallies belongs here rather than in a second,
  // duplicate browser somewhere in the admin area.
  const admin = isOrganizer(await getSessionUser());
  // Newest night first, and within a night the last game first — what a
  // viewer wants after an evening is the game that just finished. id DESC is
  // the tiebreak for anything still undated.
  const games = d.prepare(
    `SELECT * FROM games WHERE published = 1
      ORDER BY played_on IS NULL, played_on DESC, slot DESC, id DESC`)
    .all().map(g => ({ ...g }));
  // The reel: published Shorts, for everyone.
  //
  // These are the only PUBLIC videos this site has — full games are unlisted,
  // so a Short is how someone finds their way here in the first place, and
  // until now nothing linked back to them. Note what this selects: the
  // published status and a real YouTube id, joined to a published game. A
  // Short whose game was later unpublished drops out of the reel with it.
  //
  // Only the two fields a link needs. The admin payload below still carries
  // the full rows (status, file paths, errors); a visitor gets none of that.
  const reel = d.prepare(
    `SELECT s.yt_video_id AS id, s.caption FROM shorts s
     JOIN games g ON g.id = s.game_id
     WHERE s.status = 'published' AND s.yt_video_id IS NOT NULL
       AND g.published = 1
     ORDER BY s.published_at IS NULL, s.published_at DESC, s.id DESC
     LIMIT 12`).all()
    // publicCaption is applied when a caption is persisted, so this is a
    // second pass over rows that may predate that — surnames must not reach
    // a public page just because a row is old.
    .map(s => ({ id: s.id, caption: publicCaption(s.caption) }));
  const data = games.map(g => {
    // per-game name resolution (cluster ids are game-local)
    const idents = d.prepare(
      `SELECT cluster_id, team, name IS NOT NULL AS named,
              COALESCE(name, 'P' || cluster_id) AS name FROM identities
       WHERE game_id = ? AND dismissed = 0 AND merged_into IS NULL`).all(g.id);
    const names = new Map(idents.map(i => [i.cluster_id, i.name]));
    const teams = teamMap(idents);
    const rallies = d.prepare(
      `SELECT r.*, i.name AS outcome_name FROM rallies r
       LEFT JOIN identities i ON i.game_id = r.game_id AND i.cluster_id = r.outcome_cluster
         AND i.dismissed = 0 AND i.merged_into IS NULL
       WHERE r.game_id = ? AND r.phase = 'game'
       -- id breaks the tie a split rally creates (two rows, one start_s), so
       -- the numbering here is deterministic and matches /r/<id>'s ordinal
       ORDER BY r.start_s, r.id`).all(g.id).map(r => ({ ...r }));
    const touches = d.prepare(
      `SELECT p.id, p.rally_id, p.t, p.play_type, p.cluster_id, p.grade FROM plays p
       JOIN rallies r ON r.id = p.rally_id
       WHERE r.game_id = ? AND p.deleted = 0 AND p.play_type IS NOT NULL
       ORDER BY p.t`).all(g.id);
    const byRally = new Map();
    for (const t of touches) {
      if (!byRally.has(t.rally_id)) byRally.set(t.rally_id, []);
      byRally.get(t.rally_id).push({ ...t });
    }
    // named players per team for the collapsed game card (unnamed
    // auto-detected clusters are noise, so they're left off the roster)
    const roster = t => idents.filter(i => i.named && i.team === t).map(i => i.name);
    // derived score (lib/grades.js) — shared with the rally permalink, which
    // runs the same arithmetic over the rallies up to one moment
    const score = scoreFrom(rallies, teams);
    // Shorts state, admin only — a public visitor gets none of this in their
    // payload, not merely a hidden button.
    const shorts = admin
      ? d.prepare("SELECT * FROM shorts WHERE game_id = ? ORDER BY id").all(g.id)
        .map(s => ({ ...s })) : [];
    return { id: g.id, name: displayName(g), video_file: g.video_file,
      // playback source resolution happens in lib/video-source.js — it needs
      // the YouTube export state as well as the local path
      yt_video_id: g.yt_video_id ?? null, media_state: g.media_state ?? "local",
      ...(admin ? { shorts, shorts_done: !!g.shorts_done,
        shorts_blocked: blockedReason(g) } : {}),
      // When it was PLAYED. Was created_at, which is when the bundle happened
      // to be imported — for the July games, the morning after.
      date: g.played_on ?? g.created_at?.slice(0, 10) ?? null, score,
      teamA: roster("A"), teamB: roster("B"),
      others: idents.filter(i => i.named && i.team !== "A" && i.team !== "B")
        .map(i => i.name),
      rallies: rallies.map(r => {
        // same derivation as the stats page, so leaderboard counts and the
        // clips a stat links to always agree
        const rows = byRally.get(r.id) || [];
        const grades = deriveGrades(rows, r, teams);
        return { ...r, touches: rows.map(t => ({ t: t.t, type: t.play_type,
          // the play id is what a Short anchors on (admin only — a public
          // visitor has no use for it and shouldn't be handed row ids)
          ...(admin ? { id: t.id } : {}),
          name: names.get(t.cluster_id) || null,
          grade: grades.get(t.id) || null })) };
      }) };
  });
  return (
    <>
      <NightTheme />
      <TrackPageView />
      <Suspense><Highlights games={data} reel={reel} admin={admin}
        session={await nextSession()} /></Suspense>
    </>
  );
}
