# vbpipe — volleyball game video pipeline (M2)

Turns a static-tripod game video into structured data: rally segments, player
tracklets, and appearance-based identities — the input for the review UI and
stats engine. Approach validated in `../m1-spike/REPORT.md`.

## Stages
1. **rally** — motion+audio rally segmentation. CPU, ~20x realtime.
2. **full** — adds YOLO11 + ByteTrack person tracking per rally, OSNet re-ID
   embeddings, temporally-constrained identity clustering. Needs a GPU.

## Output (`game.json`)
- `rallies`: [{start, end, contacts_per_10s}]
- `tracklets`: [{id, rally, t0, t1, boxes: [[t,x,y,w,h]], crops, cluster}]
- `clusters`: [{id, n_boxes, rep_crops}] — one per detected identity;
  `rep_crops` are the frames the organizer confirms names against.

## Run (Colab — free T4)
Open `notebooks/colab_run.ipynb`, Runtime -> T4 GPU, Run all.
It installs deps, takes the pipeline zip + a video from Google Drive,
runs `vbpipe full`, and zips results for download.

## Run (local, CPU rally-only)
    pip install -e .
    vbpipe rally game.mp4 -o out/

## Per-venue config
`vbpipe/config.py` — court polygon is normalized coords for the M1 gym camera
corner. New venue/camera position -> update `court_poly` (6 clicks on a frame).

## Next (M2 remainder)
- Evaluate cluster purity on full game vs. M1 crops; tune `cluster_thresh`
- Ball tracking + contact detection -> play classification prototype (M2 gate #2)
- Rally clip cutting (ffmpeg) for the publishing flow
