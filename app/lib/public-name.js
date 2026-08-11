// The rule for names that LEAVE THE BUILDING. Pure — no imports, so this is
// usable from a client component as well as the server.
//
// It lived in lib/shorts.js, which pulls in fs and path; a share sheet writes
// a name straight into someone's text message, so the rule has to be reachable
// from the browser too. shorts.js re-exports both functions, so nothing that
// already imports them from there had to change.

// First name only.
//
// Rosters carry full names because organisers need to tell two Mikes apart.
// A Short does not: it gets burned into the video AND becomes the YouTube
// title, on a public channel, for a rec-league player who never agreed to
// have their surname indexed by a search engine. "KILL - Dana" reads better
// than "KILL - Dana Whitfield" anyway.
//
// Applied server-side, where the caption is persisted, so it can't be
// bypassed by a stale page or a hand-crafted request.
export function publicName(name) {
  if (!name) return null;
  const first = String(name).trim().split(/\s+/)[0];
  return first || null;
}

// Shorten every "- Full Name" tail in a caption to "- First".
// Captions are built as "KILL - Dana Whitfield"; this rewrites the part
// after the separator and leaves the rest alone.
export function publicCaption(caption) {
  if (!caption) return caption;
  return String(caption).replace(/(\s[-–—]\s)(.+)$/,
    (_, sep, name) => sep + (publicName(name) ?? ""));
}
