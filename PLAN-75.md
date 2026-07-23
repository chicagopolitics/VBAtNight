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

## 2. Point the corrections flywheel at more than the ball model
- [ ] Corrections already capture true type + true player per touch
      (571 touches from game2 alone; ~5k after ~10 game nights).
- [ ] Train a small **contact-type classifier** (ball kinematics around the
      contact + attributed player's pose/position) to replace rules when
      confident; fall back to grammar otherwise.
- [ ] Train/tune **attribution** on the same data: depth-adaptive distance
      gates (already flagged in M2-STATUS) → learned scoring of
      (contact, tracklet) pairs. Attribution is the weakest measured link.
- [ ] Keep ball-model gen-N retrains going — but expect diminishing returns;
      gens mine what the previous gen already sees.

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

## Suggested order
1. §0 joint metric (an afternoon; everything else is measured against it)
2. §3 capture changes (next game night — zero code risk, big data upside)
3. §1 resync typer (attacks the worst measured number)
4. §4 stats fixes (visible product wins, independent of ML work)
5. §2 learned models (once corrections cross ~2–3k touches)
