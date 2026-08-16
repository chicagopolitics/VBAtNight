"use client";
import { useEffect, useRef, useState } from "react";
import { publicName } from "@/lib/public-name";

// "Send this to someone."
//
// Two behaviours, picked by what the device actually has:
//   navigator.share  — the OS sheet (iOS/Android). This is the case that
//                      matters: the site is read on phones, from messages.
//   clipboard        — desktop. Copying is the whole interaction, so the
//                      button has to SAY it copied; a silent success reads
//                      as a dead button and people click it again.
//
// The URL is resolved at click time, not render time. window.location.origin
// isn't available during SSR, and building an absolute href in render would
// hydrate against a different string — the same trap the eager player hit in
// app/clip.js.

// Exported for the night summary on /recaps, which copies a block of text
// rather than a URL — same two-step fallback, same secure-context caveat.
export async function copyText(text) {
  // Requires a secure context; localhost and vbatnight.com both qualify, but
  // a LAN address over plain http does not — hence the fallback below.
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// `title` is a hint for the share sheet; the URL is the payload. It goes
// through publicName because a share sheet writes straight into someone's
// text message — the same "leaves the building" rule that keeps surnames off
// Shorts captions (lib/public-name.js).
export default function ShareButton({ path, title, name = null,
                                      label = "Share", className = "" }) {
  const [state, setState] = useState("idle");   // idle | copied | failed
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = s => {
    setState(s);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  async function onClick(e) {
    // these sit inside clickable cards on /watch — a share must not also
    // collapse the game it's in
    e.preventDefault();
    e.stopPropagation();
    const url = new URL(path, window.location.origin).href;
    const first = publicName(name);
    const heading = [title, first].filter(Boolean).join(" · ");

    if (navigator.share) {
      try {
        await navigator.share({ title: heading || "VB at Night", url });
        return;                                  // sheet handled it
      } catch (err) {
        // Dismissing the sheet throws AbortError. That's a decision, not a
        // failure, so it must not fall through to copying something the
        // person just declined to send.
        if (err?.name === "AbortError") return;
      }
    }
    flash(await copyText(url) ? "copied" : "failed");
  }

  return (
    <button type="button" onClick={onClick}
      className={`sharebtn${className ? ` ${className}` : ""}`}
      aria-live="polite"
      title={state === "copied" ? "link copied" : "copy a link to this clip"}>
      {state === "copied" ? "✓ Copied"
        : state === "failed" ? "Copy failed"
        : <><span aria-hidden="true">↗</span> {label}</>}
    </button>
  );
}
