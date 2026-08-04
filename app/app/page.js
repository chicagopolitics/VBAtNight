import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
import PublishToggle, { DeleteGame, ExportButton, YouTubeCell, GameDate } from "./publish-toggle";
import { driveCanUpload } from "@/lib/drive";
import { youtubeConfigured } from "@/lib/youtube";
import { displayName, needsDate } from "@/lib/game-name";
export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getSessionUser();
  if (!isOrganizer(user)) redirect("/watch"); // public visitors land on Watch
  // Chronological, not by id: id is import order, which for the two 2026-07
  // games is the reverse of play order. Undated games sort to the top so the
  // thing that needs a decision is the thing you see first.
  const games = db().prepare(
    `SELECT * FROM games ORDER BY (played_on IS NULL) DESC, played_on DESC,
            slot DESC, id DESC`).all().map(g => ({ ...g }));
  const driveReady = driveCanUpload();
  const ytReady = youtubeConfigured();
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Games</h1>
        <a href="/import"><button className="primary">+ Import game</button></a>
      </div>
      {games.length === 0 && (
        <p className="muted">
          No games yet. Import one with:{" "}
          <code>npm run import -- path/to/game.json clips_dir crops_dir</code>
        </p>
      )}
      {games.map(g => (
        <div className="card row" key={g.id}>
          <div style={{ flex: 1 }}>
            <strong>{displayName(g)}</strong>
            <GameDate id={g.id} playedOn={g.played_on} label={g.label}
              needsDate={needsDate(g)} />
          </div>
          <PublishToggle id={g.id} published={!!g.published} />
          <YouTubeCell id={g.id} videoId={g.yt_video_id}
            mediaState={g.media_state} canUpload={ytReady} />
          <ExportButton id={g.id} driveReady={driveReady} />
          <a href={`/games/${g.id}/identities`}><button>1 · Name players</button></a>
          <a href={`/games/${g.id}/review`}><button className="primary">2 · Review plays</button></a>
          <DeleteGame id={g.id} name={displayName(g)} />
        </div>
      ))}
    </div>
  );
}
