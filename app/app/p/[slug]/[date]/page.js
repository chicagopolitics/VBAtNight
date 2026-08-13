import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { nightRows, rowFor, pointsOf } from "@/lib/recap";
import { teamMap, scoreFrom, outcomeLabel, deriveGrades, STATS, FAULTS } from "@/lib/grades";
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

// The default view: every point they won. Not a stat key of its own — it's
// the union of the three that end a rally in your favour, which is also
// exactly what the "N points won" heading counts. The two must agree; a
// header claiming 10 above a reel of 6 is the bug this replaced.
const POINTS = ["kill", "ace", "stuff"];

// Chip order. Points first because that's what a recap is for, then the
// volume stats, then quality — faults last and set apart (see below).
const CHIPS = ["kill", "ace", "stuff", "attack", "dig_kept", "assist",
  "serve", "receive", "set", "block", "rec_pos",
  "attack_error", "service_error", "blocked", "set_error", "dig_error", "rec_error"];

// Short chip labels. STATS.label is written for a filter dropdown ("digs kept
// in play"); a chip has room for two words.
const SHORT = {
  kill: "Kills", ace: "Aces", stuff: "Blocks", attack: "Attacks",
  dig_kept: "Digs", assist: "Assists", serve: "Serves", receive: "Receives",
  set: "Sets", block: "Block touches", rec_pos: "Good passes",
  attack_error: "Attack errors", service_error: "Serve errors",
  blocked: "Got blocked", set_error: "Set errors", dig_error: "Dig errors",
  rec_error: "Pass errors",
};

export default async function Recap({ params, searchParams }) {
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
  const { games, idents, rallies, plays, rows } = nightRows(d, date);
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

  // Context for each clip, so the reel isn't a wall of unexplained videos.
  // Per game because cluster ids, team sides and the score are all game-local.
  const perGame = new Map();
  for (const g of games) perGame.set(g.id, {
    rallies: rallies.filter(r => r.game_id === g.id),
    teams: teamMap(idents.filter(i => i.game_id === g.id)),
    // which side is theirs, so the score can be read from where they stood
    team: idents.find(i => i.game_id === g.id && i.player_id === player.id)?.team ?? null,
  });

  // ?stat=<key> picks the reel; anything unrecognised falls back to the
  // points view. In the URL rather than in client state because "look at my
  // kills" has to be a link you can send — the whole point of this page.
  const asked = (await searchParams)?.stat;
  const stat = STATS[asked] ? asked : null;
  const keys = stat ? [stat] : POINTS;

  // Their touches, per rally, so a touch-type filter (digs, sets) can find the
  // MOMENT rather than just the rally. Grades come from the same derivation
  // the boards use, so "assist" here means what it means on /stats.
  const byRally = new Map();
  for (const p of plays) {
    if (!byRally.has(p.rally_id)) byRally.set(p.rally_id, []);
    byRally.get(p.rally_id).push(p);
  }

  const clips = [];
  for (const r of rallies) {
    const g = perGame.get(r.game_id);
    const idx = g.rallies.findIndex(x => x.id === r.id);
    const grades = deriveGrades(byRally.get(r.id) || [], r, g.teams);
    const at = (kind) => {
      const s = STATS[kind];
      // outcome stats: one per rally, and the moment IS the end of it
      if (s.outcome) {
        return r.outcome_type === s.outcome
          && mine.has(`${r.game_id}:${r.outcome_cluster}`)
          ? { cue: { atEnd: true }, label: outcomeLabel(r.outcome_type)[0] } : null;
      }
      // touch stats: their touch of that type, optionally of that quality
      const hit = (byRally.get(r.id) || []).find(p =>
        p.play_type === s.touch && mine.has(`${r.game_id}:${p.cluster_id}`)
        && (!s.grade || grades.get(p.id) === s.grade));
      // sourceFor's `at` was built for exactly this — "cue near this game-time
      // instead of the rally start (a specific touch the viewer filtered for)"
      return hit ? { cue: { at: hit.t }, label: SHORT[kind] ?? STATS[kind].label } : null;
    };

    for (const k of keys) {
      const m = at(k);
      if (!m) continue;
      // The same arithmetic /r/<id> runs, stopped at this rally — one shared
      // derivation, so a recap and the permalink it links to can't disagree
      // about what the score was.
      const score = scoreFrom(g.rallies.slice(0, idx + 1), g.teams);
      const tone = FAULTS.has(k) ? "bad" : outcomeLabel(r.outcome_type)[1] || "info";
      clips.push({ r, key: k, label: m.label, tone, score, won: POINTS.includes(k),
        src: sourceFor(byGame.get(r.game_id), r, m.cue),
        // their side first: "made it 14-11" should read the way they'd say it
        us: score && g.team ? (g.team === "A" ? [score.A, score.B] : [score.B, score.A]) : null,
        game: byGame.get(r.game_id)?.slot ?? null,
        num: idx + 1, of: g.rallies.length });
      break;                       // one clip per rally per view
    }
  }

  // Only what they actually did, with counts — a chip row of eighteen mostly
  // zeroes is a worse control than a dropdown.
  const chips = CHIPS.filter(k => (me[STATS[k].field] ?? 0) > 0)
    .map(k => ({ key: k, label: SHORT[k] ?? STATS[k].label,
      n: me[STATS[k].field], fault: FAULTS.has(k) }));
  const base = `/p/${canonical}/${date}`;

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

        {/* The stat line IS the filter. One row doing both jobs: it reads as
            "here's what you did", and every entry is the way into those clips.
            Faults come last and muted — one click away for anyone who wants
            them, never the thing a recap opens on. */}
        <div className="row" style={{ gap: 8, margin: "12px 0" }}>
          <a href={base} className={`chip${!stat ? " corrected" : ""}`}>
            <b>{points}</b> Points
          </a>
          {chips.map(c => (
            <a key={c.key} href={`${base}?stat=${c.key}`}
              className={`chip${stat === c.key ? " corrected" : ""}`}
              style={c.fault && stat !== c.key ? { opacity: .65 } : undefined}>
              <b>{c.n}</b> {c.label}
            </a>
          ))}
        </div>

        {clips.length > 0 ? <>
          <h2 className="rp-chain-h">
            {stat ? SHORT[stat] ?? STATS[stat].label : "Every point"}
            <span className="muted" style={{ fontWeight: 400 }}>
              {" "}· {clips.length} clip{clips.length === 1 ? "" : "s"}
            </span>
          </h2>
          {clips.map(h => (
            <div key={`${h.key}:${h.r.id}`} style={{ marginBottom: 18 }}>
              {/* WHY THIS CLIP IS HERE, above the video rather than below it:
                  a reader scrolling a reel decides whether to press play from
                  this line. The score is the part that earns its place — the
                  same argument /r/<id> makes for carrying it, since "kill to
                  make it 14-11" says more than "kill". */}
              <div className="row" style={{ gap: 8, alignItems: "baseline", marginBottom: 6 }}>
                <span className={`pill ${h.tone}`}>{h.label}</span>
                {/* "made it" only when they actually won the point — on an
                    error or a mid-rally dig it would be plainly wrong */}
                {h.us && <span>
                  {h.won && "made it "}
                  <b>{h.us[0]}</b><span className="muted">–</span><b>{h.us[1]}</b>
                  {!h.won && <span className="muted"> at the time</span>}
                  {h.score.approx && <span className="muted"> (approx)</span>}
                </span>}
                <span className="muted">
                  {[h.game ? `Game ${h.game}` : null, `rally ${h.num} of ${h.of}`]
                    .filter(Boolean).join(" · ")}
                </span>
              </div>
              {h.src
                ? <Clip src={h.src} label={`${h.label} — ${first}`} />
                : <p className="card muted">Video unavailable for this one.</p>}
              <a className="muted" href={`/r/${h.r.id}`}>Open this rally →</a>
            </div>
          ))}
        </> : <p className="card muted">
          No clips for that one — the touches are counted, but none of them
          landed in a rally we have video for.
        </p>}

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
