import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
import RosterImport from "./ui";
export const dynamic = "force-dynamic";

// Step 0 of player accounts: teach the site which email is which player.
//
// Registration lives in Luma and the iCal feed lib/luma.js reads carries no
// attendees (see the header there), so the roster arrives as a paste. This
// page turns that paste into users.player_id rows — nothing more. No mail is
// sent from here and nothing public changes.

export default async function Page() {
  if (!isOrganizer(await getSessionUser())) redirect("/login");
  const d = db();

  const players = d.prepare(
    `SELECT id, display_name FROM players ORDER BY display_name COLLATE NOCASE`)
    .all().map(p => ({ ...p }));

  // how many games each player actually appears in — the organizer is matching
  // a name to a person, and "3 games" separates a real regular from a stray row
  const games = d.prepare(
    `SELECT player_id, COUNT(DISTINCT game_id) n FROM identities
     WHERE player_id IS NOT NULL AND dismissed = 0 AND merged_into IS NULL
     GROUP BY player_id`).all();
  const gameMap = new Map(games.map(g => [g.player_id, g.n]));
  for (const p of players) p.games = gameMap.get(p.id) || 0;

  const links = d.prepare(
    `SELECT email, player_id FROM users WHERE player_id IS NOT NULL`).all();

  return <RosterImport players={players}
    links={Object.fromEntries(links.map(l => [l.email, l.player_id]))} />;
}
