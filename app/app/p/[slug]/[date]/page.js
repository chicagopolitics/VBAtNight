import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { nightRows, rowFor, pointsOf } from "@/lib/recap";
import { dayLabel } from "@/lib/game-name";
import { sourceFor } from "@/lib/video-source";
import { publicName, playerSlug, parsePlayerSlug } from "@/lib/public-name";
import { nextSession } from "@/lib/luma";
import NightTheme from "../../../theme";
import TrackPageView from "../../../track";
import { Clip } from "../../../clip";
import ShareButton from "../../../share";
import NextSession from "../../../next-session";
export const dynamic = "force-dynamic";

// One player, one night.
//
// The thing a rec-league player actually wants after an evening is not a
// leaderboard — it's "what did I do, and can I show someone?". /watch and
// /stats can already answer both (?player= + ?day= on one, ?day= + ?players=
// on the other), but neither is a URL you'd paste into a group chat, and
// neither opens ON you. This page is that URL.
//
// PUBLIC, deliberately. It's meant to be forwarded, and everything on it is
// already readable at /stats and /watch, so a login gate would buy friction
// and no privacy. Same bargain as /r/<id>: the link is the capability.
export const metadata = { robots: { index: false, follow: false } };

const PLAYS = [
  ["kill", "Kills"], ["ace", "Aces"], ["stuff", "Blocks"],
  ["digOk", "Digs"], ["assist", "Assists"], ["attack", "Attacks"],
  ["serve", "Serves"], ["receive", "Receives"],
];

export default async function Recap({ params }) {
  const { slug, date } = await params;
  const pid = parsePlayerSlug(slug);
  if (!pid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const d = db();
  const player = d.prepare("SELECT id, display_name FROM players WHERE id = ?").get(pid);
  if (!player) notFound();

  // The id resolved, so a stale name in the path is a rename, not a wrong
  // link — send them to the canonical spelling rather than 404 at someone who
  // did nothing wrong. Old email keeps working.
  const canonical = playerSlug(player);
  if (canonical && canonical !== slug) redirect(`/p/${canonical}/${date}`);

  // Shared with the mail that links here, so the two can never disagree —
  // and `published = 1` inside it is the authorization, the same rule /watch
  // and /r/<id> enforce.
  const { games, idents, rallies, rows } = nightRows(d, date);
  if (!games.length) notFound();

  const me = rowFor(rows, player.id);
  // Linked but not filmed. Half the courts are recorded, so this is a normal
  // Tuesday for someone — and an empty page reading "you did nothing" would be
  // worse than no page at all.
  if (!me) notFound();

  // their scoring rallies, newest game last — the reel, not the whole night
  const mine = new Set(idents.filter(i => i.player_id === player.id)
    .map(i => `${i.game_id}:${i.cluster_id}`));
  const byGame = new Map(games.map(g => [g.id, g]));
  const highlights = rallies
    .filter(r => ["kill", "ace", "block"].includes(r.outcome_type)
      && mine.has(`${r.game_id}:${r.outcome_cluster}`))
    .slice(0, 6)
    .map(r => ({ r, src: sourceFor(byGame.get(r.game_id), r) }));

  const first = publicName(player.display_name) || player.display_name;
  const when = dayLabel(date) || date;
  const points = pointsOf(me);
  const watch = `/watch?player=${encodeURIComponent(player.display_name)}&day=${date}`;

  return (
    <>
      <NightTheme />
      <TrackPageView />
      <article className="rp">
        <header className="rp-head good">
          <div className="rp-headtop">
            <h1>{first}&apos;s night</h1>
            <NextSession session={await nextSession()} />
          </div>
          <p className="muted rp-meta">
            {[when, `${me.games} game${me.games === 1 ? "" : "s"}`]
              .filter(Boolean).join(" · ")}
          </p>
          <p className="rp-score">
            <b>{points}</b>
            <span className="muted"> point{points === 1 ? "" : "s"} won</span>
          </p>
        </header>

        <div className="row" style={{ gap: 8, margin: "12px 0" }}>
          {PLAYS.filter(([k]) => me[k] > 0).map(([k, label]) => (
            <span className="chip" key={k} style={{ cursor: "default" }}>
              <b>{me[k]}</b> {label}
            </span>
          ))}
        </div>

        {highlights.length > 0 && <>
          <h2 className="rp-chain-h">
            {highlights.length === 1 ? "The moment" : "The moments"}
          </h2>
          {highlights.map(({ r, src }) => (
            <div key={r.id} style={{ marginBottom: 14 }}>
              {src
                ? <Clip src={src} label={`${r.outcome_type} — ${first}`} />
                : <p className="card muted">Video unavailable for this one.</p>}
              <a className="muted" href={`/r/${r.id}`}>Open this rally →</a>
            </div>
          ))}
        </>}

        <div className="rp-actions">
          {/* the primary verb on a page someone was sent */}
          <ShareButton path={`/p/${canonical}/${date}`} name={first}
            title={`${first}'s night`} label="Share this" />
          <a className="abtn" href={watch}>All my clips</a>
          <a className="abtn"
            href={`/stats?day=${date}&players=${encodeURIComponent(player.display_name)}`}>
            Full stats
          </a>
        </div>
      </article>
    </>
  );
}
