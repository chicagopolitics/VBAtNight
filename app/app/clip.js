"use client";
import { useEffect, useRef, useState } from "react";
import { embedUrl } from "@/lib/video-source";

// One rally, playable. Shared by the /watch grid and the /r/<id> permalink so
// a clip behaves identically wherever it's rendered.

// --- player warming --------------------------------------------------------
//
// THE PROBLEM. Clicking a rally card used to start a chain of work that all
// happened AFTER the click: download the player, boot it, fetch metadata,
// seek 8 minutes into a 17-minute video, guess a starting quality with no
// bandwidth information (so: a low one), then ramp up while measuring. On a
// long video you never notice the ramp. On a 15-second rally the ramp IS the
// clip — the point is over before the picture sharpens.
//
// THE FIX. Do all of that before the click. When a card scrolls into view we
// mount its iframe paused, so by the time the viewer presses play the player
// is loaded, seeked, buffered and has a real read on the connection.
//
// WHY IT'S BOUNDED. Warming isn't free — each player is its own buffer and
// its own share of the connection. Forty at once would be worse than the
// problem: they'd all measure a connection they were themselves saturating
// and all conclude it was terrible. So we warm what's actually on screen,
// which the CSS grid already sizes correctly (≈9 on a desktop grid, ≈2 on a
// phone's single column). MAX_WARM is only a runaway guard for very large
// displays, not the intended limit.
const MAX_WARM = 12;
const STAGGER_MS = 120;     // don't let a scroll stop boot 9 players at once
const NEAR_PX = 200;        // start warming just before a card is visible

const warm = new Set();     // tokens currently allowed to be warm
const pending = [];         // tokens waiting for a slot
let pump = null;

function admit() {
  if (pump) return;
  pump = setInterval(() => {
    if (!pending.length) { clearInterval(pump); pump = null; return; }
    if (warm.size >= MAX_WARM) return;
    const tok = pending.shift();
    warm.add(tok);
    tok.set(true);
  }, STAGGER_MS);
}

function requestWarm(tok) {
  if (warm.has(tok) || pending.includes(tok)) return;
  pending.push(tok);
  admit();
}

function releaseWarm(tok) {
  const i = pending.indexOf(tok);
  if (i >= 0) pending.splice(i, 1);
  if (warm.delete(tok)) tok.set(false);
}

// Viewers on metered or slow connections get the old click-to-load behaviour:
// they should not spend data on clips they never play. This page is mostly
// read on phones, so it's not a hypothetical.
function warmingAllowed() {
  if (typeof navigator === "undefined") return false;
  const c = navigator.connection;
  if (!c) return true;                       // Safari/Firefox: no signal, assume ok
  return !c.saveData && !["slow-2g", "2g"].includes(c.effectiveType);
}

// true once this card is near the viewport and has been given a warm slot.
//
// `eager` skips all of it — the queue exists to ration one connection across
// a grid of nine, and a permalink has exactly one clip on it. It bypasses the
// save-data check too: on that page the clip IS the page, so a visitor who
// followed the link has already asked for it.
function useWarm(ref, enabled, eager) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    // Eager warms on mount — no observer, no queue. It has to happen in an
    // effect rather than as an initial `true`: embedUrl stamps the player's
    // `origin` from window.location, so an iframe rendered during SSR would
    // hydrate against a src the server had no origin to put on. Mounting one
    // paint later still beats waiting for the click, which is the whole point.
    if (eager) { setOn(true); return; }
    if (!ref.current || !warmingAllowed()) return;
    const tok = { set: setOn };
    const io = new IntersectionObserver(
      ([e]) => (e.isIntersecting ? requestWarm(tok) : releaseWarm(tok)),
      { rootMargin: `${NEAR_PX}px` });
    io.observe(ref.current);
    return () => { io.disconnect(); releaseWarm(tok); };
  }, [enabled, eager]);
  return on;
}

// A YouTube clip card. Three states:
//   cold  — a thumbnail, nothing loaded
//   warm  — player mounted and paused, thumbnail still covering it
//   live  — playing, native YouTube controls exposed
//
// A live card never gets released when it scrolls off screen; unmounting a
// player mid-rally would be a bizarre thing to do to someone.
export function YouTubeClip({ src, label, eager = false }) {
  const box = useRef(null);
  const frame = useRef(null);
  const [live, setLive] = useState(false);
  const isWarm = useWarm(box, !live, eager);
  const mounted = live || isWarm;

  function play() {
    setLive(true);
    const el = frame.current;
    if (!el) return;                          // cold click: src carries autoplay
    // Drive the EXISTING player rather than re-pointing the iframe. Setting
    // src to add autoplay=1 would reload it and discard the load, seek and
    // buffer that warming just bought — the whole point of this machinery.
    const cmd = () => el.contentWindow?.postMessage(JSON.stringify(
      { event: "command", func: "playVideo", args: [] }), "*");
    cmd();
    // The player ignores commands sent before it's ready, and a browser may
    // refuse programmatic playback. Retry briefly, then fall back to the
    // reload we were trying to avoid — a slow start beats a dead card.
    let tries = 0;
    const t = setInterval(() => {
      if (++tries > 6) {
        clearInterval(t);
        if (el.isConnected) el.src = embedUrl(src, { autoplay: true });
        return;
      }
      cmd();
    }, 180);
    setTimeout(() => clearInterval(t), 1400);
  }

  return (
    <div className="ytwrap" ref={box}>
      {mounted && (
        <iframe ref={frame} title={label}
          src={embedUrl(src, { autoplay: false, jsapi: true })}
          allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
          allowFullScreen />
      )}
      {!live && (
        <button className="ytfacade" onClick={play} aria-label={`Play ${label}`}>
          {/* hqdefault exists for every video, unlisted included; a
              background-image degrades to the wrapper's colour if it ever
              404s, where an <img> would show a broken-image icon */}
          <span className="ytthumb" style={{ backgroundImage:
            `url(https://i.ytimg.com/vi/${src.id}/hqdefault.jpg)` }} />
          <span className="ytplay" aria-hidden="true">▶</span>
        </button>
      )}
    </div>
  );
}

// The transport switch, so callers only deal in "play this rally".
// `src` comes from sourceFor() in lib/video-source.js; a null src means
// nothing is playable and the caller renders its own placeholder.
export function Clip({ src, label, eager = false, preload = "none" }) {
  if (!src) return null;
  if (src.kind === "youtube")
    return <YouTubeClip src={src} label={label} eager={eager} />;
  // A local file needs no warming: a media fragment seeks instantly and the
  // browser's own preload heuristics are already the right call.
  return <video src={src.src} controls playsInline
    preload={eager ? "metadata" : preload} />;
}
