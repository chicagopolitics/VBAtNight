import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
import Review from "./ui";
export const dynamic = "force-dynamic";

export default async function Page({ params }) {
  if (!isOrganizer(await getSessionUser())) redirect("/login");
  const { id } = await params;
  const d = db();
  const game = d.prepare("SELECT * FROM games WHERE id = ?").get(id);
  // servable full-game video (v8 bundles); older games have a pipeline path here
  const video = game?.video_file?.startsWith("/media/") ? game.video_file : null;
  const rallies = d.prepare(
    `SELECT * FROM rallies WHERE game_id = ? AND phase IN ('game','skipped')
     ORDER BY start_s`).all(id);
  const idents = d.prepare(
    `SELECT id, cluster_id, name, team FROM identities
     WHERE game_id = ? AND dismissed = 0 AND merged_into IS NULL`).all(id);
  const plays = d.prepare(
    `SELECT p.* FROM plays p JOIN rallies r ON r.id = p.rally_id
     WHERE r.game_id = ? AND p.deleted = 0 ORDER BY p.t`).all(id);
  const plain = x => x.map(r => ({ ...r }));
  return <Review rallies={plain(rallies)} idents={plain(idents)} plays={plain(plays)}
                 video={video} />;
}
