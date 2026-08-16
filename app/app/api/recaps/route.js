import { db } from "@/lib/db";
import { getSessionUser, isOrganizer } from "@/lib/auth";
import { sendMail } from "@/lib/mail";
import { nightRows, rowFor, recipientsFor, recapMail, recapUrl } from "@/lib/recap";
import { nightSummary, summaryText } from "@/lib/night-summary";

// Sending a night's recaps.
//
// Everything that decides WHAT to send lives in lib/recap.js; this route
// decides WHEN, records what happened, and makes sure it can't happen twice.

const bad = (error, status = 400) => Response.json({ error }, { status });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Resend's free tier rate-limits requests per second. 23 recipients is not
// worth being clever about — just walk them.
const GAP_MS = 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const origin = req => process.env.APP_URL || new URL(req.url).origin;

// GET ?day=YYYY-MM-DD -> that night's recipients. No ?day -> the nights that
// have published games, newest first, for the picker.
export async function GET(req) {
  if (!isOrganizer(await getSessionUser())) return bad("forbidden", 403);
  const d = db();
  const day = new URL(req.url).searchParams.get("day");

  if (!day) {
    const days = d.prepare(
      `SELECT played_on AS day, COUNT(*) AS games FROM games
       WHERE published = 1 AND played_on IS NOT NULL
       GROUP BY played_on ORDER BY played_on DESC`).all().map(r => ({ ...r }));
    return Response.json({ days });
  }
  if (!DAY.test(day)) return bad("bad day");
  const people = recipientsFor(d, day).map(r => ({ ...r,
    url: recapUrl(origin(req), r.slug, day) }));
  // The group blurb rides along on the same request the picker already makes,
  // so it can't fall out of step with the night selected below it. Same
  // nightRows() the sends use — one answer to "what happened", as ever.
  const summary = nightSummary(nightRows(d, day),
    { date: day, origin: origin(req) });
  return Response.json({ day, recipients: people,
    summary, summaryText: summaryText(summary) });
}

export async function POST(req) {
  const user = await getSessionUser();
  if (!isOrganizer(user)) return bad("forbidden", 403);
  const body = await req.json().catch(() => null);
  if (!body || !DAY.test(body.day || "")) return bad("bad day");
  const d = db();
  const day = body.day;

  const people = recipientsFor(d, day);
  if (!people.length) return bad("nobody was filmed that night", 404);

  // One night's numbers, computed once and shared by every recipient — and by
  // the page they're being linked to (lib/recap.js).
  const { rows } = nightRows(d, day);
  const compose = p => recapMail({
    display_name: p.display_name, stats: rowFor(rows, p.player_id),
    date: day, url: recapUrl(origin(req), p.slug, day) });

  if (body.action === "preview") {
    const p = people.find(x => x.player_id === +body.player_id) ?? people[0];
    const stats = rowFor(rows, p.player_id);
    if (!stats) return bad("no stats for that player that night");
    return Response.json({ to: p.email, player: p.display_name, ...compose(p) });
  }

  if (body.action !== "send") return bad("unknown action");

  // "Send to me only" — the organizer's own address, the real mail, before 23
  // other people see it. Still uses the same compose path; only the recipient
  // differs, so what lands in the inbox is what everyone else would get.
  if (body.test) {
    const p = people.find(x => x.player_id === +body.player_id) ?? people[0];
    const mail = compose(p);
    try {
      const r = await sendMail({ to: user.email, ...mail });
      return Response.json({ ok: true, test: true, to: user.email, dev: !!r.dev });
    } catch (e) { return bad(e.message, 502); }
  }

  const want = Array.isArray(body.player_ids) ? new Set(body.player_ids.map(Number)) : null;
  const queue = people.filter(p => (!want || want.has(p.player_id)) && !p.sent);
  if (!queue.length) return Response.json({ ok: true, sent: [], skipped: people.length });

  // The ledger write is what makes a send unrepeatable, so it happens per
  // recipient as we go: a crash halfway through leaves an accurate record of
  // who was already mailed rather than an all-or-nothing lie.
  const record = d.prepare(
    `INSERT INTO recaps (player_id, played_on, email, status, error)
     VALUES (?, ?, ?, ?, ?)`);
  const results = [];
  for (const [i, p] of queue.entries()) {
    const stats = rowFor(rows, p.player_id);
    if (!stats) continue;                       // filmed but no graded touches
    if (i > 0) await sleep(GAP_MS);
    let status = "sent", error = null;
    try {
      const r = await sendMail({ to: p.email, ...compose(p) });
      if (r.dev) status = "sent";               // no API key: logged, not mailed
    } catch (e) {
      // one bad address must not abort the other 22
      status = "failed"; error = String(e.message).slice(0, 500);
    }
    try { record.run(p.player_id, day, p.email, status, error); }
    catch { /* unique index: already sent, nothing to record */ }
    results.push({ player: p.display_name, email: p.email, status, error });
  }
  return Response.json({ ok: true, sent: results });
}

// DELETE ?day=&player_id= -> forget a send, so it can go out again. Deliberate
// and one at a time: re-sending is a decision, not a retry button.
export async function DELETE(req) {
  if (!isOrganizer(await getSessionUser())) return bad("forbidden", 403);
  const q = new URL(req.url).searchParams;
  const day = q.get("day"), pid = +q.get("player_id");
  if (!DAY.test(day || "") || !pid) return bad("day and player_id required");
  db().prepare("DELETE FROM recaps WHERE played_on = ? AND player_id = ?").run(day, pid);
  return Response.json({ ok: true });
}
