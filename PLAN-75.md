# Plan: 75% rally parsing + trustworthy stats

_Created 2026-07-22. Goal: ML parses ≥75% of touches (detected + typed +
attributed); Ken fixes the rest; /stats stays honest meanwhile._

## 0. Measure the actual goal (do first, small) — DONE 2026-07-22
- [x] Joint metric added to `eval_corrections.py` (funnel: captured →
      family-typed → right player; denominator includes detector-missed
      rallies). Multi-game usage: pass corr/game pairs, prints OVERALL.
- [x] **Baseline on game2 (pre-gen-3 output): JOINT PARSE 2%** (49% captured
      × 39% typed × 12% right player). That's the honest gap to 75%.
      Re-run on gen-3 reprocessed output for the current number.
- Why first: contact F1, type %, attribution % are tracked separately today;
  none of them is the target number, so progress toward 75% is invisible.

## 1. Make play typing resync-able — DONE 2026-07-22 (with a finding)
- [x] Serve anchor shipped: contacts[0] is "serve" only if the next contact
      is on the other side (a serve must cross). 37% → 39% exact; kills most
      false receive→serve labels.
- [x] Resync anchors (4th-touch, long-gap, confidence-gating) implemented as
      opt-in params — **every one of them HURT at contacts P51%**: half the
      contacts are spurious, so the anchors fire on noise (real attacks
      25→7). `pipeline/typer_sweep.py` re-tests all combos in one command.
- **Finding**: typing is detection-limited, confirming the session-3
  diagnosis. True serve is detected in only 16/34 rallies — no typer rule
  can fix that. RE-RUN typer_sweep.py after each ball-model generation;
  flip the anchors on when they start winning.

## 1.5 Identity: the REAL bottleneck is tracking coverage (revised 2026-07-23)
The deep-dive corrected itself twice; final findings, in causal order:
1. **Tracking covers ~6 of 12 on-court players** (median touch: 5 active
   tracklets). Root cause: the court-poly gate uses the CLICKED playing
   area, but servers + back-row stand OUTSIDE the lines — feet heatmap
   piles at the poly fence; frame audit shows ~6 players outside at once.
   [x] FIXED: track.py gate now allows court_margin_px (90px @720p) outside
   the poly. vbpipe.zip rebuilt. **Verify by reprocessing cca-one** —
   expect concurrent tracked ~6 -> ~11-12 and attribution to jump.
2. With coverage broken, attribution labels are noise -> the earlier "92%
   right person" spatial audit was an artifact; the eval's 25% was honest.
   Cluster mega-merge ("blue shirt black shorts" absorbing 8 people) and
   fragmentation are downstream of the same noise.
3. OSNet embeddings measure AUC 0.57 and color-histogram features 0.59 on
   current labels — but those labels are coverage-noised; REMEASURE after
   reprocess before condemning either feature. (Crop-extraction + purity
   harness live in /tmp scripts; re-clustering prototype exists.)
- [x] plays.attribute gates 120/260 -> 220/340 (declined 69->7 on cca-one).
- [x] Reprocess rounds 2+3 done: margin verified, det_imgsz=1280 shipped
      (coverage 6.0→7.4), captured 76%. Attribution ~20-22% under fair
      assignment scoring — NOT tunable (all sweeps flat). Diagnosis: contact
      positions jittered 200-400px; nearest-player is structurally noise.
- [x] **Contact localization (arc-junction)** — TESTED, DOES NOT HELP.
      Prototype fit incoming/outgoing arcs, output their junction as the
      contact. A/B on both games: captured/typed/attribution all within ±2%.
      Root cause it can't touch: attribution error is ~227px (ball-at-hand
      vs body-center box) and player spacing is ~150px; a 10px sharper
      contact is irrelevant. NOT shipped.
- [x] **Attribution is capped ~25% by TRACKING COVERAGE, not geometry.**
      Every proximity variant (instant / window-min / anchor / weight)
      = 20-25% on both games. True player tracked near their touch only
      ~55%; even then contact is 227px from body-center. The lever is
      getting the right player tracked + disambiguating at the hand — not
      contact quality. Two candidate directions below (Ken's call).
- [ ] Raise/disable cross-game embedding suggestions (fired 92-93% on
      all-new players).
- See §1.6 for the phased plan out of the 25% attribution ceiling.

## 1.6 Attribution roadmap — the two-phase plan (2026-07-24)
Attribution is the binding constraint (funnel: 60% captured × 43% typed ×
**19% right-player**). Diagnosis is settled: it's capped ~25% by (a) the true
toucher only being TRACKED ~55% of the time and (b) the ball-at-hand sitting
~227px from the body-center box at ~150px player spacing. Neither contact
localization nor any proximity-metric tuning moved it. More games alone won't
either — the cap is structural. Two architectural phases, sequenced:

### Phase A — detection coverage  [SHIPPED to config, awaiting reprocess]
- [x] det_model yolo11n→yolo11m, det_conf 0.35→0.20, det_fps 10→15
      (det_imgsz 1280 + court_margin 90 already in). Costs ~4-6x track time.
- [ ] Ken: reprocess both cca games, send game.jsons. Success =
      concurrent tracked ~7→~11; measure attribution lift under body-center.
- Decision gate: if coverage rises but attribution stays ~25% → the
  hand-offset is the wall, Phase B is confirmed. If attribution rises with
  coverage → we may need less of Phase B.

### Phase B — pose-based attribution  [prototype ready to ride Phase A reprocess]
- Idea: attribute to the nearest WRIST keypoint, not the body-center box —
  matches the ball to the striking hand, which is what disambiguates players
  at 150px spacing.
- Design (non-invasive): a pose pass runs ONLY at contact times (~500/game,
  cheap vs per-frame), enriches each contact with nearby wrist keypoints +
  their tracklet id. Default attribution UNCHANGED, so it can't regress the
  Phase-A coverage measurement. Ken runs it in the SAME reprocess; wrist-vs-
  body attribution is then compared OFFLINE against corrections (no second
  slow run, effects stay separable). `pipeline/pose_attrib.py` (new).
- [ ] Validate wrist keypoints are sane on a few rallies before trusting the
      full run (measure-first, same discipline as arc-junction).

### Phase B RESULT (2026-07-24): geometry solved, IDENTITY is the wall
Pose ran on cca-one. Attribution 36% (body) -> 39% (wrist), only +3pp,
because contact->player geometry is already near its 86% oracle ceiling.
The real gap: 42% of touches have no correctly-clustered tracklet for the
toucher — and 96% of those are a tracked body AT the ball with the WRONG
cluster label. Attribution is now purely an identity problem.

## 1.7 IDENTITY — the final attribution lever (the model can't tell players apart)
OSNet embeddings AUC 0.57, color-hist 0.59 on this footage: similar builds,
jerseys, gym lighting. Options, roughly in effort order:
- [x] Hi-res reid crops: TESTED — embedding AUC 0.57->0.61, attribution
      UNCHANGED (36/39%). Players genuinely too similar; appearance ID is a
      dead end at any resolution. crop_hires can be flipped off.
- [ ] Stronger reid model / different backbone; or fine-tune reid on Ken's
      corrected identities (he labels players every game — training data).
- [ ] Jersey-number OCR if numbers are legible (may not be, rec league).
- [ ] Spatial-temporal identity: within a rally ByteTrack IS locally correct;
      lean on court-position continuity + team side to link tracklets to
      players instead of appearance alone.
- [ ] Product fallback: automated attribution caps ~40%, but Ken's review
      (merge/split, already built) produces CORRECT stats. The automated
      number reduces review burden; it isn't the final accuracy. Decide how
      much identity R&D is worth vs. accepting review-assisted attribution.

### Phase C — learned attribution + flywheel  [after A/B measured]
- Train a small scorer over (distance, incoming-arc angle, timing offset,
  wrist-vs-body, box geometry) on ~1000+ corrected touches. Inherits the
  coverage cap, so it comes AFTER A/B, not before.
- Contact-type classifier likewise (replaces rule typing when confident).
- Keep ball-model gen-N retrains going (diminishing returns expected).

## 2. Corrections flywheel  → folded into §1.6 Phase C
The learned contact-type classifier + learned attribution scorer now live in
§1.6 Phase C (they inherit the coverage cap, so they run after Phase A/B are
measured). Ball-model gen-N retrains continue independently as corrections
accumulate (~465-571 touches/game; ~2 games in hand).

## 3. Capture-side levers (cheapest wins per unit effort)
- [x] **60 fps recording**: Ken switching all future recordings to 1080p60.
- [x] **fps-aware pipeline (2026-07-22)**: the ball stage was silently
      resampling EVERYTHING to 20 fps (`detect_all(fps=20)`, ballcv
      `FPS=20`) — 60fps footage would have gained nothing. Now:
      `--ball-fps auto` (source fps capped at 60) in cli; ballcv strides its
      diff baseline (~50ms) + fps-scaled dedupe; find_contacts velocity
      window is time-floored (≥2 pts AND ≥0.1s). fps=20 verified
      bit-identical to old code (real footage + game2 ball data). On the
      30fps example video, sampling at 30 instead of 20: density 1.5→6.9
      and 0.8→5.4 det/s (supra-linear — more frames = more arcs survive the
      physics filter); rally 18 contacts 2→6 of 10 true touches. Trained-
      model path gets the same fps plumbing; verify on Colab (GPU) with the
      new games. Ball stage runtime scales ~linearly with fps.
- [x] **Camera placement**: new games are side-angle 60fps (done). Note:
      left-side serves are OFF-frame (court edges cropped); right-side
      serves in frame. Expect left-serving rallies to need serve added in
      review; serve gate avoids mislabeling their first seen touch.
- [ ] New-camera calibration: re-click `court_poly` + net line for the new
      angle before processing (6 clicks; app Camera setup page or config).
- [ ] Fast shutter / good light — motion blur is why stock YOLO failed on
      the ball in the first place.

### Camera placement cheat-sheet
- Position: mid-court sideline, centered on the net line extended.
- Height: as high as practical (3–5 m; top of bleachers > tripod).
- Frame: whole court + serving zones; static; landscape.
- Record: 1080p (pipeline now infers native 1080), 60 fps, avoid backlit
  windows behind play.
- New position ⇒ re-click `court_poly` (6 clicks) in `vbpipe/config.py`.

## 4. /stats honesty + obvious wins
- [ ] **Fix the rate bias**: kills/aces/stuffs come from outcomes (complete)
      but attempts come from detected touches (~60% capture) → efficiency
      and ace% are inflated on uncorrected games. Either compute rate columns
      only from reviewed games, or show a per-game "reviewed %" badge and
      flag rates as provisional.
- [ ] **Scores & team stats**: per-rally outcomes already imply running
      score, final score, win/loss; with teams assigned, side-out %. First
      thing rec players ask; data already exists.
- [ ] **Trends over time**: durable player_ids (session 5) enable per-player
      game-over-game lines (kills/game, efficiency). The payoff of the
      players-table work.
- [ ] Smaller, already-known gaps: block faults; untouched-ace receiver
      charge (needs teams); reception on a 0–3 passing scale instead of
      binary (one more option in the grade override).

## Suggested order (revised 2026-07-24)
DONE: §0 joint metric · §1 serve-anchored typer · §3 capture (60fps + fps-
aware pipeline + camera) · §1.5 tracking margin + det_imgsz + gates.
NOW:
1. §1.6 Phase A reprocess (SHIPPED, awaiting Ken's Colab run) + Phase B pose
   prototype riding the same run — the attribution ceiling is the binding
   constraint on the joint score.
2. §4 stats fixes — visible product value, zero ML dependency, can proceed
   in parallel with reprocesses (scores/win-loss first).
3. §1.6 Phase C learned models — after A/B are measured on ≥2 games.
NOTE: current 2-game frozen baseline = JOINT 5% (60% captured × 43% typed ×
19% right-player); every change is measured against comparison/ on BOTH games.
