import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
import PublishToggle, { DeleteGame, ExportButton } from "./publish-toggle";
import { driveCanUpload } from "@/lib/drive";
export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getSessionUser();
  if (!isOrganizer(user)) redirect("/watch"); // public visitors land on Watch
  const games = db().prepare("SELECT * FROM games ORDER BY id DESC").all().map(g => ({ ...g }));
  const driveReady = driveCanUpload();
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Games</h1>
        <a href="/import"><button className="primary">+ Import game</button></a>
      </div>
      {games.length === 0 && (
        <p className="muted">
          No games yet. Import one with:{" "}
          <code>npm run import -- path/to/game.json "Game name" clips_dir crops_dir</code>
        </p>
      )}
      {games.map(g => (
        <div className="card row" key={g.id}>
          <div style={{ flex: 1 }}>
            <strong>{g.name}</strong>
            <div className="muted">{g.created_at}</div>
          </div>
          <PublishToggle id={g.id} published={!!g.published} />
          <ExportButton id={g.id} driveReady={driveReady} />
          <a href={`/games/${g.id}/identities`}><button>1 · Name players</button></a>
          <a href={`/games/${g.id}/review`}><button className="primary">2 · Review plays</button></a>
          <DeleteGame id={g.id} name={g.name} />
        </div>
      ))}
    </div>
  );
}
