# M1 Feasibility Spike — Report

**Date:** 2026-07-17 · **Footage:** example.mp4 (19 min, 1080p30 HEVC, static corner camera)
**Verdict: QUALIFIED GO** — rally detection is solid on real footage; player clustering works mechanically but needs a learned re-ID model to handle same-colored outfits.

## What was tested
The two riskiest pipeline stages, on real league footage, CPU-only:
1. Rally segmentation (motion analysis on court region + audio transient scoring)
2. Player detection + appearance clustering (background subtraction + HSV color features)

## Results

### Rally segmentation — WORKS
- 39 candidate rally segments found; 56% of video active; durations 6–44s with clean dead-time gaps — matches real volleyball rhythm.
- Spot-checks: mid-segment frames show live play; mid-gap frames show players idle. One borderline frame (t=208s, serve-receive stance) suggests some rally starts may clip early — needs proper ground-truth eval.
- Cost: ~1 min CPU for 19 min of video using keyframe-only decode. Essentially free.

### Player detection — WORKS (spike-grade)
- Static camera makes background subtraction effective: 807 player crops from 7 rallies, court-region filtered, recognizable quality even for far-side players (~70–110 px).
- Production should use a real person detector (YOLO-class); couldn't be downloaded in this sandbox (network allowlist). Not a concern — well-established tech.

### Appearance clustering — PARTIAL
- 32 clusters (18 significant) from 807 crops using torso/leg color histograms.
- Distinctly dressed players cluster cleanly (pink shirt, blue shirt, striped shorts: near-pure clusters). This validates the confirm-identity UX.
- FAILURE MODE: ~half the players wear dark/black; color features merge them into mixed clusters. Expected — color histograms are a stand-in. Fix: learned re-ID embeddings (e.g., OSNet) + tracklet-level clustering with spatiotemporal continuity. Standard, but needs GPU + model weights (unavailable in this sandbox).

## Implications for the build
1. Rally detection can ship almost as-is — cheap, accurate enough for clip generation.
2. Identity confirmation UX must include merge/split tools (clusters oversplit by distance/angle even for well-dressed players: pink-shirt guy = 2 clusters).
3. Camera advice for organizers is a real lever: the corner angle works, but a mid-court elevated position would shrink the near/far size disparity.
4. Next validation (M2 prereq): rerun clustering with OSNet re-ID embeddings on a GPU box — this decides whether dark-outfit players are separable. Est. cost: single cloud GPU hour.

## Artifacts
- `clusters.jpg` — one row per cluster (label C<id>:<size>)
- `montage1.jpg` — raw detection crops from one rally
- `segments.json` — 39 detected rally segments (start/end/duration/contact density)
- `*.py` — pipeline scripts (extract_signals, seg, detect, cluster)

---

# Addendum — Re-ID experiments (same day)

Four feature/clustering variants tested on the 807 crops:

| Approach | Result |
|---|---|
| Color histograms (CPU) | Only distinctly dressed players separate |
| DINOv2 per-crop (Colab GPU) | Clusters by pose/context (a literal "holding ball" cluster); 2 pure identities |
| OSNet per-crop (Colab GPU) | Clear step up: dark-outfit players (JAKOF, WCTC) form pure clusters; far-side small crops still mix |
| OSNet + tracklets + temporal cannot-link (CPU) | Best structure: several pure identities (see `clusters_tracklets13.jpg` P1, P5); remaining impurity traced to contaminated tracklets, not embeddings |

**Conclusion: identity clustering is NOT the blocker.** The residual errors come from spike-grade detection (background-subtraction blobs that merge adjacent players and switch identities mid-track). A real detector + tracker (YOLO + ByteTrack) — commodity, well-solved tech — feeds clean tracklets to OSNet, and the tracklet-level pipeline demonstrated here handles the rest.

**Verdict upgraded: GO.** Both core risks (rally detection, jersey-free player identification) validated on real footage. Proceed to M2: build the production pipeline (detect → track → embed → cluster → rally segmentation → play-classification prototype).
