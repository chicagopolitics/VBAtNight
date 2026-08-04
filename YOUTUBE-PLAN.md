# YouTube integration — evaluation & plan

_Written 2026-08-03. Companion to STATUS.md / PLAN-75.md._

## Status — 2026-08-03, end of session

**The migration works end to end on a real game.** OAuth done, API upload
proven (no locked-private lock on this project), a full game uploaded from
the app, and `/watch` playing rallies from the YouTube player.

| | |
|---|---|
| ✅ Probe — API uploads keep `unlisted` | no audit needed |
| ✅ Schema + `lib/video-source.js` | one place resolves a rally to a source |
| ✅ `lib/youtube.js` + `yt-auth` | authorized; resumable upload working |
| ✅ First real game uploaded via the app | **YouTube ▾ → Upload via API** |
| ✅ `/watch` on YouTube embeds | confirmed playing in production |
| ✅ Playback-quality mitigation | warming + lead-in; "better, not perfect" |
| ⬜ **Reclaim local video** | built, not yet run — the actual disk win |
| ⬜ Shorts publishing flow | renderer built; approve/publish UI deferred |
| ⬜ Per-rally uploads | the real playback-quality fix; do it with Shorts |

**Not yet realised: the storage saving.** Every uploaded game still has its
local mp4 on disk. Reclaiming is a per-game button, deliberately manual and
deliberately last, and should only be pressed on games whose corrections are
finished — a reclaimed game is watchable but not reviewable without
re-importing its bundle.

Review is untouched throughout: `app/games/[id]/review/ui.js` has a zero-line
diff across this whole piece of work.

## The question

Move video storage off the droplet and onto Ken's YouTube channel, and open
up Shorts / social distribution — **without touching the scoring & correcting
workflow.**

## Verdict

Do it, but split the video into two roles that are currently conflated.

Right now one file (`app/public/media/<gid>/game.mp4`) serves two completely
different jobs:

| Job | Consumer | Needs |
|---|---|---|
| **Working copy** — scrub, seek ±0.5s, mark touch at t=112.4 | `/games/<id>/review` | sub-second seeks, zero latency, local disk |
| **Delivery copy** — watch a 12s rally on a phone | `/watch` (public) | streaming, CDN, adaptive bitrate, discovery |

They pull in opposite directions, which is why the droplet is currently paying
CDN prices for an editing scratch file.

The fix is the photographer's workflow: **the local MP4 is the RAW, YouTube is
the exported JPEG.** You edit against the RAW, you publish and archive the
JPEG, and once the export is done you don't need the RAW on the working disk
anymore. Review stays byte-for-byte on local disk — untouched, as required.
`/watch` moves to the YouTube player. The local MP4 becomes a file with a
*lifecycle* instead of a permanent resident.

## Storage economics — the actual motivation

| | now |
|---|---|
| `public/media/13` | 2.8 GB |
| `public/media/14` | 2.3 GB |
| per game | ~2.5 GB (17 min, 1080p60) |

Two games already sit at 5.1 GB. STATUS.md targets multi-game nights
(8–10 games), so a single season lands in the 100 GB range on a droplet whose
disk is measured in tens of GB. This is a hard wall with a known arrival date,
not a nice-to-have.

Under the RAW/JPEG split, steady-state disk is **the 1–2 games currently being
reviewed**, not every game ever played. That converts an O(n) storage curve
into O(1). YouTube stores the archive for free and streams it better than a
$12 droplet ever will (adaptive bitrate, global edge, mobile codecs — the
`/watch` grid currently ships full 1080p60 to phones).

Secondary win: if the upload happens from the Colab notebook (where the source
video already lives in Drive) rather than from the droplet, the bundle no
longer needs to ship the multi-GB `game.mp4` at all. That deletes the
3.6 GB-buffered Drive download that OOM-killed the droplet
(fixed in `c784ea2` by streaming — but not needing the download at all is
better than streaming it).

## The one thing that could have killed this: locked-as-private — RESOLVED

**Probe run 2026-08-03: uploads keep the privacy we ask for.** `npm run
yt-probe` uploaded a clip as `unlisted` and YouTube reported it back as
`unlisted`, not `private`. The automated upload path is viable on this
project; no API audit needed. The rest of this section is kept because the
fallback is still the right answer if that ever changes (Google re-audits
periodically, and a failed periodic audit lands in exactly this state).



**Videos uploaded through the API by an unverified Cloud project are locked
private, and the lock cannot be appealed.** You would have to re-upload by
hand or pass a YouTube API compliance audit
([policy](https://support.google.com/youtube/answer/7300965?hl=en)).

This matters more for us than usual because we chose **unlisted**: if the lock
lands, unlisted embeds are dead, and the whole `/watch` migration falls over.

So: **before any app code depends on it, do one throwaway API upload and look
at what YouTube does to it.** That is `npm run yt-probe`. Three outcomes:

1. **Uploads honor `unlistedstatus`** → proceed with the full automated path.
2. **Uploads get locked private** → fall back to *manual upload, API read-only*.
   Ken uploads the game in YouTube Studio (a drag-and-drop, once per game) and
   pastes the video id into the app. Everything downstream — embeds, per-rally
   start/end, storage reclamation, Shorts — works identically. The API only
   ever saved a manual step; it was never load-bearing.

Since we're going unlisted, option 2 costs very little. Worth being explicit:
**the value here is the storage split and the embed player, not the upload
automation.** Don't let audit uncertainty block the migration.

### Quota is no longer a problem

The old figure (1600 units per upload out of 10,000/day = 6 uploads/day) is
obsolete. As of December 2025 the default allocation is **100 `videos.insert`
calls/day** plus 10,000 units for everything else
([docs](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)).
At 8–10 games a night plus Shorts, we're an order of magnitude under.

## What changes in the app

The migration is small because the codebase already funnels playback through
almost exactly one concept. There are precisely **two** places that turn a
rally into a playable source:

- `app/games/[id]/review/ui.js` → `mediaFor(rally)` — **do not touch**
- `app/watch/ui.js` → `base + frag` — **this one moves**

Both build `<file>#t=<start>,<end>`. The YouTube equivalent is
`youtube.com/embed/<id>?start=<s>&end=<e>`. Same idea, different transport.

### Schema

```sql
ALTER TABLE games ADD COLUMN yt_video_id TEXT;      -- 11-char YouTube id
ALTER TABLE games ADD COLUMN yt_privacy TEXT;       -- unlisted | public | private
ALTER TABLE games ADD COLUMN yt_uploaded_at TEXT;
ALTER TABLE games ADD COLUMN media_state TEXT;      -- local | both | youtube
```

`media_state` is the lifecycle flag that makes reclaiming disk safe: only a
game at `both` may have its local MP4 deleted, and doing so moves it to
`youtube`. A game at `youtube` is archived — it can be watched but not
re-reviewed until the MP4 is pulled back down. That's the honest trade and it
should be visible in the UI, not silent.

### New: `lib/video-source.js`

One function, `sourceFor(game, rally, opts)`, returns either
`{ kind: "file", src }` or `{ kind: "youtube", id, start, end }`. Review calls
it with `prefer: "file"` and refuses anything else; Watch takes whatever it
gets. Every future consumer (Shorts picker, share links, embeds on a team
page) goes through the same door.

### Known regression: sub-second cue points

`?start=`/`?end=` take **integer seconds**; the current code cues to a tenth
(`toFixed(1)`). On a highlight that starts 0.4s early nobody will notice, but
where it matters the IFrame API's `seekTo(seconds, true)` does accept floats —
so the fix exists if a clip ever feels mistimed. Noted rather than solved,
because the integer path is one attribute and the float path is a JS API.

## Playback quality on /watch — known, mitigated, not solved

Found on the first real game (2026-08-03). Rallies started at potato
resolution and sharpened only as the point was ending.

Not transcode lag — the game was fully processed and 1080p played fine on
YouTube directly. The cause is **adaptive-bitrate cold start**: each rally
card was a fresh player, seeking into the middle of a 17-minute file, with no
bandwidth history. YouTube starts conservative and ramps while measuring. On
a long video the ramp is invisible; on a 15-second rally the ramp *is* the
clip.

**We cannot force quality.** `setPlaybackQuality`, `getPlaybackQuality` and
the `suggestedQuality` argument to `cueVideoById`/`loadVideoById` are all
no-ops now
([docs](https://developers.google.com/youtube/iframe_api_reference)).
That kills the obvious fix; don't go looking for it again.

What shipped instead:

- **Warming** — a card's iframe mounts *paused* when it scrolls into view, so
  the player load, seek and initial buffer happen before the click. Bounded
  by what's actually on screen (the grid handles that: ~9 desktop, ~2 phone),
  ceiling 12 as a runaway guard, staggered 120 ms so a scroll stop doesn't
  boot nine players into the same connection and have them all conclude it's
  slow. Disabled on metered/2G connections.
- **Click resumes, never reloads.** Swapping `src` to add `autoplay=1` would
  reload the iframe and discard everything warming paid for — a net zero. The
  player mounts once with `enablejsapi` and play is driven by `postMessage`,
  with a reload fallback if it doesn't respond.
- **A 3-second YouTube lead-in** (`YT_LEAD_IN`), so residual ramp happens
  over players walking to position instead of the serve.

Result: better, not perfect. A first click on an unwarmed card still ramps.

**The real fix is per-rally uploads** — a 15-second video starts at t=0, has
no mid-file seek, and processes to 1080p in seconds, so there's no ramp to
hide. It also gives every rally its own shareable URL. Deferred deliberately:
it's the same asset the Shorts work needs, so it should be built once, there.
Watch the quota if it happens (100 `videos.insert`/day — fine for one game's
highlights, not for 40 rallies × 10 games in a night).

## Shorts — the part that's actually differentiated

Everyone with a camera can post volleyball clips. Almost nobody has a
**structured index of what happened**, which is exactly what this pipeline
produces. The app already knows, per rally: the outcome (`kill`, `ace`,
`block`, `attack_error`), who did it, every touch and its type, the derived
grade, and the rally length. Picking highlights stops being someone scrubbing
a 17-minute video on a Sunday and becomes a database query:

```
every rally ending in a kill, by a named player, longer than 8 seconds
```

Rally lengths from `game.json` — median 11s, p90 20s, max 31s — fit Shorts
(≤3 min, raised from 60s in Oct 2024) with room for a title card. A whole
night compresses to a 90-second "top 6 rallies" reel, or one Short per kill.

### The 16:9 → 9:16 problem, and why we're lucky

Shorts want 1080×1920 vertical; the footage is a 16:9 side angle. The usual
answers are bad: blurred letterbox makes the players thumbnail-sized on a
phone, and a fixed centre crop loses half the court.

But `game.json` already carries a **per-frame ball track** (`ball[rally]` =
`[t, x, y, conf]` at ~60fps). So the crop window can simply *follow the ball* —
a virtual camera operator, for free, from data the pipeline already computed
for scoring. Heavy temporal smoothing turns the jittery detection into a
believable slow pan; confidence gating and interpolation cover the frames
where the detector blinks.

That is the whole reason this is worth building rather than outsourcing to a
generic auto-crop tool: those tools guess where the action is. We know.

`pipeline/shorts.py` implements this: smoothed ball-following 9:16 crop,
optional caption overlay, H.264/AAC at 1080×1920 — the exact Shorts spec.

### Settled Shorts settings (2026-08-04, tuned with Ken on cca-one)

Each of these came from measuring, not taste. Don't change them casually.

| setting | value | why |
|---|---|---|
| clip window | anchor play + 4 touches of run-up | the unit people share is "my kill", not "a rally". 4 = dig-set-attack plus the swing that forced the dig |
| **touch source** | **reviewed DB, never game.json** | game.json is raw detection — 274 of game 13's 606 contacts are phantoms Ken deleted. Counting 4 touches back through that lands nowhere |
| camera speed cap | 1600 ref units/s | ball speed is p95 876, p99 1299. The old 420 was beaten 19% of the time; 1600 means the cap only catches glitches, not real play |
| lookahead | 0.15s | the big one: ball-in-frame through the attack 95.0% → 98.8%. Offline render, so the ball's future is already in the array — no reason to make the camera reactive. NOT additive with speed: 0.15s alone matched 2× speed; both together dropped to 96.2% |
| reaction beat | 1.8s after the anchor | swing back to the attacker's contact x = the scoring side, catching the celebration. Tail extends to 4.6s so the beat has room |
| vfill | 0.70 | a full-height crop of a side-angle gym shot is >half ceiling |

**Known, accepted limitation:** the ball detector loses the ball before the
kill in 4 of 15 kills. The camera then holds its last known position, which
is often the wrong side of the net. Ken's call is to let this resolve as the
ball model improves rather than paper over it in the renderer. The reaction
beat is skipped for those clips too (no contact position to aim at), so they
degrade quietly rather than pointing confidently at the wrong half of the
court.

`--debug` burns the touch timeline, anchor and game clock into a clip. Use it
before tuning anything: it separates a bad WINDOW from bad TOUCH TIMESTAMPS,
which look identical from the outside.

### Other platforms — reality check

Worth knowing before anyone plans a cross-post button:

- **TikTok** — the Content Posting API requires its *own* audit on top of
  developer signup; until you pass, every direct post is `SELF_ONLY` (visible
  only to you). TikTok explicitly rejects internal/private tools, which is
  what a league app looks like. Realistically: render the file, post by hand.
- **Instagram Reels** — needs a Business account and Graph API app review;
  9:16, 5–90s, capped at 25 API posts per account per day. Doable but a
  separate project.

Both consume the *same* 1080×1920 MP4 the Shorts renderer produces. So the
renderer is the reusable asset and the posting integrations are optional
garnish — build the first, defer the second. Manual upload of a finished
vertical clip is 20 seconds of work; API access to do it automatically is
weeks of audit.

## Plan

1. ✅ **Probe** (`npm run yt-probe`) — passed; uploads keep `unlisted`.
2. ✅ **Schema + `lib/video-source.js`** — the abstraction, no behavior change.
3. ✅ **`lib/youtube.js` + `npm run yt-auth`** — authorized against the
   channel, resumable upload working, reusing the Drive OAuth client.
4. ✅ **`/watch` → embeds** — live on a real game. Falls back to local files
   for any game without a video id, so nothing regressed for older games.
   Followed by the ABR cold-start mitigation (warming + `YT_LEAD_IN`).
5. ⬜ **Reclaim disk** — **YouTube ▾ → Reclaim local video** on a game at
   `media_state = 'both'`. Built and gated behind a confirm; not yet run on
   any game. This is where the storage argument actually pays out, so until
   it's pressed the migration is all cost and no benefit.
6. ⬜ **Shorts** — `pipeline/vbpipe/shorts.py` renders and ranks. Nothing
   publishes: no code path connects the app's upload button to Shorts, by
   design. Open question is the approval flow — render candidates → approve
   individually → publish, since this is the first thing that would put the
   league on a *public* channel (unlisted Shorts get no reach, so they'd
   have to be public to be worth making).

Next session: step 5 on a finished game to prove the disk actually comes
back, then step 6 — folding per-rally uploads into it, since that also
retires the playback-quality problem above.

## What's in the repo now

| file | what it does |
|---|---|
| `app/lib/video-source.js` | `sourceFor(game, rally)` → file or YouTube. The only place a rally becomes playable. |
| `app/lib/youtube.js` | Resumable upload (8 MiB chunks, survives a dropped connection). Mirrors `lib/drive.js`. |
| `app/app/api/youtube/route.js` | PATCH link an id · POST upload · DELETE reclaim local file |
| `app/app/watch/ui.js` | YouTube embeds + the warm-on-viewport player manager; falls back to local files |
| `app/app/globals.css` | `.ytwrap` / `.ytfacade` — the façade must *cover* the player, not replace it (it may already be warm behind) |
| `app/scripts/yt-auth.js` | `npm run yt-auth` — one-time OAuth (done) |
| `app/scripts/yt-probe.mjs` | `npm run yt-probe` — the locked-private test (done, passed) |
| `pipeline/vbpipe/shorts.py` | Ball-following 1080×1920 Shorts renderer + highlight picker |

### Setup, when you want it

Only needed for API upload. The manual path — upload in YouTube Studio,
then **YouTube ▾ → Link a manual upload** on the games list — needs none of it.

1. Cloud console → new project → enable **YouTube Data API v3**.
2. Credentials → OAuth client ID → **Desktop app**. Put the id/secret in
   `app/.env.local` as `YT_OAUTH_CLIENT_ID` / `YT_OAUTH_CLIENT_SECRET`.
3. `npm run yt-auth` → paste the printed `YT_OAUTH_REFRESH_TOKEN` into
   `.env.local`.
4. `npm run yt-probe` → the answer to the locked-private question.

### Rendering Shorts

```bash
python -m vbpipe.shorts cca-one.mp4 -g game.json -o shorts/ --list   # rank only
python -m vbpipe.shorts cca-one.mp4 -g game.json -o shorts/ --top 5  # render
python -m vbpipe.shorts cca-one.mp4 -g game.json -o s.mp4 --rally 18 --zoom 0.7
```

Two knobs worth knowing. `--zoom` below 1.0 pulls back and letterboxes over a
blurred backdrop when you want to see a play develop rather than fill the
frame. `vfill` (default 0.70) is how much of the source height the crop uses —
the single most important number in the renderer, because a full-height crop
of a side-angle gym shot is over half ceiling.

Note the renderer defends itself against the static-impostor ball detections
documented in STATUS.md: on the `game.json` in this repo **59% of ball
detections are two fixed ceiling lights**, and pointing a camera at those
parks the frame on the sideline for the whole clip. `static_spots()` finds
them the same way the pipeline does (busy *and* motionless = furniture) and
drops them before the camera ever sees the track.

## What must not change

The review flow is the product's moat — 532 corrections on cca-one is real
labeled data. Nothing in this plan touches `review/ui.js`, the `plays` table,
the corrections export, or the Drive round-trip. If a future step seems to
require it, that's the signal to stop and reconsider, not to push through.

---

**Sources:**
[Videos locked as private](https://support.google.com/youtube/answer/7300965?hl=en) ·
[Quota and compliance audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits) ·
[TikTok Content Posting API 2026](https://www.postpeer.dev/blog/best-tiktok-posting-api) ·
[Instagram Reels API publishing](https://postproxy.dev/blog/instagram-reels-api-publishing-guide/) ·
[YouTube Shorts specs 2026](https://vidiq.com/blog/post/youtube-shorts-vertical-video/)
