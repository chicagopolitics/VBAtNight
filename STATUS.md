# Balltime replacement — project status

_Updated 2026-07-23 (session 6)_

## Session 6: PRECISION reframe (Ken's #1 review pain) — wristless filter
- Ken's key insight: attribution & type errors are 1-click fixes; the real
  pain is TOUCH-COUNT INFLATION (a rally with 20 detected / 12 real forces a
  wipe-and-redo). So optimize PRECISION, not attribution — and precision is
  movable (unlike the identity wall).
- reject_wristless_contacts (replaces the cca-one-specific apex filter):
  drop any contact with no wrist within wrist_max px (default 180) — a real
  touch needs a hand at the ball. Camera-agnostic (anatomy, not frame y).
  Results @180 on both games:
  * cca-one: inflation 1.26x -> 0.98x, badly-inflated rallies 15/40 -> 8/40,
    P 55->66%, R 70->64%.
  * cca-two: inflation 1.20x -> 1.03x, 7/31 -> 4/31, P 63->69%, R 76->71%.
  Tunable via --wrist-max (lower = less inflation, less recall). vbpipe.zip
  rebuilt. NOTE: Ken's hires run used a pre-apex zip so NO wristless/apex
  filter applied — next reprocess with the current zip delivers this.
- Strategy crystallized: (1) ship the precision fix (done), (2) accept
  review-assisted attribution (Ken: "review-assisted is fine"), (3) pivot to
  §4 stats features. The identity wall matters less now: inflation is fixed
  and attribution errors are 1-click in review.

## Session 6: hi-res crops probe RESULT — appearance ID is a dead end
- Both games reprocessed with crop_hires. Embedding AUC 0.57 -> **0.61**
  (cca-one), 0.59 (cca-two) — a real but tiny bump. Attribution UNCHANGED:
  cca-one body 36%/wrist 39% (identical to 720p control), cca-two 30%/29%.
- Conclusion: 2.2x the pixels bought +0.04 AUC; need ~0.85 for clustering to
  work. The players are genuinely too similar (build/wear/lighting) —
  APPEARANCE-based re-ID won't separate them at any resolution. Hi-res crops
  not worth the extra runtime; can flip crop_hires False.
- Silver lining: **cca-two seen clean for the first time** — captured 76%,
  typed 64%, static impostors gone. Its ball/typing are healthy; only
  attribution lags (30%, even worse than cca-one — more similar roster).
- DECISION POINT: appearance is out. Remaining identity levers:
  (a) SPATIAL-TEMPORAL identity (use court position + team side + within-
      rally track continuity, NOT appearance) — now the most promising
      automated route since it sidesteps the look-alike problem.
  (b) reid fine-tune — uncertain ceiling when base appearance AUC is 0.61.
  (c) accept review-assisted (merge/split already yields correct stats) and
      pivot to §4 stats features.

## Session 6: hi-res crops probe (identity lever #1) — BUILT
- track.py crop_hires (config, default True): decode native 1080p, downscale
  to 720p for DETECTION (boxes stay in 1280x720 ref), but save player crops
  from the 1080p frame. Far player crop 69x63 -> 103x94 (2.2x pixels);
  side-by-side shows modestly sharper jerseys/faces. The re-ID model resizes
  crops to 256x128, so more native pixels = more real detail to embed.
- Isolation: attribution on this run vs the prior pose run (720p crops, 39%,
  same everything else) = the hi-res-crops effect, clean. captured/typed/
  contact are crop-independent so they just reflect current pipeline state.
- Runtime: tracking now decodes 1080p + per-frame resize (slower). vbpipe.zip
  rebuilt. If it doesn't lift attribution, flip crop_hires False (cheap
  revert) and consider spatial-temporal identity or reid fine-tune next.

## Session 6: apex-phantom rejection (pose-based) SHIPPED
- Ken still saw top-of-arc phantom touches — pose recorded wrists but didn't
  yet USE them to reject. Now it does: pose_attrib.reject_apex_phantoms drops
  a contact if the ball is HIGH (y<220, airborne) AND no wrist within 140px
  (a real touch needs a hand at the ball). Applied in the plays stage after
  enrich_contacts. Validated on the cca-one pose run: −46 apex phantoms,
  contact P 55->64%, recall -3pp (captured 70->67%), typed 63->64%.
  Blanket wrist-distance and trajectory (split-gain) filters cost too much
  recall; the height+wrist combo is the clean one. vbpipe.zip rebuilt.

## Session 6: POSE RUN — attribution wall is IDENTITY, decisively
- cca-one reprocessed with pose + global static suppression. Results:
  * static impostors: **0%** at all 4 known spots (global suppression works).
  * captured 70%, family-typed **63%** (up from 58/46).
  * attribution: body-center 36%, **wrist 39%** — pose only +3pp, NOT the
    leap the smoke test implied.
- WHY pose barely helped — decomposition of attribution (assignment-scored):
  * ORACLE geometry (assign each touch to the true player's own tracklet):
    **86%** ceiling with current clusters. So contact->player geometry is
    near solved; pose/body are close to that ceiling already.
  * The gap: **42% of matched touches have NO tracklet near the contact
    whose cluster resolves to the true player.** Split of those 73 failures:
    **96% = a tracked body IS physically at the ball but carries the wrong
    cluster label; only 4% genuinely untracked.**
- CONCLUSION: attribution is now ~100% an IDENTITY-CLUSTERING problem. Not
  coverage (median 9/12 tracked, toucher present 96%), not geometry (86%
  ceiling), not contact quality. The OSNet embeddings are degenerate on this
  footage (AUC 0.57 — every player looks alike: similar builds/jerseys/gym
  light), so tracked players scatter into wrong/fragment clusters.
- Pose still earns its keep for the APEX-rejection (precision) it enables,
  but for ATTRIBUTION the lever is now identity, full stop. Whether to
  promote wrist attribution (marginal +3pp) is secondary.
- **THE WALL: can we tell these players apart?** Next lever options in §1.7.

## Session 6: POSE FEASIBILITY CONFIRMED + global static suppression
- Pose smoke test on CLEAN cca-one (yolo11m-pose): on real-ball contacts at
  touch height, **86% (24/28) have a wrist within 140px** of the ball
  (median far tighter than the 227px body-center; min 6px). Answers Ken's
  "is wrist-finding even feasible" — YES. Pose runs INSIDE player boxes so
  wall-sign/light false-positives don't apply.
  * BONUS: all 8 real contacts with the ball HIGH (mid-air/apex) had NO
    close wrist — pose ALSO solves the apex-phantom problem ("smooth arc AND
    no wrist at ball" = drop). Attribution + apex fix from one signal.
  * 12 contacts had a close wrist pointing at a DIFFERENT player than
    body-center = exactly the attribution errors pose corrects.
- Smoke test also exposed MORE static ball FPs at ~(776,113)/(43,348) — the
  gym has several fixed round objects; per-rally suppression missed each
  (under-threshold individually). 41% of smoke-test contacts were static-FP.
- FIX: two-pass detect_all + global_static_cells (balltrain.py). A cell is a
  fixed object if it has sustained presence (>=12 frames) in >=3 rallies AND
  near-zero position variance (std<2.5px) — the VARIANCE gate is essential:
  dwelling-count alone flags busy centre-court (nuked recall to 4%); variance
  cleanly isolates lights (std~0.7px) from the ball scattering through a cell.
  Found exactly the right cells: ceiling light (20/60,340), upper light
  (780,100), corner scoreboard (1260,20). Conservative defaults; recall
  "cost" on thinned data is the lower-bound artifact (recovers on reprocess).
  Regression: also_static=None == prior behavior. vbpipe.zip rebuilt.
- NEXT: reprocess cca-one (global static + pose via --pose-model) -> clean
  ball + wrists in game.json -> score wrist-vs-body attribution + apex-reject
  against corrections. If wrist attribution wins, PROMOTE it (make wrist the
  default attribution path). This is the Phase B payoff.

## Session 6: two model-view findings from Ken (residual static + apex)
- Ken watching cca-one model-view spotted (1) the light/sign STILL detected
  as ball intermittently, and (2) a PHANTOM contact at the top of every arc.
- (1) Residual static: per-rally suppression (0.25) missed the light at ~15%
  of a rally's frames. Lowered static_frac 0.25->**0.15** — contact P
  51->54%, recall flat, clears the model-view flicker. Global cross-rally
  static map would be even more robust (TODO: two-pass detect_all). Shipped.
- (2) Apex phantoms CONFIRMED (Ken's insight): at a parabola apex the ball's
  vy reverses -> find_contacts' direction-change trigger fires with no real
  touch. ~38 of 179 phantoms at apexes; phantoms follow a smooth single arc
  (median parabola-resid 4.6px vs 15.3 for real touches). BUT every
  trajectory-only rejection (abs residual, two-parabola split-gain, apex
  velocity signature) also cuts SOFT real touches that barely bend the arc,
  and "no player near ball" is unreliable (the 227px hand-offset). Net:
  precision up, recall down — not worth it alone.
  **Resolution: the apex filter is a Phase B feature** — with wrist
  keypoints, "smooth arc AND no WRIST at the ball" cleanly removes mid-air
  apexes without touching real hits. Deferred to pose.
- vbpipe.zip rebuilt (static_frac 0.15). Next reprocess picks it up.

## Session 6: cca-one REPROCESS with all fixes — big jump
- New run (yolo11m/conf0.20/fps15 + static suppression + margin + 60fps ball):
  * static impostor 43% -> **0%** (ceiling light gone). "35.9 det/s" was half
    garbage; real ball density 18/s.
  * contact PRECISION 39% -> **52%** (teleport contacts gone); recall 73%.
  * family typing 46% -> **58%** (de-noised contact stream -> better ordering).
  * coverage 7.4 -> **8.9** tracked (yolo11m).
  * attribution (fair/assignment) ~20-22% -> **34%**.
  * fair JOINT (assignment attribution) **13%** vs prior 5% baseline — the
    first real multi-lever jump. (eval's raw-resolve JOINT reads 4% because
    cluster ids shuffle across reprocesses; assignment-based is the honest
    cross-run yardstick — use it going forward.)
- Still open: attribution 34% (Phase B pose next — the hand-offset wall),
  set/attack typing confusion (set 16/49, mostly ->attack), 5 detector-
  missed rallies. cca-two reprocess pending (expect a bigger jump: it was
  91% static).

## Session 6: BALL STATIC FALSE-POSITIVES — both games (overlay tool)
- Ken's video review (via new overlay tool) identified the stuck detections:
  the trained ball model FALSE-POSITIVES on round/bright static objects —
  a WALL SIGN on cca-two, a CEILING LIGHT on cca-one. Not stray balls.
- Scale (both games, static-cell audit): cca-one **43%** of ball detections
  are a static impostor @~(20,340); cca-two **91%** @~(20,300). Both at
  far-left edge. cca-one was never "clean" — its density numbers were
  inflated by the light.
- Mechanism hurt BOTH funnel legs: (recall) impostor out-confidenced the
  blurry real ball and detect_all kept only best-per-frame, discarding the
  real ball; (precision) detector flickering between real ball and a fixed
  impostor = "teleport" = phantom contacts in find_contacts.
- FIX validated (balltrain._pick_moving, shipped): on existing data
  (lower bound — real ball already discarded) contact PRECISION jumps
  cca-one 38->50%, cca-two 47->60%. Recall recovery needs a REPROCESS
  (keep all dets/frame, then suppress, then best moving) — can't be shown
  on old best-per-frame data.
- **Model-view is now a FIRST-CLASS pipeline output** (Ken's call — this
  finding proved watching-what-the-model-sees is the best debugger):
  * vbpipe/overlay.py (package) — render_overlay(video, game, out, ...).
  * cli: `python -m vbpipe.cli overlay VIDEO -o OUT` (own stage) OR add
    `--overlay PATH` to a plays run; `--overlay-game-only` trims dead time
    (default renders EVERYTHING so warmup false-positives stay visible).
  * pipeline/overlay.py kept as a thin standalone wrapper (--rally/--t0/t1).
  * Notebook: add the render_overlay call to process() (snippet given) so a
    model_view_<name>.mp4 lands in Drive/balltime/model_views every run.
  Draws ball(red)+conf, trail(cyan), player boxes+cluster id(green),
  contacts(yellow). Default 15fps/720p ~ a few hundred MB for a 17min game.
- FOLLOW-UP LEVER: add the two static-FP locations as HARD NEGATIVES in the
  next ball gen (ball_gen2 already mines hard negatives) so the model stops
  firing on them at the source, not just downstream suppression.

## Session 6: cca-two stuck-ball bug (found via pose smoke test)
- Pose smoke test on cca-two came back 3/64 wrists ≤140px, 0 disagreements —
  INCONCLUSIVE, not negative: the ball in cca-two's game.json is pinned at
  (17,315) [frame-left] for **91% of detections** (conf 0.70, all 35
  rallies). A spare/dead ball on the left sideline, in frame for cca-two but
  not cca-one. Explains cca-two contact recall 46% vs cca-one 79%.
- Root cause: detect_all (trained-ball path) kept only the single highest-
  conf detection per frame — a confident STATIONARY spare ball beats the
  blurry moving game ball and discards it every frame they co-occur.
- FIX: balltrain._pick_moving — keep ALL dets/frame, suppress any 40px cell
  (+8-neighborhood) lit in >25% of a rally's frames (can't be the game
  ball), then best moving det/frame. `suppress_static=True` default;
  `--no-suppress-static` escape hatch. Unit-tested: synthetic spare removed
  + arc kept; cca-two rally stuck-frac 76%->0%. vbpipe.zip rebuilt.
  NOTE: existing game.json can't be salvaged (real dets already discarded) —
  cca-two needs a ball-stage REPROCESS to recover the game ball.
- Pose verdict still PENDING: re-run pose_smoketest on CCA-ONE (clean ball).

## Session 6: arc-junction negative result + Phase-A coverage plan
- Arc-junction contact localization PROTOTYPED and A/B'd on both games
  (scratch only, nothing shipped): captured/typed/attribution all ±2%.
  Dead end — it shifts the contact ~10px, but attribution error is ~227px
  (ball-at-hand vs body-center) at ~150px player spacing. Also swept every
  proximity-attribution variant (instant/window-min/anchor/weight):
  ALL 20-25% on both games. Attribution is capped by TRACKING COVERAGE +
  the hand-offset, NOT contact quality or distance math.
- Two-game frozen baseline (comparison/ folder, current pipeline):
  JOINT 5%, funnel 60% captured x 43% typed x 19% right-player.
  comparison/ holds the 4 canonical files (2 games x original+corrections).
- Decision (Ken: "current model not good enough, need guidance"): pursue
  PHASE A (detection coverage) then PHASE B (pose-based attribution).
  More games alone won't fix the cap; both are architectural.
- **Phase A shipped to config** (vbpipe.zip rebuilt — RE-UPLOAD): det_model
  yolo11n->yolo11m, det_conf 0.35->0.20, det_fps 10->15 (imgsz already 1280,
  margin already 90). Costs ~4-6x track time on T4. Ken: reprocess BOTH cca
  games, send new game.jsons; success = concurrent tracked ~7->~11 and
  attribution rises. If coverage rises but attribution stays ~25%, Phase B
  (pose/wrist keypoints for the striking hand) is confirmed necessary.
- Phase B (next): pose model on tracked players, attribute by min wrist-to-
  ball distance instead of body-center box. Breaks the 227px ceiling.

## Session 6: reprocess round 3 — attribution diagnosis closed
- det_imgsz=1280 landed: concurrent tracked 6.0 -> 7.4 (p90 11). Captured
  76%, R 79%. But attribution stayed ~20-22% even under fair scoring
  (cluster ids shuffle across reprocesses — eval now needs assignment-based
  attribution scoring: greedy 1:1 cluster<->person on vote counts; raw
  resolve() comparison is only valid on the run the corrections came from).
- Gate/anchor/weight sweeps ALL flat (~20-25%) -> not tunable. Decisive
  decomposition: truth person tracked near their touch 55% of the time;
  when tracked, contact->their-box distance median 227px (49% within the
  220px gate). **Contact positions are jittered ~200-400px (0.3s timing
  slop × ~900px/s ball speed) — nearest-player attribution is structurally
  noise at rec-volleyball player spacing (~150px).**
- Conclusion: stop tuning proximity attribution. Two levers, in order:
  (1) contact LOCALIZATION: fit the incoming/outgoing arc segments and
  output their junction as (t,x,y) instead of the raw velocity-discontinuity
  sample — sharpens time AND position; helps typing too (same jitter caps
  it at ~46%).
  (2) learned attribution (PLAN §2): features = distance, incoming-arc
  direction alignment, timing offset, box size/side; labels = Ken's
  corrected touches (~500/game, 2 games and counting).
- cca-one reprocessed (margin + 220/340 gates + 60fps ball). First eval
  looked like a regression — artifact: segmentation changed 42→45 rallies
  and eval mapped corrections by IDX. eval_corrections now maps rallies by
  TIME OVERLAP (idx-equivalent on same-run, correct across reprocesses;
  unmatched = detector-missed). With honest mapping: **captured 65→75%**,
  detector-missed rallies 8→5, attribution attempted 95→171 (declined
  69→17) but right-player still 13% — coverage still ~6/12.
- Margin verified active (11.7% of tracked feet outside the poly) — so
  the remaining coverage ceiling is DETECTION, and the bug is found:
  **track.py never passed imgsz — ultralytics infers at 640**, halving the
  720p frame; far players ~50px for yolo11n. Fix: det_imgsz=1280 config +
  passed to model.track. vbpipe.zip rebuilt — RE-UPLOAD + reprocess BOTH
  cca games again (track stage ~3-4x slower; same lesson as ball gen-3:
  we were paying for pixels the model never saw).
- run2 game.json backed up to /tmp/game_cca-one_run2.json for A/B.

## Session 6: identity deep-dive — tracking coverage was the real bottleneck
- Re-clustering prototype (z-scored embs + junction continuity + cannot-
  links) barely moved purity (29%->30-38% only via shattering). Embedding
  AUC on labeled pairs: 0.57 (~noise). Color-histogram features extracted
  from the video (842 verified crops): AUC 0.59 — also weak. Per-person
  crop montage exposed why: the (tracklet->person) labels themselves are
  noise. My earlier "attribution is 92% right at person level" claim was an
  inference artifact — the eval's 25% was correct all along.
- **Root cause (validated visually + statistically): the track-stage court
  poly gate.** Tracked feet fill the clicked playing_area and pile at its
  boundary (21% within 25px); frame audit shows ~6 players standing OUTSIDE
  the poly mid-rally (servers, back-row). Concurrent tracked players:
  median 6 of 12; at the median touch only 5 tracklets are active — the
  true toucher is untracked half the time, so attribution blames whoever
  IS tracked nearby, and clustering inherits garbage.
- FIX: track.py gate now `pointPolygonTest(...,True) < -cfg.court_margin_px`
  (config default 90px @720p; gate area 18%->43% of frame). vbpipe.zip
  rebuilt — RE-UPLOAD. Side effect: bench/bystanders may get tracked ->
  more dismissals in naming; acceptable.
- Verification plan: delete bundles/game_bundle_cca-one.zip in Drive,
  re-run process_game (picks up margin + 220/340 attribution gates + the
  60fps ball path), then eval the NEW game.json against the SAME
  corrections (no app re-import needed). Expect captured to hold ~65%,
  attribution to jump, and the identity-feature AUCs to be remeasured on
  cleaner labels before any clustering rework.

## Session 6: cca-one scorecard (first 60fps side-angle game, 532 corrections)
- **JOINT PARSE 6%** (vs game2 baseline 2%): captured 65% × family-typed 53%
  × right-player 18%. Ball density 3.7 → **35.9 det/s**; contact R 57→75%
  (P 51→43% — 60fps also surfaces more junk; conf/threshold tuning is a
  future lever). Type exact 38→52%. Typer sweep re-run: serve-gate defaults
  still win, resync anchors still lose at P43 — unchanged.
- **Attribution mystery solved in three acts**: (1) measured 25%-when-
  attempted, 69 declined; gate sweep showed accuracy flat vs gate → not a
  gate problem. (2) Embedding check claimed 71/95 "misses" were unmerged
  fragments of the right person — but (3) the named-pair similarity matrix
  showed OSNet embeddings are DEGENERATE on this footage (every player
  0.86-0.98 similar to every other; also explains the bogus cross-game
  "Emily? 93%" suggestions on new players). Spatial audit was decisive:
  63/71 misses had NO tracked box of the truth player near the contact —
  the pipeline attributed the only person standing there; the tracklet just
  carries a fragment cluster label. Real wrong-neighbor picks: 8/95.
  **Attribution geometry ≈ 92% right at person level; the bottleneck is the
  identity registry (39 clusters for ~16 people) + collapsed embeddings.**
- plays.attribute gates 120/260 → **220/340** (declined 69→7, tiny neighbor
  risk). vbpipe.zip rebuilt — RE-UPLOAD. Person-level projection once Ken
  merges fragments in the app: JOINT ~24-26%. Remaining gaps after that:
  capture 65% (serve-side crop + junk precision) and family typing 53%
  (the §2 learned-typer case grows).
- Reviewer-workflow adds during Ken's review pass: decisive-grade
  tail-delete prompt + "🗑 after" button; D-hotkey delete (select-safe);
  editor chip pulses on playhead sync; "poor" grade for out-of-system
  passes/digs (amber badge; excluded from positive%, manual-only).
- Ken's process note: left-side serves are hand-added (off-frame) — they
  can never be pipeline-captured at this camera position; the joint metric
  carries that structural tax (~19 serve touches/game).
- Embedding degeneracy is now a named problem for identity quality:
  candidate fixes = hi-res crops for embedding (same lesson as ball gen-3:
  resolution), a stronger reid model, or leaning on spatial continuity.
  Cross-game suggestion threshold should be raised/disabled meanwhile.

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
