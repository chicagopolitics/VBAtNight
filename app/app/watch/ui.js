"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { sourceFor } from "@/lib/video-source";
import { outcomeLabel } from "@/lib/grades";
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

// Filterable stats. Three kinds:
//   touch    — plain attempt counts (matches touch.type)
//   +grade   — quality subset of a touch type (derived in lib/grades.js)
//   outcome  — rally-ending points/faults (matches rally.outcome_*)
// Stats-page cells deep-link here as /watch?player=<name>&stat=<key>.
export const STATS = {
  serve: { label: "serves", touch: "serve" },
  receive: { label: "receives", touch: "receive" },
  dig: { label: "digs", touch: "dig" },
  set: { label: "sets", touch: "set" },
  attack: { label: "attacks", touch: "attack" },
  block: { label: "block touches", touch: "block" },
  kill: { label: "kills", outcome: "kill" },
  ace: { label: "aces", outcome: "ace" },
  stuff: { label: "stuff blocks", outcome: "block" },
  attack_error: { label: "attack errors", outcome: "attack_error" },
  service_error: { label: "serve errors", outcome: "service_error" },
  assist: { label: "assists", touch: "set", grade: "assist" },
  set_error: { label: "set errors", touch: "set", grade: "error" },
  dig_kept: { label: "digs kept in play", touch: "dig", grade: "success" },
  dig_error: { label: "dig errors", touch: "dig", grade: "error" },
  rec_pos: { label: "positive receptions", touch: "receive", grade: "positive" },
  rec_error: { label: "reception errors", touch: "receive", grade: "error" },
  blocked: { label: "blocked attacks", touch: "attack", grade: "blocked" },
};
const GROUPS = [
  ["Touches", ["serve", "receive", "dig", "set", "attack", "block"]],
  ["Points & faults", ["kill", "ace", "stuff", "attack_error", "service_error"]],
  ["Quality", ["assist", "rec_pos", "dig_kept", "blocked", "set_error", "dig_error", "rec_error"]],
];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = d => {
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return `${MON[+m - 1]} ${+day}, ${y}`;
};

// --- admin: Shorts controls ------------------------------------------------
//
// Only rendered for organizers, and the data behind them isn't sent to anyone
// else. The flow this supports, in Ken's words: finish review → publish the
// game → browse here for interesting rallies → pick some as Shorts → then,
// and only then, reclaim the local video.
//
// That ordering isn't a preference, it's a constraint. A Short is rendered
// FROM the local mp4, so purging it permanently ends this game's ability to
// produce highlights. Hence "Shorts done", which is what unlocks the purge.

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

// Game-level panel: what's rendered, publish buttons, and the done switch.
function ShortsPanel({ game, shorts, setShorts }) {
  const [done, setDone] = useState(!!game.shorts_done);
  const [msg, setMsg] = useState(null);
  const pending = shorts.filter(s => ["queued", "rendering"].includes(s.status));
  const ready = shorts.filter(s => s.status === "ready");

  // Poll ONLY while the worker has something to do. A render is a minute or
  // two, so without this the pill sits on "queued" until you happen to
  // reload. The dependency on pending.length means the interval is torn down
  // the moment the queue drains — an idle panel makes no requests at all.
  useEffect(() => {
    if (!pending.length) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/shorts?game_id=${game.id}`);
        if (!res.ok) return;
        const j = await res.json();
        // Re-check `stop`: a response can land after the panel unmounted or
        // the queue drained, and writing state then would resurrect stale rows.
        if (!stop && j.shorts) setShorts(j.shorts);
      } catch { /* transient network blip — the next tick retries */ }
    };
    const id = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(id); };
  }, [pending.length, game.id]);

  async function act(fn, ok) {
    setMsg("…");
    try { const j = await fn(); setMsg(ok(j)); return j; }
    catch (e) { setMsg("✗ " + e.message); }
  }

  return (
    <div className="card shortspanel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Shorts</strong>
        <span className="muted">{msg || `${shorts.length} picked · ${pending.length} rendering`}</span>
      </div>

      {game.shorts_blocked && <p className="muted">⚠ {game.shorts_blocked}</p>}

      {shorts.length === 0 && !game.shorts_blocked &&
        <p className="muted">Press ＋ Short on any rally below to queue one.</p>}

      {shorts.map(s => (
        <div className="row shortrow" key={s.id}>
          <span className={`pill ${STATUS_TONE[s.status] || ""}`}>{s.status}</span>
          <span style={{ flex: 1 }}>{s.caption || `short #${s.id}`}</span>
          {s.status === "ready" && (
            <>
              {/* watch it before it goes public — this is the only preview */}
              <a className="abtn" href={s.file} target="_blank" rel="noreferrer">Preview</a>
              <button className="primary" onClick={() => {
                if (!confirm("Publish to YouTube as PUBLIC?\n\n" +
                  "Unlike your full games (unlisted), Shorts must be public to " +
                  "get any reach — this makes the clip visible to anyone.")) return;
                act(() => api("PATCH", { id: s.id, publish: true }),
                  j => (j.warning ? "⚠ " + j.warning : "✓ published"))
                  .then(j => j && setShorts(shorts.map(x =>
                    x.id === s.id ? { ...x, status: "published", yt_video_id: j.id } : x)));
              }}>Publish</button>
            </>
          )}
          {s.status === "published" && s.yt_video_id &&
            <a className="abtn" href={`https://www.youtube.com/watch?v=${s.yt_video_id}`}
              target="_blank" rel="noreferrer">On YouTube</a>}
          {s.status === "failed" && (
            <button onClick={() => act(() => api("PATCH", { id: s.id, requeue: true }),
              () => "✓ requeued").then(() => setShorts(shorts.map(x =>
                x.id === s.id ? { ...x, status: "queued", error: null } : x)))}
              title={s.error || ""}>Retry</button>
          )}
          {s.status !== "rendering" && (
            <button className="danger mini" onClick={() => {
              if (!confirm("Remove this short?")) return;
              act(() => api("DELETE", { id: s.id }), j => j.note || "✓ removed")
                .then(() => setShorts(shorts.filter(x => x.id !== s.id)));
            }}>✕</button>
          )}
        </div>
      ))}

      <label className="row" style={{ gap: 8, marginTop: 10 }}>
        <input type="checkbox" checked={done} disabled={pending.length > 0}
          onChange={async e => {
            const next = e.target.checked;
            const j = await act(() => api("PATCH",
              { game_id: game.id, shorts_done: next }),
              () => next ? "✓ done — purge unlocked" : "✓ reopened");
            if (j) setDone(next);
          }} />
        <span>
          Shorts finished for this game
          <span className="muted"> — required before the local video can be reclaimed
            {ready.length > 0 && `; ${ready.length} rendered but unpublished`}</span>
        </span>
      </label>
    </div>
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
            </div>
          </div>
          {isOpen && admin &&
            <ShortsPanel game={g} shorts={shortsByGame[g.id] || []}
              setShorts={list => setShorts(g.id, list)} />}
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
