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

## Source video — when you re-encode, pin the keyframe interval

Rally segmentation samples motion once per second by decoding **keyframes
only**, so it depends on the source having roughly one keyframe per second.
Measured: Pixel footage is exactly 1.00 kf/s, which is why that workflow has
always worked.

The trap is **re-encoding**. x264 defaults to `keyint=250`, which at 59.94 fps
is a keyframe every 4.16s. Since `segment()` reads sample indices as seconds,
that compresses the whole timeline ~4x: rally times land at a quarter of their
true position, `min_rally_s` / `max_gap_s` behave like 16.7s so separate
rallies merge into blobs, and the back half of the match yields nothing at
all. It looks exactly like "the model stopped working partway through."

- **Remuxing / lossless cutting is safe** — a stream copy keeps the source
  GOP, so LosslessCut and `-c copy` change nothing.
- **A real re-encode is not** — needed for e.g. iPhone HLG/Dolby Vision HEVC,
  which has to be tone-mapped to SDR. Add `-g <fps> -keyint_min <fps>
  -sc_threshold 0` (60 for 59.94 fps, 30 for 29.97).

Since 2026-08 the pipeline measures the rate and falls back to a full decode
at `fps=1` when the shortcut doesn't apply, so a long-GOP file is processed
*correctly* either way — just slower. Pinning the interval is what keeps it on
the ~20x-realtime path.

Check any file in a second:

    ffprobe -v error -select_streams v:0 -show_packets -read_intervals "%+180" \
      -show_entries packet=flags -of csv=p=0 FILE.mp4 | grep -c '^K'

180 means 1.00 kf/s (good). ~43 means a 4.16s GOP (slow path).

## Next (M2 remainder)
- Evaluate cluster purity on full game vs. M1 crops; tune `cluster_thresh`
- Ball tracking + contact detection -> play classification prototype (M2 gate #2)
- Rally clip cutting (ffmpeg) for the publishing flow
