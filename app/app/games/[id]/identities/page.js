import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
import IdentityGrid from "./ui";
export const dynamic = "force-dynamic";

function cosine(a, b) {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export default async function Page({ params }) {
  if (!isOrganizer(await getSessionUser())) redirect("/login");
  const { id } = await params;
  const d = db();
  const game = d.prepare("SELECT * FROM games WHERE id = ?").get(id);
  // servable full-game video (v8 bundles) -> enables the court-view popup
  const courtVideo = game?.video_file?.startsWith("/media/") ? game.video_file : null;
  const rallyStarts = d.prepare(
    `SELECT start_s FROM rallies WHERE game_id = ? AND phase = 'game'
     ORDER BY start_s`).all(id).map(r => r.start_s);
  const idents = d.prepare(
    `SELECT * FROM identities WHERE game_id = ? AND dismissed = 0
     AND merged_into IS NULL ORDER BY n_boxes DESC`).all(id);
  const trs = d.prepare(
    `SELECT id, identity_id, rally_idx, t0, crops, typicality FROM tracklets
     WHERE game_id = ? ORDER BY COALESCE(typicality, -1) DESC, t0`).all(id);
  const playCounts = d.prepare(
    `SELECT p.cluster_id, COUNT(*) n FROM plays p
     JOIN rallies r ON r.id = p.rally_id
     WHERE r.game_id = ? AND p.deleted = 0 AND p.cluster_id IS NOT NULL
     GROUP BY p.cluster_id`).all(id);
  const pc = Object.fromEntries(playCounts.map(r => [r.cluster_id, r.n]));

  // Team suggestions from touch positions: players stay on one side of the
  // net all game, so the median contact-x per player lands left or right of
  // the net (~ the median of all contact-x). A = left, B = right.
  const xs = d.prepare(
    `SELECT p.cluster_id, p.x FROM plays p JOIN rallies r ON r.id = p.rally_id
     WHERE r.game_id = ? AND p.deleted = 0 AND p.x IS NOT NULL
     AND p.cluster_id IS NOT NULL`).all(id);
  const teamSuggest = {};
  if (xs.length >= 8) {
    const median = a => { const s = [...a].sort((p, q) => p - q);
      return s.length % 2 ? s[(s.length - 1) / 2]
        : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    const netX = median(xs.map(r => r.x));
    const byCluster = {};
    for (const r of xs) (byCluster[r.cluster_id] ??= []).push(r.x);
    for (const i of idents) {
      const v = byCluster[i.cluster_id];
      if (!v || v.length < 2) continue;
      const left = v.filter(x => x < netX).length;
      const frac = Math.max(left, v.length - left) / v.length;
      if (frac >= 0.7)   // consistent side -> confident suggestion
        teamSuggest[i.id] = { team: left > v.length - left ? "A" : "B",
          conf: Math.round(frac * 100) };
    }
  }

  const byIdent = {};
  for (const t of trs)
    (byIdent[t.identity_id] ??= []).push({ ...t, crops: JSON.parse(t.crops) });
  const rows = idents.map(i => ({
    ...i,
    rep_crops: JSON.parse(i.rep_crops),
    embedding: undefined,
    play_count: pc[i.cluster_id] || 0,
    tracklets: (byIdent[i.id] || []).filter(t => t.crops.length),
  }));

  // the global player roster for the naming typeahead (pick existing / create
  // new). game counts disambiguate duplicate display_names.
  const players = d.prepare(
    `SELECT p.id, p.display_name,
            COUNT(DISTINCT i.game_id) AS games
     FROM players p
     LEFT JOIN identities i ON i.player_id = p.id
       AND i.dismissed = 0 AND i.merged_into IS NULL
     GROUP BY p.id ORDER BY p.display_name COLLATE NOCASE`).all()
    .map(p => ({ ...p, games: Number(p.games) }));

  // cross-game name suggestions: match unnamed identities against named ones
  // from OTHER games (same-night games share clothing -> embeddings transfer).
  // Carry the matched identity's player_id so accepting links the SAME player.
  const namedElsewhere = d.prepare(
    `SELECT name, embedding, game_id, player_id FROM identities
     WHERE game_id != ? AND name IS NOT NULL AND name != '' AND embedding IS NOT NULL
     AND dismissed = 0 AND merged_into IS NULL`).all(id)
    .map(r => ({ name: r.name, game_id: r.game_id, player_id: r.player_id,
      emb: JSON.parse(r.embedding) }));
  const nameSuggestions = {};
  if (namedElsewhere.length) {
    for (const i of idents) {
      if (i.name || !i.embedding) continue;
      const e = JSON.parse(i.embedding);
      let best = null;
      for (const cand of namedElsewhere) {
        const sim = cosine(e, cand.emb);
        if (sim > 0.82 && (!best || sim > best.sim)) best = { ...cand, sim };
      }
      if (best) nameSuggestions[i.id] = { name: best.name,
        player_id: best.player_id, sim: Math.round(best.sim * 100) };
    }
  }

  return (
    <div>
      <h1>Name the players</h1>
      <p className="muted">
        Only players involved in scored touches need names — the rest are optional.
        Then head to <a href={`/games/${id}/review`}>play review</a>.
      </p>
      <IdentityGrid idents={rows} gameId={id} nameSuggestions={nameSuggestions}
        players={players} teamSuggest={teamSuggest} courtVideo={courtVideo}
        rallyStarts={rallyStarts} />
    </div>
  );
}
