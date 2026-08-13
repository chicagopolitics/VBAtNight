import NightTheme from "../theme";
import TrackPageView from "../track";
import { db } from "@/lib/db";
import { aggregate } from "@/lib/player-stats";
import { displayName, dayLabel } from "@/lib/game-name";
import { nextSession } from "@/lib/luma";
import Boards from "./ui";
export const dynamic = "force-dynamic";

export default async function Stats({ searchParams }) {
  // public: stats cover published games only (enforced in the queries below)
  const d = db();

  // optional single-game view (?game=<id>, linked from the watch page)
  const sp = await searchParams;
  const reqId = /^\d+$/.test(sp?.game ?? "") ? +sp.game : null;
  const gameRow = reqId ? d.prepare(
    "SELECT * FROM games WHERE id = ? AND published = 1").get(reqId) : null;
  const game = gameRow ? { id: gameRow.id, name: displayName(gameRow) } : null;

  // The sessions a visitor can scope to: one row per evening that has
  // published games. Undated games (played_on null) belong to no session and
  // are only reachable through the all-games view or a ?game= link.
  const days = d.prepare(
    `SELECT played_on AS day, COUNT(*) AS games FROM games
     WHERE published = 1 AND played_on IS NOT NULL
     GROUP BY played_on ORDER BY played_on DESC`).all()
    .map(r => ({ day: r.day, games: r.games, label: dayLabel(r.day) }));

  // ?day=YYYY-MM-DD scopes every board to one session — all of that night's
  // games, which is how a night is counted everywhere else (resequenceNight
  // in lib/import.js). A ?game= wins when both are present: it's the narrower
  // ask, and it's the one /watch links carry.
  const reqDay = /^\d{4}-\d{2}-\d{2}$/.test(sp?.day ?? "") ? sp.day : null;
  const day = game ? null : days.find(x => x.day === reqDay) || null;

  // one seam, three queries: whatever scope is active becomes a predicate on
  // the games row every board already joins through
  const gf = game ? " AND g.id = ?" : day ? " AND g.played_on = ?" : "";
  const args = game ? [game.id] : day ? [day.day] : [];

  // published games, game-phase rallies, with per-game identity resolution
  const rallies = d.prepare(`
    SELECT r.id, r.game_id, r.outcome_type, r.outcome_cluster
    FROM rallies r JOIN games g ON g.id = r.game_id AND g.published = 1${gf}
    WHERE r.phase = 'game'`).all(...args).map(r => ({ ...r }));
  const plays = d.prepare(`
    SELECT p.id, p.rally_id, p.t, p.play_type, p.cluster_id, p.grade
    FROM plays p
    JOIN rallies r ON r.id = p.rally_id AND r.phase = 'game'
    JOIN games g ON g.id = r.game_id AND g.published = 1${gf}
    WHERE p.deleted = 0
    ORDER BY p.t`).all(...args).map(p => ({ ...p }));
  const idents = d.prepare(`
    SELECT i.game_id, i.cluster_id, i.team, i.player_id,
           COALESCE(i.name, 'P' || i.cluster_id) AS name
    FROM identities i
    JOIN games g ON g.id = i.game_id AND g.published = 1${gf}
    WHERE i.dismissed = 0 AND i.merged_into IS NULL`).all(...args).map(i => ({ ...i }));

  // shared with the recap page at /p/<slug>/<date> — see lib/player-stats.js
  const rows = aggregate(rallies, plays, idents);

  // ?players=A,B — the compare selection, read here rather than from a client
  // hook so the first paint already has it (no flash of the plain boards, no
  // hydration mismatch). Names, not keys: they're what a shared link should
  // read like, and what /watch already takes.
  const initialPlayers = String(sp?.players ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);

  return (
    <>
      <NightTheme />
      <TrackPageView />
      <Boards rows={rows} game={game} day={day} days={days}
        initialPlayers={initialPlayers} session={await nextSession()}
        nGames={new Set(rallies.map(r => r.game_id)).size}
        nScored={rallies.filter(r => r.outcome_type).length} />
    </>
  );
}
