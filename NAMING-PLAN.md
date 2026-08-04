# Game naming — evaluation & plan

_Written 2026-08-04. Companion to YOUTUBE-PLAN.md / STATUS.md._

## Status — 2026-08-04, built

Steps 1–4 and 6 are in the repo. Step 5 (the backfill itself) is the one
thing that needs Ken, because the dates are not recoverable from the data —
see below.

| | |
|---|---|
| ✅ Pipeline captures `recorded_at` | `_probe_provenance` in `vbpipe/cli.py`, container → mtime → null |
| ✅ Schema + `lib/game-name.js` | `displayName` / `youtubeTitle` / `slug`, 34 edge cases green |
| ✅ Import reads structure | filename regex deleted; `slot` derived by recording time |
| ✅ Read sites swapped | games list, `/watch`, `/stats`, YouTube title, corrections export |
| ✅ Re-title path | `updateVideoTitle` + **YouTube ▾ → Re-sync title** |
| ✅ Games 13 & 14 dated | 2026-07-22, Game 1 and Game 2 |
| ⬜ **Date games 17, 18, 19** | `cca one` / `cca two` / `lnv one` — still on legacy names |
| ⬜ **Re-title on YouTube** | blocked on the `yt-auth` scope fix below |

**Two things surfaced during the build that the plan above did not predict.**

1. **`videos.update` is not covered by the upload scope.** `lib/youtube.js`
   asked for `youtube.upload` only, which is correct for `videos.insert` and
   useless for a rename. The scope now also requests `youtube`, and *adding a
   scope does not upgrade an existing refresh token* — re-consent is required.

   **This was shipped broken and is now fixed.** `scripts/yt-auth.js` had the
   scope string **hardcoded**, so widening `lib/youtube.js` changed the
   library but not the consent request. Re-running `yt-auth` therefore
   produced a fresh token with the *same* old scope, and re-titling kept
   failing with the same 403 — the most confusing possible symptom, because
   the advice in the error message was correct but doing it didn't help.
   `yt-auth.js` now imports `SCOPE` from `lib/youtube.js`, and after the
   exchange it prints the scopes Google actually **granted** and fails loudly
   if any requested one is missing. A consent screen lets a user untick
   scopes, so "asked for" and "got" are different questions and only the
   second one matters.

2. **Corrections filenames were riding on `games.name`.** The export route
   built `corrections_<stem>.json` from the game name, and the gen-2 ball
   notebook pairs that file to `<stem>.mp4`. Deriving the name would have
   silently repointed it. The stem now comes from a new `games.source_file`
   column (the original camera filename, from the bundle), which is what the
   notebook actually keys on. Verified: games 13 and 14 keep
   `corrections_game2.json` / `corrections_game1.json` exactly as today, and a
   future import gets its real video stem instead of every unnamed game
   colliding on `corrections_game.json`.

3. **OAuth on the droplet can't use a loopback redirect.** `yt-auth` starts a
   listener on `127.0.0.1:<random>` and tells you to open a consent URL. On a
   server over SSH the browser is on your laptop, so that address resolves to
   *your laptop* and the redirect dies with "can't connect".

   The failure is cosmetic — the authorization code is sitting in the browser's
   address bar. So `yt-auth` now:
   - detects an SSH session and says so *before* you start the flow,
   - uses a **fixed** port (42781, override with `YT_OAUTH_PORT`) so
     `ssh -L 42781:127.0.0.1:42781 root@<host>` can be set up in advance —
     a random port can't be forwarded ahead of time,
   - and offers `npm run yt-auth -- --manual`, which skips the listener and
     takes the redirected URL pasted back. That accepts the full URL, a bare
     query fragment, or just the code, and rejects a stale `state`.

## The problem

`games.name` is a stored string set once, from a filename:

```js
// app/app/import/ui.js
const nice = files[i].name.replace(/^game_bundle_/, "").replace(/\.zip$/, "")
  .replace(/[_-]+/g, " ");
```

Everything downstream reads that one string — the games list, `/watch`, and
the YouTube title (`app/app/api/youtube/route.js`: `title: game.name`). So
whatever got typed while saving an mp4 in Colab is the permanent, public name
of the video. Today that's `game1` and `game2`, uploaded to YouTube as
`game1` and `game2`.

Two separate faults:

| | |
|---|---|
| **Not identifiable** | `game2` says nothing. Which night? Which court? Was it before or after `game1`? (It was after — game 13 is `game2`, game 14 is `game1`.) |
| **Not derivable** | Nothing in the system can *compute* a better name, because the facts that would make one — when it was played, what order — are never captured. |

The second is the real one. A one-time rename fixes today; it doesn't stop
game 15 arriving as `test-final-REAL`.

## Verdict

Same move as the video split: **separate the facts from the rendering.**

`lib/video-source.js` is the one door a rally goes through to become playable.
Names want the same door. Store structured fields — date, slot, court — and
*derive* the label at read time. Site and YouTube then cannot drift, because
they are two renderings of one object rather than two copies of a string.

The analogy is a passport versus a name tag. Right now the name tag *is* the
passport: lose it, or write it badly, and there's no underlying record to
reissue from. We want the record first and the tag printed on demand.

## The date is the hard part

The obvious idea — read the recording date off the mp4 — does not survive the
pipeline. Measured on `cca-one.mp4`:

```
creation_time : 2026-07-23T02:13:14.000000Z
encoder       : Lavf62.3.100
```

`Lavf` is ffmpeg. That timestamp is when the file was **re-encoded**, not when
it was filmed — ffmpeg rewrites `creation_time` unless explicitly told to
carry source metadata. The delivered mp4 has already forgotten.

So the date must be captured **upstream, at ingest, from the original camera
file**, and carried in the bundle. `game.json` currently holds only
`video`, `rallies`, `tracklets`, `clusters`, `ball` — no time fields at all.

Insertion point is one line, `pipeline/vbpipe/cli.py:94`:

```python
game = json.load(open(gj)) if os.path.exists(gj) else {"video": a.video}
```

That dict is where `recorded_at` belongs, probed from `a.video` before any
stage touches it. Same `ffprobe` subprocess pattern already used by
`_resolve_ball_fps` (cli.py:20) — no new dependency.

**Fallback matters.** Phone and camera files carry `creation_time`; a file
that's been through Drive round-trips or a trim may not. Order of preference:
container `creation_time` → filesystem mtime → null. Null is honest and the
app prompts; a wrong date silently poisons the ordering.

## Chosen format

Date + game number. No teams (they don't exist until the identities step, so
an import-time name would be permanently half-built), no venue (one gym today
— add `court` to the schema now, leave it out of the rendering until there's
a second).

| | |
|---|---|
| **Site** | `Tue, Jul 21 2026 · Game 2` |
| **YouTube** | `VB at Night — 2026-07-21 · Game 2` |
| **Slug** | `vban-2026-07-21-g2` |

Why the two renderings differ:

- On the site, context is free — the user is already on vbatnight, so
  "VB at Night" in every row is noise. Human date format, because it's read
  by a person scanning a list.
- On YouTube the video lands in a global namespace: search results,
  subscription feeds, a shared link with no surrounding page. It needs the
  channel prefix to be self-identifying, and ISO dates because they sort
  correctly in YouTube Studio's title column. 100-char hard limit is not a
  concern at this length.
- The slug is the machine key — stable, sortable, filename-safe, URL-safe.
  Use it for Shorts filenames and anything that needs a handle rather than a
  label.

`slot` ("Game 2") is **derived, not typed**: sort a night's games by
`recorded_at`, number from 1. That is the specific thing that stops depending
on what got saved where. Two games on the same night can't collide, and
re-importing in a different order can't scramble them.

**Privacy note.** `lib/shorts.js` already establishes that anything leaving
the building uses first names only. Game titles carry no names at all under
this scheme, so that norm holds for free — worth keeping in mind if teams are
ever added to the title.

## Schema

```sql
ALTER TABLE games ADD COLUMN played_on TEXT;   -- 'YYYY-MM-DD', local date
ALTER TABLE games ADD COLUMN recorded_at TEXT; -- full ISO, from the source file
ALTER TABLE games ADD COLUMN slot INTEGER;     -- derived: game N of that night
ALTER TABLE games ADD COLUMN court TEXT;       -- venue, unused in rendering today
ALTER TABLE games ADD COLUMN label TEXT;       -- manual override; wins when set
ALTER TABLE games ADD COLUMN source_file TEXT; -- original camera filename
```

`name` stays, unread, until the backfill is verified — then it becomes the
seed for `label` on any game whose old name was actually meaningful, and is
dropped. Keeping both live is how the two drift again.

`label` exists because a derived name is right 95% of the time and wrong in
exactly the cases that matter most ("Championship final"). An override that
wins unconditionally is cheaper than a naming scheme that tries to anticipate
everything.

## New: `lib/game-name.js`

```js
displayName(game)   // "Tue, Jul 21 2026 · Game 2"
youtubeTitle(game)  // "VB at Night — 2026-07-21 · Game 2"
slug(game)          // "vban-2026-07-21-g2"
```

One module, three renderings, one set of facts. Mirrors `video-source.js`:
every consumer goes through the same door, so a future team page or share
card can't invent a fourth format.

Degradation is explicit. No `played_on` → fall back to `label`, then to the
legacy `name`, then to `Game #<id>`. A game imported from an old bundle stays
watchable and never renders as `undefined`.

## Renaming is not a one-way door

`videos.update` changes the title of an already-uploaded video. `lib/youtube.js`
holds an authorized client, so re-titling the two existing uploads
(`bYCPyagCRKs`, `b3YdY_ob1kI`) is a small script, not a manual pass through
Studio. Quota cost is 50 units per call against a 10,000/day budget.

That makes the scheme reversible: if the format turns out wrong after twenty
games, a re-render and a batch `videos.update` fixes all twenty. Worth knowing
before over-thinking the format.

Consequence worth designing for: the site name is *live* (it changes when the
data changes) but the YouTube title is a *snapshot* taken at upload. Those can
drift. Fix is a **Re-sync title** action next to the existing YouTube ▾ menu
items, which pushes `youtubeTitle(game)` up. Manual and visible, matching how
Reclaim is handled.

## Plan

1. **Pipeline captures the date** — `recorded_at` (+ `source_file`,
   `duration_s`) into `game.json` at `cli.py:94`, ffprobed from the source
   before any re-encode.
2. **Schema + `lib/game-name.js`** — the columns above and the one door.
   No behavior change yet.
3. **Import reads structure, not filenames** — `api/import` takes
   `recorded_at` from the bundle, derives `played_on` and `slot`. Delete the
   `game_bundle_` regex from `import/ui.js`. Where `recorded_at` is missing,
   show a date field instead of guessing.
4. **Swap the read sites** — games list (`app/page.js`), `/watch`, and
   `api/youtube` line 81 call `displayName` / `youtubeTitle`. Small diff;
   `review/ui.js` untouched, as always.
5. **Backfill the two existing games** — `npm run backfill-names`.

   Run it bare first: it prints what each game will admit to and changes
   nothing. On the current two that is *not enough to date them* — the
   re-encode stripped `creation_time` (both report only `Lavf58.76.100`) and
   `created_at` is import time (13 at 00:50, 14 at 13:50 the same day, so
   neither is the evening in question). What survives is a **GPS tag**:
   `+39.9145-086.1470` and `+39.9144-086.1471`, ~10 m apart — same gym, which
   settles `court` but not the date.

   So the dates have to come from Ken:

   ```
   npm run backfill-names -- 13=2026-07-DD 14=2026-07-DD --retitle
   ```

   Guessing was deliberately not implemented. A wrong date in a YouTube title
   is worse than `game2`, and it silently misorders the night.
6. **Re-title on YouTube** — `--retitle` on the backfill, plus
   **YouTube ▾ → Re-sync title** for later renames.

Steps 1 and 2 are independent and can land in either order; step 3 needs both.
Nothing before step 4 is user-visible, so the risky part is one commit and one
revert.

## What was verified

A full `next build` was not runnable in the sandbox (native modules SIGBUS
when mmap'd off the mounted drive), so verification was done directly. Worth
recording because `node --check` **silently passes broken files** in that
environment — it accepted a file with `const broken = <<<;` appended. Any
future check here needs a negative control.

- **34 name-derivation cases** — happy path, missing slot, override, legacy
  fallback, no facts at all, six malformed dates, five malformed slots, the
  100-char YouTube clamp, and the timezone trap (a date-only string must not
  render as the previous day in the gym's zone; the module parses the string
  rather than going through `Date`).
- **Migrations on a copy of the real DB** — applied, and correctly rejected on
  a second run.
- **Slot derivation** — a late import carrying `recorded_at` sorts *ahead* of
  earlier-imported games rather than being appended; deleting a middle game
  renumbers with no gap; moving a game to another night renumbers both nights.
- **Parse + import resolution** on all 17 touched files, with a negative
  control proving the parser rejects invalid input and understands JSX.
- **Backfill script** — bare mode, apply mode, and a second apply proving
  idempotency.
- **Corrections filenames** — unchanged for both existing games.

## What must not change

Same guardrail as YOUTUBE-PLAN.md: the review flow is the moat. Naming touches
`games` metadata only — no `plays`, no `rallies`, no corrections export, no
`review/ui.js`. If a step seems to need one of those, stop.
