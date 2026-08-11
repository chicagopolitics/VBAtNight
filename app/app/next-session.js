"use client";
import { useState } from "react";
import { shortDay, fullWhen } from "@/lib/luma";

// "Next session · Thu, Aug 13 →" — the sign-up prompt.
//
// Rendered only when lib/luma.js found a future session, so its absence is the
// ordinary state and no layout reserves room for it. `session` is resolved in
// the page's server component and passed down, because the two pages that host
// it (/watch's hero, /stats' heading) are client components.
//
// The event NAME is deliberately left out. On this site "Late Night
// Volleyball" is what the reader is already looking at; the useful thing is
// WHEN. The full text is in the title and aria-label, where there's room.
//
// DISMISSAL, WITHOUT A FLASH. Hiding this in an effect would mean everyone who
// dismissed it still sees it paint on every page load. Reading localStorage
// during render instead would be a hydration mismatch, since the server has no
// idea what the browser stored. So it borrows the trick app/theme.js uses for
// the night palette and lets CSS decide:
//
//   1. an inline script — parsed and run BEFORE the badge below it exists —
//      copies the dismissed id from localStorage onto <html>;
//   2. a rule naming THIS session's id hides the badge if they match.
//
// The id is known at render time, so the comparison CSS can't do (attribute
// against attribute) becomes a literal. Server and client render identically,
// and a dismissed badge is never painted at all. React state is only needed so
// the ✕ takes effect immediately for the person who just pressed it.
export default function NextSession({ session, className = "" }) {
  const [gone, setGone] = useState(false);
  if (!session?.id || !session?.url || gone) return null;

  const boot = "try{var v=localStorage.getItem('lnv-hide');" +
    "if(v)document.documentElement.setAttribute('data-lnv-hide',v)}catch(e){}";
  // session.id is sanitised to [A-Za-z0-9_-] in lib/luma.js, so it can't
  // escape the selector it's interpolated into.
  const hide = `html[data-lnv-hide="${session.id}"] .nextsess{display:none}`;

  function dismiss() {
    try { localStorage.setItem("lnv-hide", session.id); } catch { /* private mode */ }
    // keeps it hidden across a client-side navigation to another public page,
    // where a fresh badge renders but this attribute is already set
    document.documentElement.setAttribute("data-lnv-hide", session.id);
    setGone(true);
  }

  const when = fullWhen(session.start);
  return (
    <span className={`nextsess${className ? ` ${className}` : ""}`}>
      <script dangerouslySetInnerHTML={{ __html: boot }} />
      <style dangerouslySetInnerHTML={{ __html: hide }} />
      <a className="nextsess-go" href={session.url} target="_blank" rel="noreferrer"
        title={`${session.name} — ${when}${session.location ? ` · ${session.location}` : ""}`}
        aria-label={`Sign up for ${session.name}, ${when}`}>
        <span className="nextsess-k">Next session</span>
        <span className="nextsess-d">{shortDay(session.start)}</span>
        <span className="nextsess-arrow" aria-hidden="true">→</span>
      </a>
      <button type="button" className="nextsess-x" onClick={dismiss}
        title="Hide this until the next session" aria-label="Hide the next-session prompt">✕</button>
    </span>
  );
}
