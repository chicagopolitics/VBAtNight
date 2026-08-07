# ML improvement plan — learning from review corrections

_Created 2026-08-07_

Premise: we have predictions (`game.json`) and ground truth (the reviewer's
corrections). That is a supervised learning setup. This plan works out which
components those labels actually supervise, in what order to attack them, and
what has to be fixed in the label pipeline first.

---

## Decision: clean-slate training baseline (2026-08-07)

Training data comes from games processed at **vbpipe >= 1.0.0** and no earlier.
Six unprocessed games are in hand, so there is no need to compromise on this
for volume.

**Why, precisely.** Not all labels rot at the same rate:

| Label | Anchored to | Stale? |
|---|---|---|
| Touch happened at t | the video | **No** — a fact about the game |
| Play type | reality | **No** |
| Player name | reality | **No** |
| `x, y` | the ball detector's estimate | Yes |
| `cluster_id`, `tracklet_id` | one run's numbering | Yes, completely |
| `removed_plays` | one detector version's failures | **Yes, and dangerously** |

The last row is the real hazard. Those deletions are the false positives of a
pipeline with no global static suppression and no wristless filter — largely
ceiling lights and wall signs, which the current pipeline no longer emits.
Training a rejector on them teaches it to suppress failure modes that no longer
occur while never seeing the ones that do. Textbook covariate shift.

**Freezing alone does not fix this.** Phase 1 modifies `find_contacts`, the
candidate generator itself, so any negative set collected today goes stale the
moment Phase 1 lands — and again on every future detector change. Model-relative
labels are perishable by construction.

**So the labelling discipline changes too:**

> Record reality, not model output. Instead of "the reviewer deleted this
> detection," record **the complete list of true touches in this rally**.

False positives then become *derivable* — anything the model emits that isn't
in the true list — computable against any pipeline version, forever. The
negatives regenerate themselves instead of being re-collected. This also
subsumes Phase 0.4: a complete per-rally touch list *is* a blind recall label.

**Old games are demoted, not deleted.** `corrections_cca_one/two.json` become
an evaluation set. `eval_corrections.py` was deliberately built to survive
reprocessing (it maps rallies by time overlap, not stored index), so they stay
valid for scoring — with one limit worth stating: contact capture and play-type
scoring are time-anchored and survive; **attribution scoring is cluster-id
anchored and does not**, unless identities are re-named on a reprocessed run.

---

## Camera change (2026-08-07) — the six games are a new geometry

Same venue, **higher camera capturing more of the court**, different roster.
This is a bigger deal than a roster change and cuts both ways.

### The good news, and it is real

`pipeline/M2-STATUS.md` listed the fixes for the far-court identity problem
"in order of leverage: (1) camera placement guidance (mid-court, higher)".
That is what just happened. The 0.57 embedding AUC was measured on corner-camera
footage where far-side players were ~80px — a higher, fuller view means larger,
less foreshortened, less occluded far-court crops.

So the identity wall may be partly a *camera* artifact rather than a hard limit
of appearance. **Re-measure embedding AUC on the first new game before assuming
Phase 2 or 3 is needed at all.** It is one number and it could reprice the whole
plan.

Phase 3 gains too: a more overhead view is far better conditioned for the
homography to court coordinates, since corner cameras have poor depth
resolution. Court position becomes a more reliable signal.

### The bad news: most pixel-space constants are now unvalidated

Every threshold tuned in pixels encodes the old camera's scale and perspective.
None of these are known-good on the new angle:

| Constant | Where | Why it moves |
|---|---|---|
| `court_poly`, `net_line` | `config.py` | **Hard blocker** — geometry is per-camera |
| `gate=220`, `drop=340` | `plays.attribute` | tuned on cca-one's geometry |
| y-weight `0.6` | `plays.attribute` | corrects perspective compression, which just changed |
| `dv_thr=260` px/s | `plays.find_contacts` | px/s depends on px-per-metre |
| `wrist_max=180` px | `pose_attrib` | same |
| `min_box_h_px=45` | `config.py` | player apparent size changed |
| `w/h > 70` filter, `max_speed=900` | `ball.py` | same |
| `bw = 26 if y < H*0.6 else 40` | `balltrain.build_dataset` | depth→box-size map is camera-specific |

**And the trained ball detector is the biggest single risk.** It was fine-tuned
on the old camera angle and is the one model in the system carrying learned
geometry. It may transfer fine — a ball is a ball — or it may degrade. Mitigation
already exists: `balltrain.py` bootstraps labels from physics-verified CV arcs,
so it can be re-bootstrapped on new footage without hand labelling.

### Consequence for the freeze: pilot ONE game first

The 1.0.0 freeze was declared before this was known. That is fine — **no labels
exist yet**, so re-tuning now is free, whereas re-tuning after the review pass
is exactly what breaks a clean slate.

Revised order:

1. Calibrate the new angle in the app's Camera setup page → `court_config.json`.
   Check whether **one** calibration covers all six, or whether the tripod moved
   between games (compare one frame per game).
2. Process **one** game with `--court`, `--pose-model` and `--overlay`. Not six.
   (Pose is needed on the pilot or `wrist_max` cannot be repriced.)
3. Inspect the model view, then run `pipeline/camera_check.py` to re-measure
   every constant in the table above:

       python camera_check.py NEW/game.json --ref ../game.json

   Stdlib only — no numpy, no GPU — so it runs on the review machine. Reports
   the scale factor from median player height, rescaled starting values for
   each px constant, and a static-contamination check on the ball track.
   Re-tune from those distributions, not from guesses.
4. Bump to **1.1.0**, rebuild the bundle, then process the remaining five.
5. Only then review.

### Consequence for the legacy evaluation set

Weaker than previously planned. `corrections_cca_one/two.json` describe a
different camera *and* a different roster, so they are no longer a fair
benchmark for anything camera-dependent — which is most of it. Demote again:

- **Still useful:** as a regression check that a change doesn't break the old
  geometry, if old footage is ever reprocessed.
- **No longer useful:** as the primary benchmark, and useless for re-ID
  evaluation (disjoint roster).
- **The real benchmark** is the two held-out games from the new six.

---

## Data inventory — the legacy set (evaluation only)

Measured from `corrections_cca_one.json` + `corrections_cca_two.json`:

| Asset | cca-one | cca-two | Usable for |
|---|---|---|---|
| Kept touches (`plays`) | 298 | 279 | contact positives, typing labels |
| ...with `x,y,tracklet_id` | 163 | 80 | **contact classifier positives** |
| ...human-ADDED (no position) | 135 | 199 | recall labels only |
| Deleted phantoms (`removed_plays`) | 289 | 211 | — |
| ...with `x,y` | **279** | **192** | **contact classifier negatives** |
| Named identities | 12 | 14 | re-ID fine-tune classes |
| Crops referenced by tracklets | 7,706 | 5,772 | re-ID fine-tune samples |

Two things this changes versus the earlier read:

1. **`x,y` is not broadly missing.** Every pipeline-originated play keeps its
   position through a PATCH. It is null *only* on human-ADDED touches, because
   `addPlay()` posts `{rally_id, t}` and nothing else.
2. **`removed_plays` is a gift.** 471 deleted phantoms across the two games,
   nearly all carrying full position — a perfectly labeled false-positive set,
   already on disk, needing zero new instrumentation.

Under the clean-slate decision this set trains nothing. It is retained as the
evaluation benchmark, which is worth having from day one rather than flying
blind until the new games are reviewed.

Note the ratio: removed ≈ kept. Those runs predate the wristless filter, and
roughly half of all detections were phantoms. That is the problem being fixed —
and the reason those negatives don't describe the current pipeline.

---

## Recommended order

| Phase | What | Blocked by | Effort | Ceiling |
|---|---|---|---|---|
| **0.0** | Freeze + stamp the pipeline | nothing | S | prerequisite |
| **0.1–0.4** | Label infrastructure | 0.0 | S–M | enables everything |
| — | *Process + review the 6 games* | 0.0–0.2 | — | supplies all data |
| **1** | Learned contact detector | the above | M | high, likely |
| **3** | Spatial-temporal identity | the above | M–L | high, independent of re-ID |
| **2** | Re-ID fine-tune | the above | M | highest, least certain |
| **4** | Play typing | 1, 2/3 | S | low |

### The sequencing trap

**The review-UI changes (0.1) must land before the review pass, not after.**
Reviewing six games is many hours of work. Doing it with the current UI yields
cluster-level attributions — the label type that demonstrably does not
propagate — and getting tracklet-level labels would then mean reviewing all six
again. The order that avoids this:

1. Freeze + stamp (**0.0**) — must precede processing, or the six games are
   unstamped and the clean slate has no boundary.
2. Start processing the six games (long, unattended, GPU).
3. **While they process**, land 0.1–0.3 app-side. This is free time — use it.
4. Review all six once, with the improved UI, producing durable labels.
5. Train.

Do **not** start Phase 4 until 1 and one of 2/3 have landed. Typing accuracy is
bounded by contact and attribution quality upstream; tuning it now measures
noise.

### Hold out test games before looking at anything

Roster structure of the six (three teams total):

| Games | Teams |
|---|---|
| 1, 2 | **A** vs B |
| 3, 4, 5, 6 | B vs **C** |

Team B is in all six; A appears only in 1–2; C only in 3–6.

**Split: train on games 3–6, test on games 1–2.** Decided now, before any
results are seen. Reasons:

- 4 train / 2 test is the right ratio, and it puts a *completely unseen roster*
  (Team A) in the test set.
- It mirrors deployment exactly — the recurring team is known from previous
  nights, the opponent is new — so the test measures the thing that actually
  happens.
- It yields **two** re-ID numbers from one split, which is more informative
  than one blended figure: performance on **Team A (never seen)** is the honest
  generalisation number, and on **Team B (seen in training)** the closed-set
  number. Report them separately.

Split by whole game, never by random rally or crop — crops from one tracklet
are near-duplicates and a random split will report a badly inflated score.

Two honest limits:

- **No fully disjoint split exists**, because Team B is in every game. Unseen-
  identity performance can only be measured on Team A: one team, two games.
  Small sample; treat it as directional.
- **Games 3–6 may be highly correlated.** If they are consecutive matches on
  one day, that is four games of the same ~12 people in the same kit — far less
  diversity than "four games" implies, and Phase 2's effective sample is
  smaller than the game count suggests.

**Bonus that Team B unlocks:** the same people across all six games make
*cross-game* identity matching measurable for the first time. Earlier this plan
assumed cross-game re-ID would be worse than within-game (clothing changes).
With Team B recurring six times that stops being speculation — measure it. If
it holds up, auto-naming returning players is a real product feature, not just
an accuracy metric.

---

## Phase 0 — label infrastructure

The corrections export was built to *score* the pipeline. This turns it into a
system that *trains* the pipeline. Nothing here improves a number directly; it
is what makes Phases 2 and 3 possible at all, and what makes every future
reviewed game compound.

### 0.0 Freeze and stamp the pipeline — **DONE 2026-08-07**

Nothing in `game.json` recorded which pipeline produced it: top-level keys were
`video, rallies, tracklets, clusters, ball`. `__version__` existed in
`vbpipe/__init__.py` and was written nowhere. "Old game" versus "new game" was
not a distinguishable category, so the clean-slate policy had nothing to key on.

Shipped:

- `vbpipe/__init__.py`, `pyproject.toml` — version **1.0.0**, declared as the
  frozen training baseline. Bump MINOR whenever a change alters model output so
  label generations stay separable.
- `vbpipe/cli.py` — `_stamp()` writes `game["pipeline"]` per stage
  (rally / full / plays): version, UTC timestamp, the full resolved `Config`,
  and the stage's CLI params. `_rule_defaults()` captures thresholds that live
  as *function defaults* rather than Config fields — `find_contacts`'
  `cos_thr`/`dv_thr`/`vel_win`, `attribute`'s `gate`/`drop`, `classify`'s
  `serve_gate` — which were previously invisible in any output.
- Stamped per stage, because rally/full/plays run independently and are often
  re-run apart; one `game.json` can legitimately carry three pipeline states
  and that must be visible.
- `app/lib/db.js` — migration `games.pipeline TEXT`.
- `app/lib/import.js` — stores `g.pipeline` verbatim on import.
- `app/lib/export.js` — corrections files now carry a `pipeline` field.
  **Null means pre-1.0.0, i.e. evaluation-only.**

Net effect: every corrections file from here on declares its own generation, so
pooling across generations becomes a visible mistake rather than a silent one.

### 0.1 Capture `tracklet_id` on corrected attributions — **SHIPPED 2026-08-07**

Implemented as the click-the-player overlay, live-tested against game 13 (its
same-run game.json recovered from `game_bundle_game2.zip` via
`backfill-gamejson`; 100% of positioned touches matched, full src_id→DB join):

- `GET /api/tracklets?game_id=N` serves per-frame boxes from the retained
  game.json, joined to DB tracklet ids + current identity names
  (`lib/gamejson.js` caches the parse). 404 when no game.json → the UI
  degrades to exactly the old typeahead.
- Review UI: while the picker is open (**P** — the only way it opens; it never
  auto-opens, and it closes when focus moves), tracked player boxes render
  over the paused frame; clicking one writes
  `cluster_id` + `tracklet_id`, and — only when the play has no position
  (hand-added) — the click point as `x/y` in the 1280x720 ref space.
  Machine-detected ball positions are never overwritten.
- Typeahead path backfills `tracklet_id` server-side using the pipeline's own
  attribution geometry (upper-torso anchor, 0.6 y-weight, 220px gate) —
  verified to reproduce the pipeline's original tracklet choice. A containment
  test does NOT work (ball at contact is typically >100px above the box).

### 0.3 Auto-export — **SHIPPED 2026-08-07**: when every rally is scored, an
8s-idle debounced `GET /api/export/<id>?dest=auto` ships the corrections file
(Drive when OAuth configured, else app folder; both upsert). Manual
ExportButton now on the review page. `npm run export` rewired to
`buildCorrections` (the old script had drifted: wrong filename contract,
missing pipeline stamp).

### 0.4 Per-rally completeness — **SHIPPED 2026-08-07**:
`rallies.touches_complete` (migration), `C` key / chip / timeline stripe in
review, exported per rally + `review_stats.complete_rallies`. Reviewer
discipline during the six-game pass: mark it on every rally whose touch list
you've verified complete — that's what makes negatives derivable.

### 0.1 (original spec, for reference)

Today, when a reviewer fixes who made a touch, they pick a name and we store a
`cluster_id`. That is a *cluster → player* label, which is the thing we already
have and the thing that demonstrably does not propagate (a cluster is only as
good as its membership).

What we need is a **tracklet → player** label: "this specific tracked body, in
this rally, is Mike." That is the direct supervision for both the identity
failure and the re-ID fine-tune, and the reviewer is already making exactly
that judgment — we just discard the precise half of it.

**Change:** in the review UI, when attributing a touch, render the tracked
player boxes at that timestamp over the frame and let the reviewer click the
person. Store the clicked `tracklet_id` alongside `cluster_id`.

- `app/app/api/plays/route.js` — add `x`, `y`, `tracklet_id` to the PATCH
  `allowed` list; accept them on POST.
- `app/app/games/[id]/review/ui.js` — box overlay at the current frame +
  click-to-attribute; `addPlay()` posts the clicked position and tracklet.
- `app/lib/export.js` — already selects these columns, no change needed.

**Fallback if the overlay is too much work initially:** derive `tracklet_id`
server-side as the tracklet whose box is nearest the touch position at time
`t`. Weaker (it re-uses the geometry that's already the weak link) but free,
and it backfills the 108 + 55 cca-one touches that have positions today.

**Secondary benefit:** the 334 human-added touches gain positions, which
converts them from recall-only labels into full contact-classifier positives —
and they are the *most* valuable positives, because they are precisely the
touches the current detector misses.

### 0.2 Retain crops as a first-class pipeline output

Re-ID fine-tuning needs the crop images. Of ~13,500 referenced across the two
games, **3,801 survive** in `pipeline/game_results.zip`; the rest are gone with
their Colab sessions.

- `vbpipe` already writes `{out_dir}/crops/`. Make the bundle script always
  include it, and make crop retention explicit in `make_bundle.ps1/.sh`.
- Archive per game to Drive alongside `game.json`, keyed by `source_file`.
- Cost check: 7,706 crops at ~92 JPEG quality is small — measure once, but
  this is very likely a non-issue.

### 0.3 Automate correction export per reviewed game

Corrections currently reach disk by hand. Two games of labels is the reason
every option below carries "uncertain, small sample."

- Add an export-on-review-complete hook (or a nightly job) writing
  `corrections_<source_file_stem>.json` to Drive.
- Keep the existing naming contract in `app/lib/export.js` — the stem must
  match, since `eval_corrections.py` pairs files by it.
- Target: **20 games banked** before judging Phase 2's ceiling.

### 0.4 Build a blind recall set

Corrections are made *on top of* predictions, so they inherit the model's blind
spots: reviewers reliably fix a wrong touch shown to them, and much less
reliably add one that was never detected. Labels are therefore systematically
stronger on precision than recall, and any model trained on them will inherit
that skew.

`pipeline/ground_truth.json` is the right antidote — sequences labeled from
scratch by watching clips, blind to model output — but it holds **2 rallies**.

Under the completeness discipline this stops being a separate artifact: a rally
labelled *completely* is already blind-recall data, because it asserts the full
truth rather than editing the model's guess.

- Review flow must make completeness explicit — a per-rally "touch list is
  complete" confirmation, so an unreviewed rally is distinguishable from one
  the reviewer verified as having no further touches. Without that flag,
  "no touch labelled here" is ambiguous and every derived negative is suspect.
- Mark completeness per rally, not per game; a partially reviewed game is still
  useful for the rallies that are done.
- Recall is reported only over complete rallies. This is the guard that stops
  Phase 1 from optimizing precision into the ground.

**Exit criteria for Phase 0:** a reviewed game produces, automatically, a
corrections file containing tracklet-level attributions plus a retained crop
archive; 10+ blind-labeled rallies exist.

---

## Phase 1 — learned contact detector

**Replaces:** the three hand-tuned thresholds in `plays.find_contacts`
(`cos_thr=0.55`, `dv_thr=260`, `vy_flip`).

**Why first:** best payoff-per-effort. It attacks touch-count inflation, which
is the #1 review pain, and the training data already exists in usable form.

**Why a model beats more threshold tuning:** the cosine test is structurally
guaranteed to misfire at a ballistic apex — a near-vertical ball reverses
direction with no player involved, and `cos ≈ -1` is the strongest signal the
test can emit. Any single threshold that suppresses that also suppresses real
touches (confirmed: the blanket trajectory / split-gain filters cost too much
recall). A classifier resolves it with a *combination* of features that no
single rule expresses.

### Data — from the six new games, derived not collected

- **Positives:** every touch in a rally's complete true-touch list, aligned to
  the nearest ball-trajectory sample by the greedy time matching
  `eval_corrections.match` already uses (`MATCH_S = 0.5`).
- **Negatives:** every ball-trajectory sample **not** near a true touch. This is
  *computed*, not labelled — which is the whole point of the discipline change.
  It regenerates for free against any future candidate generator, so Phase 1
  changing `find_contacts` does not invalidate its own training set.
- Requires rallies labelled **completely** (every real touch present), which is
  the same requirement as the blind recall set — hence 0.4 collapsing into the
  normal review flow.
- The legacy 243/471 set is **not** used here. See the clean-slate decision.

### Features (per ball-trajectory sample)

| Feature | Why |
|---|---|
| speed before / after | current `dv_thr` signal |
| angle change `cos(v1,v2)` | current `cos_thr` signal |
| **residual vs. fitted parabola** | **kills the apex phantom by learning** |
| ball height `y` | apexes are high; touches are not |
| distance to nearest player box | current `attribute` gate signal |
| distance to nearest wrist | current `wrist_max` signal, as a feature not a gate |
| time since previous accepted contact | current `min_gap` signal |
| local detection density / confidence | proxy for track quality |

The parabola residual is the key addition and the machinery exists — `ballcv`
already does parabolic physics verification for the CV ball tracker.

Every current hand-tuned threshold becomes a *feature* rather than a gate, so
the model can trade them off contextually instead of applying all of them
unconditionally.

### Model

Gradient-boosted trees (`xgboost` / `lightgbm` / sklearn's `HistGradientBoosting`).
Hundreds of positives with a dozen features is squarely in range; a neural net
is not warranted and would overfit this sample.

Emit a **probability**, not a binary. That gives one dial to trade precision
for recall at review time — replacing `--wrist-max` with something the reviewer
can actually reason about, and honouring the stated preference (a missing touch
is a one-click add; a phantom-inflated rally is a wipe).

### Files

- New `pipeline/vbpipe/contact_model.py` — featurization + inference.
- New `pipeline/notebooks/train_contacts.ipynb` — training + evaluation.
- `plays.find_contacts` — keep as candidate *generator* (loosen thresholds so it
  over-produces), then score candidates with the model. Keeps the rules as a
  fallback path when no model is supplied, mirroring how `--ball-model` falls
  back to `ballcv`.

### Success metric

Score with `eval_corrections.py`. Target: **contact precision ≥ 80% at recall
≥ 70%** on a held-out game, with inflation ≤ 1.0x. Current best is P 66% /
R 64% (cca-one, wristless filter at 180px).

Report recall separately on the 0.4 blind set. Precision from corrections is
trustworthy; recall from corrections is not.

### Kill criterion

If a held-out game does not beat the wristless filter's P/R, keep the rules and
move on. Do not iterate more than twice.

---

## Phase 2 — re-ID fine-tune

**Target:** the identity wall. Base OSNet embeddings score AUC 0.57–0.61 where
clustering needs ~0.85, and 96% of attribution failures are "a tracked body is
at the ball but carries the wrong cluster label."

**Why this is a different lever than the hi-res crop probe:** that experiment
tested *is the information present* (more pixels: 0.57 → 0.61, a real but tiny
bump). This tests *is the model looking at the right things*. Base OSNet was
trained on street surveillance — Market-1501 / DukeMTMC — where the
discriminating cues are clothing colour across very different camera angles.
Our problem is one fixed camera, one gym, one lighting condition, twelve
people in gym clothes. A fine-tune learns what separates *these* humans (shoes,
hair, kneepads, gait) which a generic model averages away. One lever failing
does not predict the other.

### Data

- From the six new games. The legacy games referenced ~13,500 crops between
  them, so six should land in the tens of thousands — **crop retention is a
  hard prerequisite** (Phase 0.2), and it is the one thing that cannot be
  recovered after the fact.
- **Three teams across the six** (A in games 1–2, C in 3–6, B in all six), and
  a roster disjoint from the legacy games. Team B is the strongest class by far
  — six games of the same people — and Teams A and C are half that at best.
  Expect the per-class sample to be very uneven, and weight or cap accordingly
  so Team B doesn't dominate the loss.
- **Free positive pairs to preserve:** cca-two named
  `red shirt black shorts` and `White Hat Black Shorts` on *two distinct
  clusters each* — the reviewer stating "these two groups are one person"
  without merging them. That is exactly what metric learning consumes, so the
  review UI should keep capturing it rather than forcing a merge.
- Once 0.1 lands, tracklet→player labels give clean per-crop identity labels
  rather than cluster-level ones. This is the main reason 0.1 must precede the
  review pass.

### Approach

- Metric learning (triplet / circle loss) on the pretrained OSNet backbone;
  do not train from scratch.
- **Hold out an entire game**, not random crops. Random splits leak — crops from
  the same tracklet are near-duplicates and will report a fake AUC.
- Sample hard negatives deliberately: far-court crops of *different* players,
  which is where the current model fails.
- Evaluate on embedding AUC first (cheap), and only then re-run clustering and
  score attribution end-to-end.

### Files

- New `pipeline/notebooks/train_reid.ipynb`.
- `vbpipe/config.py` — `reid_model` accepts a checkpoint path.
- `vbpipe/identity.py` — `embed_tracklets` loads a fine-tuned checkpoint.

### Success metric

Embedding AUC on the held-out game. **≥ 0.75 = promising, continue. ≥ 0.85 =
the wall is broken.** Below 0.70, stop — appearance is confirmed dead and
Phase 3 is the whole answer.

### Risks

- 12–14 identities is a small re-ID training set. Two games may simply not be
  enough; this is the strongest argument for doing 0.3 first and revisiting at
  20 games.
- Clothing changes between game nights degrade appearance matching. Within a
  night is this method's best case — and its best case is currently 0.57.

---

## Phase 3 — spatial-temporal identity

**The route that sidesteps the wall entirely.** Uses court position, team side,
and within-rally track continuity — *not* appearance — so it is not capped by
the 0.57 embedding.

**The structural prior worth exploiting: volleyball rotation is fixed.**
Players rotate through six positions in a known cyclic order, and serve order
is fixed. Given a roster and one anchor per rotation, court position becomes
enormously informative about identity in a way appearance never will be for
look-alike players.

### Data

Already on disk: every corrected touch gives `(time → player)`, and tracklets
give `(time → court position)`. The rotation can be learned and validated from
existing corrections. Phase 0.1 makes this much stronger by supplying
`(tracklet → player)` directly.

### Approach

1. **Measure first.** From corrections, check whether serve order is consistent
   within a game and whether position-at-serve predicts identity. If rotation
   is not actually observed in this rec league (substitutions, casual play),
   the whole premise collapses — establish this before building anything.
2. Homography from `court_corners` (already captured by the calibration page,
   currently unused) to map image coordinates to court coordinates.
3. Model identity as assignment over a rally: each tracklet gets a court
   position track; solve the tracklet→roster assignment jointly per rally using
   position + side + continuity + the previous rally's assignment, with the
   existing temporal cannot-link constraint retained.
4. Appearance becomes one weak term in the cost, not the whole cost.

### Files

- New `pipeline/vbpipe/spatial_identity.py`.
- `vbpipe/config.py` — `court_corners` finally consumed.
- `vbpipe/identity.py` — clustering becomes one input to assignment rather than
  the sole authority.

### Success metric

Attribution accuracy against corrections. Current body-center attribution is
36% (cca-one) / 30% (cca-two) with an oracle-geometry ceiling of 86%.
**Target ≥ 60%**, i.e. meaningfully into the gap between the two.

### Risk

Rec-league play may not rotate reliably. Step 1 is explicitly a go/no-go, and
it costs a notebook afternoon.

---

## Phase 4 — play typing

**Lowest priority.** Do not start before Phase 1 and one of 2/3 have landed.

The rule-based state machine in `plays.classify` was last measured at 39% exact
on game2 — but that was at contact quality P51/R57. Typing errors are largely
*inherited*: a phantom touch shifts every subsequent label in the possession,
and a wrong side flips possession boundaries. Improving the typer while
contacts are noisy measures noise.

### When contacts are clean

1. **Re-run the sweep first.** `pipeline/typer_sweep.py` already exists, and the
   `resync_at` / `max_touch_gap` anchors were disabled specifically because they
   fired on noise. On clean contacts they may now help. This is nearly free and
   must be tried before any modelling.
2. Only if the sweep plateaus: a small sequence model over
   `(side, time gap, court position, distance to net, height, touch index)`.
   577 labeled sequences supports something modest — a per-touch classifier
   with sequence features, not an RNN.

### Success metric

Exact play-type accuracy on held-out corrections, and the joint-parse headline
in `eval_corrections.py` (contact captured AND family correct AND right
player) — the "ML does ≥75%, reviewer fixes the rest" number.

---

## What success looks like overall

The headline is the **joint parse** metric already implemented in
`eval_corrections.py`. Every phase should be scored against it on a held-out
game, not on the game it was tuned on.

Rough contribution model, to be replaced with measurements:

- Phase 1 lifts contact precision, which lifts joint parse directly and removes
  the inflation that forces rally wipes.
- Phase 2 or 3 lifts attribution from ~33% toward the 86% geometric ceiling.
- Phase 4 converts those gains into correct labels rather than correct
  detections.

And the compounding property, which matters more than any single phase: after
Phase 0, **every reviewed game makes the next one better**. That is the loop
worth building.
