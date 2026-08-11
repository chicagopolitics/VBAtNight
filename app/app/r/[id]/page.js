import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deriveGrades, teamMap, scoreFrom, outcomeLabel, GOOD, BAD } from "@/lib/grades";
import { displayName } from "@/lib/game-name";
import { sourceFor } from "@/lib/video-source";
import NightTheme from "../../theme";
import TrackPageView from "../../track";
import { Clip } from "../../clip";
import ShareButton from "../../share";
export const dynamic = "force-dynamic";

// The share unit.
//
// /watch is a browsing tool — every game, every rally, filters across the top.
// That is not what a person sends a friend. They send ONE rally, and the link
// should render that rally rather than drop the reader into a wall of forty
// clips to hunt through. Hence a route of its own: /r/482 is short enough to
// paste into a text message, and it queries one rally instead of the entire
// published corpus the way /watch's payload does.
//
// These pages exist to be SENT, not found. The link is the capability — the
// same bargain the unlisted YouTube exports already make — so nothing here
// should surface in a search result beside a player's name.
export const metadata = { robots: { index: false, follow: false } };

export default async function RallyPermalink({ params }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const d = db();

  // The join IS the authorization: an unpublished game yields no row at all,
  // which is exactly the rule /watch enforces. phase='game' matters just as
  // much — a permalink must not reach a warmup rally the browse page hides.
  const rally = d.prepare(
    `SELECT r.* FROM rallies r
     JOIN games g ON g.id = r.game_id AND g.published = 1
     WHERE r.id = ? AND r.phase = 'game'`).get(+id);
  if (!rally) notFound();

  // the whole row: displayName needs played_on/slot/label, sourceFor needs
  // video_file/yt_video_id/media_state
  const game = d.prepare("SELECT * FROM games WHERE id = ?").get(rally.game_id);

  const idents = d.prepare(
    `SELECT cluster_id, team, COALESCE(name, 'P' || cluster_id) AS name
     FROM identities
     WHERE game_id = ? AND dismissed = 0 AND merged_into IS NULL`)
    .all(rally.game_id).map(i => ({ ...i }));
  const names = new Map(idents.map(i => [i.cluster_id, i.name]));
  const teams = teamMap(idents);

  // `play_type IS NOT NULL` follows /watch rather than /stats. deriveGrades
  // reads positional adjacency (the set immediately before the kill is the
  // assist), so an untyped play sitting in the middle of the sequence shifts
  // it — and this page has to tell the same story as the card it was shared
  // from.
  const touches = d.prepare(
    `SELECT id, t, play_type, cluster_id, grade FROM plays
     WHERE rally_id = ? AND deleted = 0 AND play_type IS NOT NULL
     ORDER BY t`).all(rally.id).map(p => ({ ...p }));
  const grades = deriveGrades(touches, rally, teams);

  // ORDER: (start_s, id), not start_s alone. Splitting a rally in review
  // leaves two rows sharing a start_s (rallies 508/509 on game 13), and on a
  // bare start_s they'd both claim the same number while prev/next skipped
  // straight past the sibling. The id is the tie-break everywhere below, and
  // /watch orders the same way so the numbering agrees.
  const at = [rally.start_s, rally.start_s, rally.id];
  const upto = "(start_s < ? OR (start_s = ? AND id <= ?))";

  // Where this rally sits in its game, without loading the rally list: one
  // aggregate carries both the ordinal and the total.
  const pos = d.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ${upto} THEN 1 ELSE 0 END) AS upto
     FROM rallies WHERE game_id = ? AND phase = 'game'`)
    .get(...at, rally.game_id);

  // Neighbours, so a permalink is somewhere you can keep watching from rather
  // than a dead end.
  const step = (op, dir) => d.prepare(
    `SELECT id FROM rallies WHERE game_id = ? AND phase = 'game'
       AND (start_s ${op} ? OR (start_s = ? AND id ${op} ?))
     ORDER BY start_s ${dir}, id ${dir} LIMIT 1`).get(rally.game_id, ...at);
  const prev = step("<", "DESC"), next = step(">", "ASC");

  // The score as it stood once this rally resolved. "Kill to make it 14-11"
  // is a far better thing to receive than "Kill", and it costs one query:
  // the same derivation the game card runs, stopped here.
  const score = scoreFrom(d.prepare(
    `SELECT outcome_type, outcome_cluster FROM rallies
     WHERE game_id = ? AND phase = 'game' AND ${upto}`)
    .all(rally.game_id, ...at), teams);

  const [label, tone] = outcomeLabel(rally.outcome_type);
  const outcomeName = rally.outcome_cluster != null
    ? names.get(rally.outcome_cluster) ?? null : null;
  const title = label
    ? `${label}${outcomeName ? ` · ${outcomeName}` : ""}`
    : `Rally ${pos.upto}`;

  // Cue from the rally's start, not its end. On /watch, atEnd is for an
  // outcome-filtered card — you asked for kills, so it jumps to the kill.
  // Here the RALLY is the unit the reader was sent, and in volleyball the
  // build-up is most of the point; the heading already says how it ends.
  const src = sourceFor(game, rally);
  const dur = Math.round(rally.end_s - rally.start_s);

  return (
    <>
      <NightTheme />
      <TrackPageView />
      <article className="rp">
        <header className={`rp-head${tone ? ` ${tone}` : ""}`}>
          <h1>{title}</h1>
          <p className="muted rp-meta">
            {[displayName(game), `Rally ${pos.upto} of ${pos.total}`, `${dur}s`]
              .filter(Boolean).join(" · ")}
          </p>
          {score && (
            <p className="rp-score">
              <b>{score.A}</b><span className="muted"> – </span><b>{score.B}</b>
              <span className="muted">
                {" "}after this rally{score.approx ? " (approximate)" : ""}
              </span>
            </p>
          )}
        </header>

        {/* Exactly one clip on the page, and it is the reason the visitor is
            here — so it warms unconditionally rather than waiting on the
            grid's rationing queue (see app/clip.js). */}
        {src
          ? <Clip src={src} label={title} eager />
          : <p className="card muted">
              The video for this game isn&apos;t available right now.
            </p>}

        {touches.length > 0 && (
          <>
            <h2 className="rp-chain-h">How it went</h2>
            {/* the rally as a sentence — on a clip card this is a 12px muted
                line with no room; here it's the context a stranger needs */}
            <ol className="rp-chain">
              {touches.map(t => {
                const g = grades.get(t.id);
                const cls = GOOD.has(g) ? "good" : BAD.has(g) ? "bad" : "";
                return (
                  <li className="rp-step" key={t.id}>
                    <span className={`rp-touch${cls ? ` ${cls}` : ""}`}>
                      <span className="rp-who">
                        {names.get(t.cluster_id) || "Unknown"}
                      </span>
                      <span className="rp-what">{t.play_type}</span>
                      {cls && <span className={`rp-grade ${cls}`}>
                        {g.replace(/_/g, " ")}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
        )}

        <div className="rp-actions">
          {/* first and filled: on a page someone was SENT, passing it on is
              the primary verb */}
          <ShareButton path={`/r/${rally.id}`} name={outcomeName}
            title={label || `Rally ${pos.upto}`} label="Share this clip" />
          <a className="abtn" href={`/watch?game=${game.id}`}>Watch the whole game</a>
          <a className="abtn" href={`/stats?game=${game.id}`}>Game stats</a>
        </div>

        <nav className="rp-nav" aria-label="nearby rallies">
          {prev ? <a className="abtn" href={`/r/${prev.id}`}>‹ Previous rally</a> : <span />}
          {next ? <a className="abtn" href={`/r/${next.id}`}>Next rally ›</a> : <span />}
        </nav>
      </article>
    </>
  );
}
