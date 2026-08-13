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

// The path segment for a player's recap page: first name, then the id.
//
// FIRST NAME because a URL travels further than almost anything else on the
// site — it gets pasted into group chats and lands in inboxes — so the rule
// above applies with full force.
//
// AND THE ID, always, even when the first name looks unique today. These links
// are meant to survive in old email, and a bare `sasha` silently stops being
// unambiguous the week a second Sasha signs up. The id also makes resolution
// exact, so the name part is free to be a nicety: a renamed player's old link
// still finds them (the page redirects to the canonical spelling) rather than
// 404ing at someone who did nothing wrong.
export function playerSlug(player) {
  if (!player?.id) return null;
  const first = (publicName(player.display_name) || "")
    .toLowerCase().normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip accents; keep the letter
    .replace(/[^a-z0-9]+/g, "");
  return first ? `${first}-${player.id}` : String(player.id);
}

/** id from a slug — the trailing digits, or a bare id. Null if neither. */
export function parsePlayerSlug(slug) {
  const m = /^(?:.*-)?(\d+)$/.exec(String(slug ?? "").trim());
  return m ? +m[1] : null;
}

// Shorten every "- Full Name" tail in a caption to "- First".
// Captions are built as "KILL - Dana Whitfield"; this rewrites the part
// after the separator and leaves the rest alone.
export function publicCaption(caption) {
  if (!caption) return caption;
  return String(caption).replace(/(\s[-–—]\s)(.+)$/,
    (_, sep, name) => sep + (publicName(name) ?? ""));
}
