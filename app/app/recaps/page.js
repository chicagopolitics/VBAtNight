import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
import { dayLabel } from "@/lib/game-name";
import RecapSender from "./ui";
export const dynamic = "force-dynamic";

// The step after publishing: tell the people who played that their night is up.
//
// Only nights with PUBLISHED games appear — the same gate the recap page
// itself enforces, so this list can't offer to mail a half-reviewed evening.

export default async function Page() {
  if (!isOrganizer(await getSessionUser())) redirect("/login");
  const days = db().prepare(
    `SELECT g.played_on AS day, COUNT(*) AS games,
            (SELECT COUNT(*) FROM recaps WHERE played_on = g.played_on) AS sent
     FROM games g
     WHERE g.published = 1 AND g.played_on IS NOT NULL
     GROUP BY g.played_on ORDER BY g.played_on DESC`).all()
    .map(r => ({ ...r, label: dayLabel(r.day) || r.day }));

  return <RecapSender days={days} />;
}
