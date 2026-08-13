// One night, per player: the data behind /p/<slug>/<date> and the mail that
// links to it.
//
// Both live here for one reason — an email that says "4 kills" and a page that
// says 3 is worse than sending nothing. The page, the preview and the send all
// call nightRows(), so there is exactly one answer to "what did they do".

import { aggregate } from "./player-stats";
import { dayLabel } from "./game-name";
import { publicName, playerSlug } from "./public-name";

/**
 * Everything a recap needs for one published night.
 *
 * `published = 1` is the authorization, the same rule /watch and /r/<id>
 * enforce — an unpublished night simply has no games here, so nothing
 * downstream can leak a half-reviewed evening.
 *
 * @returns { games, idents, rallies, plays, rows } — rows keyed as in
 *          lib/player-stats.js (`pid:<id>` for linked players)
 */
export function nightRows(d, date) {
  const games = d.prepare(
    `SELECT * FROM games WHERE published = 1 AND played_on = ?
     ORDER BY slot, id`).all(date).map(g => ({ ...g }));
  if (!games.length)
    return { games: [], idents: [], rallies: [], plays: [], rows: [] };

  const ids = games.map(g => g.id);
  const qs = ids.map(() => "?").join(",");
  // every identity in those games, not just one player's — deriveGrades reads
  // team sides and touch adjacency, so a partial roster changes the grades
  const idents = d.prepare(
    `SELECT game_id, cluster_id, team, player_id,
            COALESCE(name, 'P' || cluster_id) AS name FROM identities
     WHERE game_id IN (${qs}) AND dismissed = 0 AND merged_into IS NULL`)
    .all(...ids).map(i => ({ ...i }));
  const rallies = d.prepare(
    `SELECT * FROM rallies WHERE game_id IN (${qs}) AND phase = 'game'
     ORDER BY start_s, id`).all(...ids).map(r => ({ ...r }));
  // `deleted = 0` alone, matching /stats — a recap's numbers sit next to a
  // link to that board and must not disagree with it
  const plays = d.prepare(
    `SELECT p.id, p.rally_id, p.t, p.play_type, p.cluster_id, p.grade FROM plays p
     JOIN rallies r ON r.id = p.rally_id
     WHERE r.game_id IN (${qs}) AND r.phase = 'game' AND p.deleted = 0
     ORDER BY p.t`).all(...ids).map(p => ({ ...p }));

  return { games, idents, rallies, plays,
    rows: aggregate(rallies, plays, idents) };
}

/** That night's row for one player, or null if they weren't filmed. */
export const rowFor = (rows, playerId) =>
  rows.find(r => r.key === `pid:${playerId}`) ?? null;

/** Points won — the one number worth leading with. */
export const pointsOf = s => s.kill + s.ace + s.stuff;

/**
 * Who should get a recap for `date`.
 *
 * Derived from the FOOTAGE, not the Luma roster. Only half the courts are
 * recorded, so a registrant who played on an unfilmed court has no touches
 * here and gets nothing — silence beats a summary that reads "you did
 * nothing". A registrant with no linked player is likewise absent, by the
 * join to users.
 */
export function recipientsFor(d, date) {
  const rows = d.prepare(
    `SELECT p.id AS player_id, p.display_name, u.email,
            COUNT(DISTINCT pl.id) AS touches
     FROM players p
     JOIN users u ON u.player_id = p.id
     JOIN identities i ON i.player_id = p.id
       AND i.dismissed = 0 AND i.merged_into IS NULL
     JOIN games g ON g.id = i.game_id AND g.published = 1 AND g.played_on = ?
     JOIN rallies r ON r.game_id = g.id AND r.phase = 'game'
     JOIN plays pl ON pl.rally_id = r.id AND pl.cluster_id = i.cluster_id
       AND pl.deleted = 0
     GROUP BY p.id, u.email
     ORDER BY p.display_name COLLATE NOCASE`).all(date).map(r => ({ ...r }));

  const sent = new Map(d.prepare(
    `SELECT player_id, status, error, sent_at FROM recaps WHERE played_on = ?`)
    .all(date).map(r => [r.player_id, { ...r }]));

  return rows.map(r => ({ ...r,
    slug: playerSlug({ id: r.player_id, display_name: r.display_name }),
    sent: sent.get(r.player_id) ?? null }));
}

/** Absolute URL of a player's recap. */
export const recapUrl = (origin, slug, date) => `${origin}/p/${slug}/${date}`;

/**
 * The email. Deliberately short: the page does the work, and a long mail just
 * delays the click. Plain text — it renders everywhere, can't break in a dark
 * client, and doesn't read as marketing.
 */
export function recapMail({ display_name, stats, date, url }) {
  const first = publicName(display_name) || display_name;
  const when = dayLabel(date) || date;
  const bits = [
    stats.kill && `${stats.kill} kill${stats.kill === 1 ? "" : "s"}`,
    stats.ace && `${stats.ace} ace${stats.ace === 1 ? "" : "s"}`,
    stats.stuff && `${stats.stuff} block${stats.stuff === 1 ? "" : "s"}`,
    stats.digOk && `${stats.digOk} dig${stats.digOk === 1 ? "" : "s"}`,
    stats.assist && `${stats.assist} assist${stats.assist === 1 ? "" : "s"}`,
  ].filter(Boolean);

  return {
    subject: `Your night at VB at Night — ${when}`,
    text: [
      `Hey ${first},`,
      "",
      bits.length
        ? `${when}: ${bits.join(", ")}.`
        : `Your clips and stats from ${when} are up.`,
      "",
      `Your plays and stats: ${url}`,
      "",
      "Share it with whoever you like — the link works for anyone.",
      "",
      "— VB at Night",
    ].join("\n"),
  };
}
