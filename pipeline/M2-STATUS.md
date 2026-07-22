# M2 status — first full pipeline run (2026-07-17)

Full run on example.mp4 via Colab T4: 40 rallies, 310 tracklets, 25 identity
clusters (14 substantial). See `final_identities.jpg`.

## Identity gate: PASSED
- Near-court players resolve into clean, pure clusters: P3 (dark sweater/green
  shorts), P11 (gray tee), P0 (mauve), P8 (green top), P10 (black/kneepads),
  P15 (blue jersey), P18 (white cap), P2+P20 (JAKOF).
- Two benign oversplits (P0/P9 same player; P2/P20 same player) -> the review
  UI's merge button handles these in one click each.
- Far-side clusters (P12, P13, P14) still mix identities — players are ~80px
  there. Mitigations, in order of leverage: (1) camera placement guidance
  (mid-court, higher), (2) second camera, (3) accept + manual reassign in UI.
- P4/P5 are spectators/bench — court polygon could be tightened, or UI offers
  "not a player" dismissal.

## Runtime/cost
~15 min on free Colab T4 for a 19-min video => within "cheapest viable":
free tier is fine for one game night/week; ~$1-2/game on rented GPU otherwise.

## Remaining M2 gates
1. Play classification prototype (ball tracking + contact detection ->
   serve/set/attack/dig guesses). The hard one.
2. Rally clip cutting (trivial, ffmpeg).

## Ready to start in parallel
The `game.json` schema is now real and populated — the review UI (identity
confirmation + transcript correction) can be built against it today.

---

# Update — play classification prototype working (2026-07-18)

## Ball detection: solved without ML training
Stock YOLO couldn't see the in-game ball (~3% of frames; too small/fast/blurred).
Replaced with classical CV exploiting the static camera: triple-frame differencing
-> body-motion masking -> prediction-gated linking -> parabolic physics
verification. Result: usable trajectories in all 10 game rallies (9-165 pts each),
runs on CPU. See `eval_v3_rally8.mp4` / `eval_v3_rally33.mp4`.

## Play classification: first plausible output
67 contacts across 10 game rallies; sequences follow real volleyball grammar
(serve->receive->set->attack; a block in the long rally). 46% of contacts
attributed to a player identity with a conservative 120px gate; the rest are
"unattributed" for the reviewer. `game_v3.json` has the full transcript.

## Warmup handling (product decision)
Organizer supplies a "game starts at" timestamp on upload (--game-start).
Formation gate (8+ tracked players) additionally skips non-game segments.

## Known gaps
- "attack attack attack" chains: side-detection and touch-count errors inflate
  attack counts; needs ground-truth labeling of a few rallies to tune.
- 2 rallies produced <=1 contact (fragmented arcs) — recall tuning needed.
- Attribution rate (46%) improvable with per-depth adaptive distance gates.

## Accuracy next step
Hand-label ~5 rallies (watch clip, write true touch sequence) -> measure
contact recall + play-type accuracy. That number decides how much review
burden the transcript UI must absorb.

## Pipeline is now CPU-only except player tracking/embedding
(YOLO track + OSNet). Everything else — rally detection, ball, contacts,
plays, clips — runs free on any machine.

---

# Update 2 — trained ball detector + tuned classification (2026-07-18)

## Bootstrap training worked
Fine-tuned YOLO11n on ~auto-labeled frames from physics-verified CV arcs
(no hand labeling). Ball now detected in 19-48% of frames in EVERY game rally
— including rally 18 (was ~0) and far-side play. Model lives in the Colab run;
persist `runs/detect/train/weights/best.pt` for reuse (TODO: save to Drive).

## First measured accuracy (rally 18 vs Ken's ground truth)
Truth:    serve receive set attack receive set attack receive set attack
Detected: serve receive set attack dig set attack dig dig set dig
~85% of touches captured, labels correct-ish (dig vs receive is the same touch
family), 1-2 spurious contacts, final attack mislabeled dig.
**Above the 70% reviewer-assisted target.**

## Fixes locked into vbpipe/plays.py
- Court side from attributed player's FEET, not ball position (2D net-line
  side test is wrong for airborne balls) — fixed the mid-rally attack inflation.
- Contacts with no player within 260px dropped as spurious.
- Contact detection no longer bridges >1.2s detection gaps.

## M2 remaining
- Save + reuse trained ball model (avoid retraining per game night; retrain
  only for new venues).
- More ground truth (3-5 rallies) to confirm accuracy isn't rally-18-specific.
- Rally outcome inference (who won the point) — needed for scores/stats.

## Recommendation
The AI gate is effectively passed. Next major build: the review UI +
stats/publishing web app, consuming game.json.
