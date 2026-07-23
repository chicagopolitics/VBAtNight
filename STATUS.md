# Balltime replacement — project status

_Updated 2026-07-22 (session 6)_

## Done in session 6 (PLAN-75 §0 + §1: joint metric, serve-anchored typing)
- **PLAN-75.md** (repo root): roadmap to "ML parses ≥75% of touches, Ken
  fixes the rest" + stats fixes. §0/§1 done; §2–4 queued. Capture decision:
  Ken switches all future recordings to **1080p60** (footage was 30fps —
  detection density is the bottleneck; 60fps doubles it). ballcv thresholds
  need an fps-awareness pass BEFORE processing 60fps footage (not done yet).
- **eval_corrections.py: JOINT PARSE headline metric** — % of ground-truth
  touches captured AND family-typed (dig≈receive) AND attributed to the
  right player, denominator includes detector-missed rallies. Accepts
  multiple corr/game pairs → per-game + OVERALL. Baseline on game2's
  pre-gen-3 output: **2%** (funnel 49% captured × 39% typed × 12% player).
  This is the number to move; contact F1 alone flattered progress.
- **plays.py classify(): serve anchor** — contacts[0] labeled serve only if
  the next contact is on the OTHER side (serves must cross). 37→39% exact
  type accuracy on game2 corrections; receive→serve confusions 12→2.
  Resync anchors (resync_at / max_touch_gap / serve_gate params) implemented
  but DEFAULT OFF: at contacts P51% every combination scored WORSE (spurious
  contacts poison the counters; real attacks 25→7). Typing is
  detection-limited — matches the session-3 diagnosis (true serve detected
  in only 16/34 rallies; rally-start offset can't identify missed serves,
  spurious contacts sit right where the serve should be).
- **pipeline/typer_sweep.py** (new): one command re-tests all anchor combos
  against corrections. Run it after every ball-model generation; flip
  anchors on when they start winning. Verdict line says if defaults lose.
- vbpipe.zip rebuilt (plays.py + eval_corrections.py) — **RE-UPLOAD to
  Drive/balltime**. cli.py unchanged (classify defaults compatible).
  Synthetic sanity tests pass (normal/missed-serve/block/resync/empty).
- NOTE: A/B ran on the game2 bundle from 07-21 (P51/R57, pre-gen-3). When
  the gen-3 reprocessed game.json exists, re-run:
  `python -m vbpipe.eval_corrections corrections_game2.json game.json`
  and `python typer_sweep.py corrections_game2.json game.json`.

## Done in session 6 (server Drive import fixes — vbatnight.com droplet)
- Drive OAuth on the server: refresh token was dead (invalid_grant) —
  consent screen in "Testing" status expires refresh tokens after 7 DAYS.
  Fix: publish the consent screen to production, re-mint via `npm run
  drive-auth` + SSH tunnel (`ssh -L <port>:127.0.0.1:<port>` because the
  loopback listener runs server-side). Token now long-lived.
- Import OOM: fetch-based `downloadFile` buffered the whole multi-GB bundle
  in process memory (anon-rss 3.6GB -> kernel OOM-killed next-server on the
  4GB droplet; browser saw empty 502 -> "Unexpected end of JSON input").
  lib/drive.js downloadFile rewritten on node:https + stream pipeline
  (true backpressure, manual redirect handling). Deploy = push to GitHub,
  `git pull` + `npm run build` + `systemctl restart vbatnight` on the box.
- Ops notes: OOM-killed imports skip the route's cleanup — clear stale
  `/tmp/btimport-*` dirs after crashes. If /tmp is tmpfs, set
  `Environment=TMPDIR=/opt/vbatnight/tmp` in vbatnight.service (bundles
  don't belong in RAM). Consider a swapfile on the droplet.

## Done in session 6 (fps-aware ball stage — the 60fps unlock)
- **Discovery: the whole ball stage resampled to 20 fps** regardless of
  source (`detect_all(fps=20.0)` default, ballcv `FPS=20`, all via ffmpeg
  `fps=` filter). The historical "median 3.7 det/s" bottleneck had a
  20-samples/s ceiling built in; 60fps recordings would have gained ZERO.
- cli: `--ball-fps auto` (default) = source fps capped at 60 (ffprobe), or a
  number (`--ball-fps 20` = exact legacy behavior). Passed to both ball
  paths. Old 30fps videos now auto-sample at 30 (a free density bump on
  reprocess).
- ballcv.detect_rally(fps=): frame-differencing keeps a ~50ms baseline via a
  stride (at 16ms spacing a slow ball overlaps itself and vanishes from
  consecutive diffs); candidates still emitted at full fps. _select dedupe
  window 0.04s → 0.8/fps (at 60fps the old constant ATE real consecutive
  points). _link/physics filters were already time-based.
- plays.find_contacts: velocity window now spans ≥2 points AND ≥0.1s
  (time-floored). At 33ms baselines pixel jitter amplifies into velocity
  noise — synthetic 60fps test: old ±2-index fired 5 false contacts on
  1.5px jitter, new fires exactly the true one.
- **Verified**: fps=20 bit-identical to pre-edit code on real footage
  (example video rallies 9+18) AND on all 46 game2 ball arrays (342
  contacts). At fps=30 on the SAME 30fps example video: density 1.5→6.9 and
  0.8→5.4 det/s (supra-linear: more frames → more arcs survive the ≥5-pt/
  0.25s physics filters); rally 18 contacts 2→6 of 10 true touches.
- vbpipe.zip rebuilt (plays/ballcv/cli) — **RE-UPLOAD to Drive/balltime**.
  ball_gen2 mining unaffected (defaults preserved). Trained-model path at
  60fps still needs a GPU sanity run (Colab) — expect ~3x ball-stage time
  vs 20fps.
- **cca-one.mp4 verified**: 1920x1080 HEVC, true 60 fps, 17.4 min, in the
  project folder. courts_config.json (v2, per_video key "cca-one" — matches
  the stem the notebook looks up) validated by overlaying its geometry on an
  extracted frame: net_base x aligns with the far-corner midpoint to <1%,
  post base sits on the near sideline, court_corners at frame edges where
  the court is cropped (left baseline off-frame, as expected). Pipeline
  consumes playing_area/net_base/net_top only (attack_lines/court_corners
  are app-side). Ready for Colab once video + rebuilt vbpipe.zip are in
  Drive/balltime; the run should print "[ball] source 60.00 fps ->
  sampling at 60".
- **2 new games incoming (Ken)**: side-angle (recommended position!),
  1080p60, all-new players, court edges cropped — LEFT-side serves
  off-frame, right-side in frame. Before processing: new-camera calibration
  (court_poly + net line re-click) and expect left-serving rallies to need
  their serve added in review; the serve gate won't force-label the first
  seen touch. Eval prediction to check: right-serving rallies should parse
  measurably better than left-serving ones.

## Done in session 5 (durable player identity across games)
- **Problem**: identities were per-game and stats deduped by NAME string, so two
  different people named "Mike" collapsed into one row and there was no way to
  filter/aggregate one person across games. (Ken already hand-worked around it:
  "Julio 1"/"Julio 2".)
- **Model**: new global `players` table (schema.sql) + `identities.player_id` FK
  (migration in db.js — applies on next app boot). identity = a person in one
  game; player = that person across all time (1 player → many identities).
  Duplicate display_names are ALLOWED by design (id is the truth, disambiguate
  visually) — Ken's call.
- `/api/players` (new): GET list w/ game counts + linked identities; POST create;
  POST {action:"merge"} repoints identities + drops the src row; PATCH rename
  (propagates to identities.name). identities PATCH now allows `player_id`.
- **Naming step** (games/[id]/identities): free-text name box → roster typeahead
  (PlayerCombo) — pick an existing player (shown with game counts) or create a
  new one; linked identities get a green ✓. Selecting still writes identities.name
  too, so labels/merge-picker/legacy paths keep working. Cross-game embedding
  suggestion ("Jose? 88%") now carries the matched identity's player_id, so
  accepting links the SAME player, not just a matching string.
- **Stats** (stats/page.js): aggregation keys on player_id (pid:<id>), falling
  back to name:<name> for unlinked identities, so nothing regresses. Two people
  with the same name stay separate rows (distinct pids). ui.js React key → p.key.
- **Backfill**: `npm run backfill-players` (scripts/backfill-players.mjs) makes
  one player per distinct identity name and links them — exact-name grouping,
  idempotent (only touches player_id IS NULL). Verified on a copy: 12 players,
  24 identities linked, players span 2 games each. Ken runs it locally after
  first boot (couldn't write the live DB from the sandbox — SQLite writes over
  the OneDrive-synced path throw disk-I/O errors; live DB verified intact, the
  interrupted attempt rolled back fully).

## Done in session 5 (players admin UI pass)
- `/players` page (in nav, organizer-only): the registry admin — rename, merge,
  split.
- **Merge** = two rows are the same person (repoint identities, drop one), now
  with a confirm modal (shows games/touches moving) + an 8s Undo toast that
  rebuilds the removed player from its identity ids.
- **Split** = one row mixed up two people: select its per-game chips → "Split
  off N" (new player) or "to existing…". Scoped per-player (no cross-player
  ambiguity). Chips show a hover cue + accent check when selected.
- **Search + sort** (most games / most touches / name); **avatar** (rep crop or
  initial) + inline-editable name (borderless, border on hover/focus).
- **Proactive duplicate banners**: page.js flags candidate pairs — exact
  normalized name (trailing " N" stripped, so Julio 1/2 surface) + 1-char
  Levenshtein typos — each with one-click merge (→ confirm) + dismiss.
- **Chips + stats as a hub**: each chip carries per-game touch count; rows show
  games · touches · points. Touches from plays, points from scoring rally
  outcomes (kill/ace/block) — no schema change. Verified on backfilled copy
  (e.g. Jay 2g/50t/10p; dup detector flags Julio 1 ~ Julio 2).

## Done in session 4 (VNL-style leaderboards)
- /stats rebuilt: 7 boards (Scorers, Attackers, Blockers, Servers, Setters,
  Diggers, Receivers), tabbed, ranked, avg/game + efficiency columns.
- **Zero-annotation quality stats**: lib/grades.js derives per-touch grades
  from touch order + rally outcome — no team model needed (set→attack is
  same-team by rule). assist = set immediately before the kill attack;
  dig success = rally continued; reception positive = next touch is a set;
  blocked = last attack in a block-ended rally; reception error = shanked ace.
- Hybrid override (Ken's pick): plays.grade column (migration in db.js);
  chip editor in review gained a grade select ("auto: <derived>" default);
  chips show a colored badge for notable grades (✎ = manually set). Points/
  faults still come from rally outcomes (robust to a missed touch); attempts
  + quality come from graded touches.
- Verified on game2 (86 rallies, 535 touches, --all): 16 kill grades ≤ 18
  kill outcomes, 13 assists, 58/63 digs kept, 70/99 positive receptions;
  setters (Emily 26 sets/6a, Noah 25/5a) surface correctly.
  `node scripts/verify-boards.mjs [--all]` re-runs the check.
- Known limits: untouched aces can't be charged to a receiver (team known
  once assigned, individual not); "excellent vs in-play" nuance for sets/
  digs/receptions only via manual override; block faults not tracked.

## Done in session 4 (team-aware grading — the overpass fix)
- Ken spotted the flaw: adjacency rules assume consecutive touches are
  same-team, so an overpass set that gets killed earned a false assist, and
  a shanked receive followed by any set graded "positive".
- identities.team ('A'/'B', per game) + A/B toggle in the name-players step.
  Position auto-suggest: median contact-x per player vs game median (~net);
  suggested side shown dashed ("A?"), one-click "assign N players" banner.
  Suggestion needs ≥2 located touches and ≥70% side-consistency.
- deriveGrades(touches, rally, teamOf): credit (assist/positive/success)
  requires next touch same-team; touch directly before an OPPONENT kill →
  'error' (the overpass gifted the point). No teams assigned = old behavior.
- Verified: overpass-killed receive → error; set-overpass → error (was
  assist); opponent setting a freeball still earns a real assist; normal
  rallies unchanged. Charging the receiver requires teams assigned.
- Name-players UI: removed embedding merge-suggestion widget ("Look like the
  same person?" — wasn't working for Ken; Duplicate… modal still covers
  merges). Added "📷 Court view" popup: paused video frame at each rally's
  serve (prev/next rally stepping) to see who's on which side while
  assigning teams. Full-game-video (v8) games only.
- Highlights (/watch) filters: game / player / touch-type selects (sticky
  bar, rally count, clear). Filtered clips start ~3s before the first
  matching touch instead of the rally start; captions list the matched
  touches. Server page ships per-rally touch lists; ui.js filters client-
  side. Checked on game2: Jay+attack → 12 of 49 rallies, correct seeks.
- Import from Google Drive (service account, no SDK): lib/drive.js does
  RS256 JWT auth via node crypto + Drive REST (list folder + subfolders,
  stream download). /api/drive GET lists bundle zips, POST downloads +
  imports (extraction refactored into lib/import.js importGameFromZip,
  shared with the upload route). Import page shows a "From Google Drive"
  section when configured. Setup: app/DRIVE-SETUP.md — Ken needs to create
  the service account, share Drive/balltime with it, set GOOGLE_SA_KEY +
  DRIVE_FOLDER_ID in .env.local. JWT signing verified with throwaway key;
  end-to-end untested until credentials exist.
- Auto-trash after Drive import: REVERTED. It broke the gen-2 flywheel —
  ball_gen2.ipynb Cell 1 re-detects each game from its bundle, so bundles
  must stay in Drive/balltime/bundles. Scope back to drive.readonly, share
  as Viewer. Clear bundles manually when done retraining.
- Drive download bugfix: dynamic import("stream") came back undefined under
  Next's bundler — static imports now (same as upload route).
- Review: decisive grades auto-fill the rally outcome (kill/stuff/ace
  always; serve/attack "error" only when it's the last touch, since a
  mid-rally error is an overpass). Outcome selects update live; still
  editable by hand.
- Export corrections: "Export corrections ▾" button now opens a small menu
  — To project folder / To Google Drive / Download file. File named by game
  stem (corrections_<name>.json), matching the notebook (NOT the DB id).
  Drive upload (lib/drive.js uploadFile, upsert by name) writes straight
  into Drive/balltime where gen-2 reads corrections.
- Drive auth switched to USER OAUTH (Ken's call: production-compatible,
  solve-once). Service accounts can't own files on a personal Gmail (no
  quota) so upload failed. lib/drive.js now prefers OAuth refresh-token
  (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN), falls back to SA for
  read-only; driveCanUpload() gates the Drive export option. One-time
  `npm run drive-auth` (scripts/drive-auth.js) runs a loopback OAuth flow
  and prints the refresh token. DRIVE-SETUP.md rewritten OAuth-first;
  imports keep working on the existing SA until Ken finishes OAuth. Prod
  path: same flow, refresh token moves env → per-user DB row.
- ball_gen2.ipynb Cell 1 rewritten as a friendly PREFLIGHT: checks folder +
  vbpipe.zip + ball_model.pt + GPU, cross-references every bundle/video/
  corrections stem into a readiness table (✅ trains+scored / ⚠️ need video
  X.mp4 / etc.), and hard-stops with "put X in Y" guidance only on fatal
  gaps. Flags orphan corrections (the old silent "skip: no video/bundle").
  Intro markdown points at it. Simulated against a mock Drive layout.
- Hi-res ball inference (gen-2 result was a wash: F1 0.59->0.56, density
  5.0->5.1, because mining reinforces what v1 already sees; source is 1080p
  but detect_all decoded 720p). track._frames now takes optional w/h;
  detect_all(model, ..., hi_res=False) — hi_res decodes native 1920x1080 +
  imgsz=1920 (~2-3x slower), and scales detections back to the 1280x720
  reference space so contacts + overlay are unaffected. Default off; cli.py
  unchanged (flip to default once proven). vbpipe.zip rebuilt — RE-UPLOAD
  to Drive/balltime. ball_gen2 Cell 5 rewritten to A/B four conditions:
  v1@720 / v2@720 / v1@1080 / v2@1080 (RUN_HI_RES toggle), isolating the
  resolution lever from the fine-tune lever; if a 1080p row wins, next step
  is retrain at 1080p (gen-3). Coord-scaling verified on the 1080p sample.
- Bugfix: the Cell 1 preflight rewrite stored the bundle PATH in games[stem]
  instead of the parsed game.json (Cell 2 crashed "string indices must be
  integers"). Now loads game.json from the bundle -> games[stem]=(vid,dict).
- Gen-3 hi-res retrain (the inference-only test was CONFOUNDED: v2@1080 gave
  density 5->14.5/s and recall 58->68% — resolution surfaces the ball — but
  precision 60->28% because a 1088-trained model met out-of-scale 1080p
  balls). Fix = train at the resolution we infer at:
  * balltrain.detect_all gained conf= param.
  * Cell 2 mining: MINE_HI_RES (default True) detects at 1080p/imgsz1920 for
    ~3x recall, but scales dets back to 1280x720 BEFORE ballcv linking (its
    gravity/dist/speed/y thresholds are 720-tuned) — arcs stay in 720 coords,
    Cell 3 SC=1.5 unchanged.
  * Cell 4 trains at imgsz=1920, batch=4 (T4 memory), still -> ball_model_v2.pt.
  * Cell 5: v2@1080 is now the fair test; added a FREE confidence sweep
    (detect once at conf floor 0.10, re-threshold in Python — proven
    equivalent to re-detecting) to recover precision; verdict = best v2@1080
    vs v1@720 baseline (✅>=+.03 / 🟡 / ❌).
  vbpipe.zip rebuilt — RE-UPLOAD. All 7 cells parse.
- 2-game gen-3 result: game2 +0.12 (0.53->0.64, WIN), game1 +0.01 (wash);
  hi-res rescues detection-starved footage most. At shared conf=0.25 both
  games >= baseline (no downside), avg F1 0.62 vs 0.56. v2@720 worse on both
  = genuine resolution effect, not overfit. PROMOTING (coupled):
  * cli.py: added --ball-hires (default True) / --no-ball-hires + --ball-conf
    (default 0.25); detect_all called with hi_res + conf. vbpipe.zip rebuilt.
  * process_game.ipynb needs NO change (extracts vbpipe fresh, passes only
    --ball-model, inherits new defaults).
  * Promotion = Cell 6 PROMOTE=True (backs up ball_model_v1_backup.pt, copies
    v2->ball_model.pt) + re-upload vbpipe.zip. Rollback: restore backup +
    --no-ball-hires. Pipeline ball stage now ~2-3x slower (worth it).

## Session 3 findings: first full-game scorecard (game2, 571 corrections)
- eval fixes: merge-chain resolution (export now includes identity row ids),
  split-rally grouping, manual-rally counting. vbpipe.zip rebuilt.
- Scorecard: contacts P 51% / R 57%; play type 38% (cascade errors — missed
  serve shifts every label); attribution 15% floor (unmerged fragments count
  as wrong, true value higher but still poor); 7 rallies missed outright.
- Diagnosis: NOT thresholds (sweep plateaus at F1 .56), NOT the contact
  algorithm (arc-fit prototype scored worse on same data). Root cause is ball
  detector density: median 3.7 det/s, 16/46 rallies under 3/s. Ball moves
  contact-to-contact in ~1s → trajectories too sparse to segment.
- **Gen-2 ball model RESULT (2026-07-21)**: contacts F1 0.53 -> 0.61
  (P 48->57%, R 58->66%), density 4.0 -> 4.8 det/s (zero-det rallies are the
  no-touch junk segments, so real-rally gain is larger). Promoted; games being
  reprocessed. Notebook is reusable for round 3+ as corrections accumulate.
- Gen-2 ball model — notebooks/ball_gen2.ipynb is ready. It mines
  physics-verified arcs from every processed game (current model @ low conf),
  adds hard negatives, fine-tunes to ball_model_v2.pt, and scores v2 vs v1
  against the corrections files BEFORE promotion (Cell 6 promotes).
  Ken: upload corrections_game2.json + latest vbpipe.zip to Drive/balltime,
  then Run all on T4. After promoting: delete bundles, reprocess, re-import.

## Done in session 3 (single-video architecture)
- **Decision (Ken): no more per-rally clip files.** v8 bundles ship the full
  game video (faststart remux); app plays each rally as a media fragment
  (#t=start,end) of it. Rationale: clips were ~same total size as the source
  and froze detector boundary mistakes into files.
- Review UI gained boundary tools, all metadata-only now: "start/end at
  playhead" (fix truncated/overlong rallies), "+ rally at playhead" (add
  rallies the detector missed; idx -1 = no pipeline counterpart), plus the
  earlier "split here". Old clip-based games still play fine.
- eval_corrections: groups split halves by pipeline idx, reports
  detector-missed (manual) rallies separately.
- Review page also got: timeline strip nav (replaces button swarm), ←/→ keys,
  attribution-confidence chip colors (amber = 80px+ stretch, red dashed =
  unattributed), chip timestamps in scrubber time.
- Import: bundle uploaded as raw stream (FormData chokes >1GB), extracted with
  system tar (adm-zip dies at 2GiB).

## Done in session 3 (rally undercount fix)
- **Bug**: games showed ~9 of ~35 rallies. rally.py segmentation was fine
  (37 rallies on "full game example.mp4"); the plays stage in cli.py was
  re-imposing the 8-player formation gate, overwriting the phases notebook v6
  had already set and silently marking most rallies warmup (no clip, invisible
  in app). Fixed: cli.py now gates on --game-start only and respects pre-set
  phases. vbpipe.zip rebuilt — **re-upload it to Drive/balltime** so Colab
  picks up the fix; re-run affected games (delete their bundles to reprocess).
- New: `python -m vbpipe.rally_debug VIDEO [--court c.json] -o diag` —
  keyframe-interval check, motion/threshold stats, parameter sweep, plot.
- Known minor: occasionally 2 real rallies merge into one segment
  (max_gap_s=4). Lowering it over-segments (gap=2 → 49 segs on this video);
  leaving as-is, fixable in review UI.

## Done
- **M1 feasibility**: rally detection + player clustering validated on real
  footage (`m1-spike/REPORT.md`).
- **M2 AI pipeline** (`pipeline/`, Python): rally segmentation (CPU), YOLO11 +
  ByteTrack player tracking, OSNet identity clustering with temporal
  constraints, bootstrap-trained ball detector (auto-labeled, no hand labels),
  contact detection + rule-based play typing. Rally 18 benchmark: ~85% touch
  capture vs Ken's ground truth. Runs on free Colab T4 (`notebooks/`).
- **Review UI** (`app/`, Next.js + SQLite): game list, identity naming
  (name/merge/dismiss with rep crops), transcript review (rally clips, editable
  touch chips, add-at-playhead, soft delete). Example game imported. Working
  on Ken's machine (Node 24, built-in node:sqlite; better-sqlite3 optional).

## Key decisions
- AI-first build order; single league (Ken's) first, tenant-ready schema.
- Warmup handling: organizer supplies "game starts at" timestamp (--game-start)
  + 8-player formation gate.
- Processing: free Colab for GPU stages; everything else CPU.
- Corrections in review UI are flagged (corrected=1) = future training data.

## Done in session 2
- **Auth**: magic-link login (Resend; console fallback in dev), sessions,
  organizer role via ORGANIZER_EMAILS env. All pages gated.
- **Rally outcomes**: review UI captures point-ended-by (kill/error/ace/
  block + player) per rally -> real stats.
- **Viewer pages**: /watch (published games' rally clips + outcome captions),
  /stats (per-player touches, kills, aces, errors). Publish toggle per game.
- No seasons/leagues — decided: it's pickup, flat game list.

## Done in session 2 (continued)
- **Split UI**: tracklet-level splitting for mixed identity clusters; merges/
  dismissals re-point plays so stats stay correct. Merge picker is a modal.
- **Identity workflow speedups**: identities split into "involved in scored
  touches" vs collapsible "never touch the ball (naming optional)"; crops
  collapsed to one representative + expander; embedding-based merge
  suggestions ("87% match — Merge?") for games imported with the new
  pipeline bundle (cli.py now exports tracklet embeddings).
- Pipeline cluster_thresh 0.16 -> 0.12: over-split beats under-split.
- Decision: NO cross-week player gallery — pickup games, clothes change
  weekly, re-ID doesn't transfer. Same-night propagation still viable later.

## Done in session 2 (correction flywheel)
- "Done ✓" clean-flag per identity (collapses to slim row; stays a merge/move
  target). Typicality ranking: most-representative crop leads each identity;
  outliers sort last (color-based for game 1, embedding-based for future
  imports).
- **Corrections bridge built**: `npm run export -- <game_id>` dumps the
  human-approved transcript; `python -m vbpipe.eval_corrections
  corrections.json game.json` scores the pipeline per stage (contact P/R,
  play-type confusion, attribution). Decision: NO in-app annotation tool —
  the review UI is the annotation tool; training/eval stays in the pipeline.
- Flywheel: review game -> export -> eval scorecard -> tune/retrain in Colab
  when labels accumulate (learned play-typer viable after ~15-20 reviewed
  games).

## Done in session 2 (streamlined per-game flow)
- **process_game.ipynb**: single consolidated notebook. Drive folder `balltime/`
  holds video + vbpipe.zip + persisted ball_model.pt (trains once, reused).
  Edit 2 config lines, Run all -> downloads game_bundle_<name>.zip.
- **In-app import**: "+ Import game" button -> upload bundle zip -> lands on
  identity naming. No terminal anywhere in the per-game loop.
- cli gained --ball-model (trained detector) vs default motion-CV.
- New app dep: adm-zip (Ken: run `npm install --omit=optional` once).

## Done in session 2 (multi-game nights: 8-10 games/night)
- Notebook is now batch + resumable: processes every video in Drive/balltime
  without a bundle yet, saves bundles to Drive/balltime/bundles/, survives
  Colab disconnects (Run all again to resume). Ball model reused from Drive.
- App import accepts multiple bundle zips; game names derived from filenames.
- Cross-game name suggestions: unnamed identities matched against named ones
  from other games via embeddings ("Jose? (88%)" one-click). Most effective
  within one night (same clothes) — which is exactly the 8-10-game case.

## Done in session 2 (court calibration)
- App /setup page (Camera setup in nav): PER-RECORDING calibration (Ken moves
  the tripod between games): select the night's video files (read locally,
  frame picked in-browser), click court + net per video ('Same as previous'
  shortcut), download ONE courts_config.json -> Drive. Notebook matches
  geometry to each video by filename. Legacy single-court file still works.
- (superseded) load a video screenshot, click court
  corners + net post bases -> downloads court_config.json. Drop it in
  Drive/balltime; notebook passes it to the pipeline automatically (cli
  --court). Replaces hardcoded M1-gym geometry. Redo only when tripod moves.
- Colab facts confirmed: no external API to trigger runs on any plan;
  scheduling = Colab Enterprise only. Pro = longer sessions; Pro+ = background
  execution. Full automation path remains Modal-style serverless at deploy
  time.

## Done in session 2 (full-geometry calibration)
- Camera setup captures 5 layers per recording: playing area (used now:
  player/rally filtering), court corners (future: floor homography px->meters),
  net post bases (used now: side + block logic), net top corners (future:
  height reference), attack/3m lines (future: front/back-row zones). Optional
  steps skippable; ~14 clicks max per recording; "Same as previous" shortcut.
- Pipeline Config parses v1+v2 geometry; extra layers stored but unused until
  the court-coordinate feature work (learned play classifier era).

## Done in session 2 (rally gating redesign)
- Root-caused missing rallies: formation gate at processing time + stale
  notebook + 6s min rally length. Redesign: notebook processes EVERY detected
  segment post game-start (no player-count gate); junk segments dismissed
  in-app via "Not a rally" (phase='skipped', restorable). min_rally_s 6->4
  for quick serve-error points. Gate decisions now cost one click, not a
  Colab reprocess.

## Next up (in rough order)
1. Deployment: cheap VPS (Hetzner/DO), nginx/caddy + node, clips as static
   files. Set ORGANIZER_EMAILS + RESEND_API_KEY (free) + APP_URL.
2. Pipeline conveniences: persist trained ball model to Drive (skip retrain),
   one-command per-game processing, upload flow in the app.
3. Model refinement (parked deliberately): use accumulated review corrections
   + more ground-truth rallies; far-side accuracy; rally outcome inference
   (who won the point) for scores.

## Ground truth so far
`pipeline/ground_truth.json` — rally 18 fully labeled; more labels welcome.
