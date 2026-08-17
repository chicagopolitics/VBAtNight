"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { sourceFor } from "@/lib/video-source";
import { outcomeLabel, STATS, GROUPS } from "@/lib/grades";
import { Clip } from "../clip";
import ShareButton from "../share";
import NextSession from "../next-session";

// The reel of published Shorts.
//
// Plain links, not embeds. A dozen warm iframes above the fold would spend
// the connection budget that watch/ui.js's warming machinery is carefully
// rationing for the clips people actually came for — and a Short is better
// watched on YouTube anyway, where it can be shared.
//
// The thumbnail is the ordinary hqdefault, which for a vertical video is the
// frame letterboxed into 480x360 with bars either side. Cropping it to 9:16
// with object-fit lands almost exactly on the video content, so the bars
// disappear without needing a Shorts-specific thumbnail endpoint (there
// isn't a reliable one).
function Reel({ shorts }) {
  if (!shorts?.length) return null;
  return (
    <section className="reel" aria-label="Shorts">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Shorts</h2>
        <span className="muted">plays on YouTube</span>
      </div>
      <div className="reel-row">
        {shorts.map(s => (
          <a className="reel-card" key={s.id} target="_blank" rel="noreferrer"
            href={`https://www.youtube.com/shorts/${s.id}`}>
            <img className="reel-thumb" loading="lazy" alt=""
              src={`https://i.ytimg.com/vi/${s.id}/hqdefault.jpg`} />
            {s.caption && <span className="reel-cap">{s.caption}</span>}
          </a>
        ))}
      </div>
    </section>
  );
}

// The filter vocabulary (STATS/GROUPS) moved to lib/grades.js when the recap
// page needed the same words — a "use client" module can't be imported by a
// server component. Imported above; nothing outside this file uses it.

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = d => {
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return `${MON[+m - 1]} ${+day}, ${y}`;
};

// --- admin: PICKING Shorts -------------------------------------------------
//
// Only rendered for organizers, and the data behind them isn't sent to anyone
// else. The flow this supports, in Ken's words: finish review → publish the
// game → browse here for interesting rallies → pick some as Shorts.
//
// Picking is ALL this page does now. Reviewing the rendered clips, publishing
// them, marking a game done and reclaiming its video all moved to /shorts,
// because doing them here meant scrolling between a game's clip grid and its
// panel for every single clip. What's left is the half that belongs here: the
// player and stat filters above are already the tool for finding a moment
// worth clipping, and the ＋ button is one press at the moment you find it.
//
// The ordering constraint behind all of it is unchanged: a Short is rendered
// FROM the local mp4, so reclaiming that file permanently ends this game's
// ability to produce highlights. Hence "Shorts done" (now on /shorts), which
// is what unlocks the purge.

const STATUS_TONE = { queued: "", rendering: "info", ready: "good",
  published: "good", failed: "bad" };

async function api(method, body) {
  const res = await fetch("/api/shorts", { method,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "failed");
  return j;
}

// One button per MOMENT on a clip card.
//
// A Short is about a play — the kill, the dig, the block — not the rally it
// happened in. So a rally shows one button per clippable moment, and the
// same rally can yield two Shorts (the dig, and the kill it set up).
function ShortButton({ moment, existing, blocked, onQueued }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (existing)
    return <span className={`pill ${STATUS_TONE[existing.status] || ""}`}
      title={existing.error || ""}>{moment.short} · {existing.status}</span>;
  return (
    <button className="mini" disabled={busy || !!blocked}
      title={blocked ||
        `Clip this ${moment.short} plus the 4 touches leading up to it`}
      onClick={async () => {
        setBusy(true); setErr(null);
        try {
          const j = await api("POST", { play_id: moment.playId,
            rally_id: moment.rallyId,
            caption: moment.caption, subcaption: moment.sub });
          onQueued(j.short);
        } catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>
      {busy ? "…" : err ? "✗ " + err.slice(0, 26) : `＋ ${moment.short}`}
    </button>
  );
}

// Which moments in this rally are worth offering as Shorts?
//
// With a stat filter active ("kills", "digs"), the touches that MATCHED are
// precisely the moments the viewer went looking for — so those become the
// buttons, and the existing filter UI doubles as the moment picker for free.
// With no filter, the rally-ending play is the natural single offer.
function momentsFor(rally, label) {
  const dur = Math.round(rally.end_s - rally.start_s);
  const sub = `${dur}s rally`;
  if (rally.matched?.length)
    return rally.matched.filter(m => m.id).slice(0, 4).map(m => ({
      playId: m.id, rallyId: rally.id,
      short: m.type + (m.name ? ` · ${m.name}` : ""),
      caption: `${(m.grade === "kill" ? "KILL" : m.type).toUpperCase()}` +
        (m.name ? ` - ${m.name}` : ""),
      sub,
    }));
  // no filter: the play that ended the rally
  const last = [...(rally.touches || [])].filter(t => t.id).pop();
  if (!last) return [];
  return [{ playId: last.id, rallyId: rally.id,
    short: label ? label.toLowerCase() : "final touch",
    caption: (label || last.type || "HIGHLIGHT").toUpperCase() +
      (rally.outcome_name ? ` - ${rally.outcome_name}` : ""),
    sub }];
}

// What this game has waiting on /shorts. One line, not a panel: the moment
// you've picked a clip the interesting question is "how many am I up to", and
// everything you'd do about it lives on the other page.
function ShortsBadge({ game, shorts }) {
  if (!shorts.length && !game.shorts_blocked) return null;
  // "Blocked" means no NEW Shorts can be made from this game — it says
  // nothing about the ones already rendered, which may still be waiting to be
  // published. So a game with Shorts always shows its counts, and the block
  // becomes a ⚠ on the front rather than replacing them.
  if (!shorts.length)
    return <span className="abtn" title={game.shorts_blocked}
      style={{ cursor: "default" }}>⚠ Shorts blocked</span>;
  const n = k => shorts.filter(s => s.status === k).length;
  const label = [
    `${shorts.length} picked`,
    n("queued") + n("rendering") && `${n("queued") + n("rendering")} rendering`,
    n("ready") && `${n("ready")} ready`,
  ].filter(Boolean).join(" · ");
  return (
    // stopPropagation: the whole game card is a click-to-expand button, so
    // without it following this link also collapses the game behind you.
    <a className="abtn" href="/shorts" onClick={e => e.stopPropagation()}
      title={game.shorts_blocked || "Review and publish rendered Shorts"}>
      {game.shorts_blocked ? "⚠ " : ""}{label} →</a>
  );
}

export default function Highlights({ games, reel = [], admin = false, session = null }) {
  const sp = useSearchParams();
  // One control, two kinds of scope: a game id, or "day:<YYYY-MM-DD>" for a
  // whole session. /stats links carry whichever scope its boards were counting,
  // so the clips here are exactly the ones behind the number that was clicked.
  const [game, setGame] = useState(() => {
    const g = sp.get("game"), d = sp.get("day");
    if (games.some(x => String(x.id) === g)) return g;
    if (d && games.some(x => x.date === d)) return `day:${d}`;
    return "all";
  });
  const scopeDay = game.startsWith("day:") ? game.slice(4) : null;
  // sessions with published games — the selector's optgroups. `games` already
  // arrives newest night first, so insertion order is the order to show.
  const sessions = useMemo(() => {
    const by = new Map();
    for (const g of games) {
      if (!g.date) continue;
      if (!by.has(g.date)) by.set(g.date, []);
      by.get(g.date).push(g);
    }
    return [...by.entries()];
  }, [games]);
  const undated = useMemo(() => games.filter(g => !g.date), [games]);
  const [player, setPlayer] = useState(sp.get("player") || "all");
  const [stat, setStat] = useState(STATS[sp.get("stat")] ? sp.get("stat") : "all");
  const [open, setOpen] = useState(() => new Set());
  // Shorts live here rather than in the panel so the per-rally ＋ buttons and
  // the game panel stay in sync without a round-trip.
  const [shortsByGame, setShortsByGame] = useState(() =>
    Object.fromEntries(games.map(g => [g.id, g.shorts || []])));
  const setShorts = (gid, list) =>
    setShortsByGame(prev => ({ ...prev, [gid]: list }));

  // ONE poll for the whole page, not one per game.
  //
  // This used to live in each game's panel. With the panels gone the badges
  // would go stale, and re-adding a per-game interval would mean nine of them
  // on a night with nine games — so it's lifted here and asks for the whole
  // batch in a single request instead.
  //
  // Two properties from the old effect are load-bearing and kept: it tears
  // down the moment the render queue drains, so an idle page makes NO
  // requests at all; and the `stop` re-check stops a response that lands
  // after unmount from resurrecting rows that are no longer current.
  const anyRendering = Object.values(shortsByGame)
    .some(list => list.some(s => ["queued", "rendering"].includes(s.status)));
  useEffect(() => {
    if (!admin || !anyRendering) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/shorts");     // no game_id = whole batch
        if (!res.ok) return;
        const j = await res.json();
        // Merge, don't replace: the batch payload only carries games with
        // Shorts, and a game whose last Short was just deleted must not have
        // its (now empty) local list silently reinstated from a stale key.
        if (!stop && j.games) setShortsByGame(prev => ({ ...prev,
          ...Object.fromEntries(j.games.map(g => [g.id, g.shorts])) }));
      } catch { /* transient network blip — the next tick retries */ }
    };
    const id = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(id); };
  }, [admin, anyRendering]);
  const toggle = id => setOpen(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // every named participant across published games (touches + outcomes)
  const players = useMemo(() => {
    const s = new Set();
    for (const g of games) for (const r of g.rallies) {
      if (r.outcome_name) s.add(r.outcome_name);
      for (const t of r.touches) if (t.name) s.add(t.name);
    }
    return [...s].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [games]);

  const s = STATS[stat];
  const filtering = player !== "all" || stat !== "all";
  const matchTouch = t =>
    (player === "all" || t.name === player) &&
    (!s || (t.type === s.touch && (!s.grade || t.grade === s.grade)));

  const shown = games
    .filter(g => game === "all" ||
      (scopeDay ? g.date === scopeDay : g.id === +game))
    .map(g => ({ ...g, rallies: g.rallies
      .map((r, i) => {
        // outcome stats live on the rally, not a touch: match the rally
        // itself and cue playback near the end where the point was won
        if (s?.outcome) {
          const ok = r.outcome_type === s.outcome &&
            (player === "all" || r.outcome_name === player);
          return { ...r, num: i + 1, matched: [], atEnd: true, ok };
        }
        const matched = filtering ? r.touches.filter(matchTouch) : [];
        return { ...r, num: i + 1, matched, ok: !filtering || matched.length > 0 };
      })
      .filter(r => r.ok) }))
    .filter(g => g.rallies.length > 0);
  const total = shown.reduce((a, g) => a + g.rallies.length, 0);
  // any active filter means the visitor asked for specific clips — show them
  // right away; otherwise games start collapsed so nothing preloads
  const autoExpand = filtering || game !== "all";

  return (
    <div>
      {/* The hero is decorative, so it carries no <img> and no alt text — the
          heading inside it is the real content. It sits above the sticky
          filter bar so it scrolls away and hands the top of the viewport back
          to the filters, which is what a returning viewer actually wants. */}
      <div className="hero">
        {/* Same scene as the still, in motion. aria-hidden and tabIndex -1 for
            the same reason there's no alt text: it's a backdrop, and a
            keyboard user tabbing into a controls-less video learns nothing.
            muted + playsInline + autoPlay is the complete set mobile autoplay
            policy requires — drop any one and iOS quietly shows the poster
            forever. The poster IS frame 1, and .hero's background-image is the
            same frame again, so the paint → poster → playback handoff has
            nothing to flash between; it's also the whole reduced-motion
            fallback (see globals.css). */}
        <video className="hero-vid" src="/brand/hero.mp4"
          poster="/brand/hero-1600.jpg" autoPlay loop muted playsInline
          preload="auto" aria-hidden="true" tabIndex={-1} />
        {/* the photo's top-right is empty sky, and the hero is already
            position:relative — the one place a prompt can sit without
            displacing anything */}
        <NextSession session={session} />
        <div className="hero-in">
          <h1>Highlights</h1>
          {/* This line is for the visitor who arrived from a YouTube Short
              and has no idea what they're looking at. It deliberately isn't
              the rally count — the filter bar below already shows that, and a
              count tells a stranger nothing. */}
          <p className="tagline">
            Every rally from our games, clipped and tagged by player.
          </p>
        </div>
      </div>
      {/* above the sticky filter bar, so it scrolls away and leaves the top
          of the viewport to the filters on the way back down */}
      <Reel shorts={reel} />
      <div className="row card filters">
        <select value={game} onChange={e => setGame(e.target.value)}>
          <option value="all">All games</option>
          {sessions.map(([date, gs]) => (
            <optgroup key={date} label={fmtDate(date)}>
              <option value={`day:${date}`}>
                Whole session ({gs.length} game{gs.length === 1 ? "" : "s"})
              </option>
              {gs.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </optgroup>
          ))}
          {undated.length > 0 && (
            <optgroup label="No date">
              {undated.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </optgroup>
          )}
        </select>
        <select value={player} onChange={e => setPlayer(e.target.value)}>
          <option value="all">All players</option>
          {players.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={stat} onChange={e => setStat(e.target.value)}>
          <option value="all">All plays</option>
          {GROUPS.map(([label, keys]) => (
            <optgroup key={label} label={label}>
              {keys.map(k => <option key={k} value={k}>{STATS[k].label}</option>)}
            </optgroup>
          ))}
        </select>
        <span className="muted">{total} rall{total === 1 ? "y" : "ies"}</span>
        {(filtering || game !== "all") && (
          <div className="row" style={{ width: "100%", gap: 6 }}>
            {game !== "all" && (
              <button className="fchip" onClick={() => setGame("all")}>
                {scopeDay ? fmtDate(scopeDay)
                  : games.find(x => String(x.id) === game)?.name ?? "game"} ✕</button>
            )}
            {player !== "all" && (
              <button className="fchip" onClick={() => setPlayer("all")}>{player} ✕</button>
            )}
            {stat !== "all" && (
              <button className="fchip" onClick={() => setStat("all")}>{STATS[stat].label} ✕</button>
            )}
            {(game !== "all") + (player !== "all") + (stat !== "all") > 1 && (
              <button className="fchip"
                onClick={() => { setGame("all"); setPlayer("all"); setStat("all"); }}>
                clear all</button>
            )}
          </div>
        )}
      </div>
      {games.length === 0 && <p className="muted">Nothing published yet — check back soon.</p>}
      {games.length > 0 && total === 0 &&
        <p className="muted">No rallies match those filters.</p>}
      {shown.map(g => {
        const isOpen = autoExpand || open.has(g.id);
        const n = g.rallies.length;
        const aWins = g.score && g.score.A > g.score.B;
        const bWins = g.score && g.score.B > g.score.A;
        return (
        <div key={g.id}>
          <div className="card gamecard" onClick={() => toggle(g.id)}
            role="button" aria-expanded={isOpen}>
            <div className="gc-top muted">
              <span>{[fmtDate(g.date), `${n} rall${n === 1 ? "y" : "ies"}`]
                .filter(Boolean).join(" · ")}</span>
              <span>{g.name} <span className={"chev" + (isOpen ? " open" : "")}>▸</span></span>
            </div>
            {g.score ? (
              <div className="gc-score">
                <div className={aWins ? "win" : undefined}>
                  <div className="gc-team">Team A{aWins ? " ★" : ""}</div>
                  <div className="gc-pts">{g.score.A}</div>
                  {g.teamA?.length > 0 &&
                    <div className="gc-roster muted">{g.teamA.join(", ")}</div>}
                </div>
                <div className="gc-dash muted">–</div>
                <div className={bWins ? "win" : undefined}>
                  <div className="gc-team">Team B{bWins ? " ★" : ""}</div>
                  <div className="gc-pts">{g.score.B}</div>
                  {g.teamB?.length > 0 &&
                    <div className="gc-roster muted">{g.teamB.join(", ")}</div>}
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 6 }}>
                {g.teamA?.length > 0 &&
                  <div className="muted">Team A: {g.teamA.join(", ")}</div>}
                {g.teamB?.length > 0 &&
                  <div className="muted">Team B: {g.teamB.join(", ")}</div>}
              </div>
            )}
            {g.others?.length > 0 &&
              <div className="muted gc-others">
                {g.teamA?.length || g.teamB?.length ? "Also" : "Players"}: {g.others.join(", ")}
              </div>}
            {g.score?.approx &&
              <div className="muted gc-others">score approximate — not every rally could be counted</div>}
            <div className="gc-actions">
              <button onClick={e => { e.stopPropagation(); toggle(g.id); }}>
                {isOpen ? "Hide clips" : `▶ Watch ${n} clip${n === 1 ? "" : "s"}`}
              </button>
              <a className="abtn" href={`/stats?game=${g.id}`}
                onClick={e => e.stopPropagation()}>Game stats</a>
              {admin && <ShortsBadge game={g} shorts={shortsByGame[g.id] || []} />}
            </div>
          </div>
          {isOpen && <div className="grid-clips">
            {g.rallies.map((r, idx) => {
              // one source of truth for "play [start,end] of this game" —
              // local media fragment or YouTube embed, decided per game by
              // whether it's been exported (lib/video-source.js)
              const src = sourceFor(g, r, {
                atEnd: r.atEnd,
                // cue to the moment you actually filtered for
                at: r.matched?.length ? r.matched[0].t : null,
              });
              if (!src) return null;
              // first clips warm up with metadata; the rest wait until played
              // so opening a long game doesn't hammer a phone connection
              const [label, tone] = outcomeLabel(r.outcome_type);
              return (
                <div className="card" key={r.id}>
                  <Clip src={src} preload={idx < 6 ? "metadata" : "none"}
                    label={label ? `${label}${r.outcome_name ? " · " + r.outcome_name : ""}` : `Rally ${r.num}`} />
                  {/* pill and duration read as one label, so they stay
                      together on the left and the share sits at the far
                      right — the one thing on the card that ACTS */}
                  <div className="row cliprow">
                    {label
                      ? <span className={`pill ${tone}`}>
                          {label}{r.outcome_name ? ` · ${r.outcome_name}` : ""}
                        </span>
                      : <span className="pill">Rally {r.num}</span>}
                    <span className="muted">
                      {label ? `Rally ${r.num} · ` : ""}{Math.round(r.end_s - r.start_s)}s
                    </span>
                    <ShareButton path={`/r/${r.id}`} name={r.outcome_name}
                      title={label || `Rally ${r.num}`} />
                  </div>
                  {r.matched.length > 0 && (
                    <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                      {r.matched.map(m => `${m.name || "?"} ${m.type}`).join(", ")}
                    </div>
                  )}
                  {admin && (
                    <div className="row" style={{ marginTop: 6, flexWrap: "wrap", gap: 4 }}>
                      {momentsFor(r, label).map(mo => (
                        <ShortButton key={mo.playId} moment={mo}
                          existing={(shortsByGame[g.id] || [])
                            .find(s => s.play_id === mo.playId)}
                          blocked={g.shorts_blocked}
                          onQueued={s => setShorts(g.id, [...(shortsByGame[g.id] || []), s])} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>}
        </div>
        );
      })}
    </div>
  );
}
