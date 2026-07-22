"""Diagnose rally segmentation on a recording.

Usage:
  python -m vbpipe.rally_debug VIDEO [--court court.json] [--start S] [--dur S] [-o diag]

Reports:
  - actual keyframe interval (rally.py assumes ~1/sec; timings break otherwise)
  - motion-signal stats (p20/p90 spread, threshold, % active)
  - segment counts across a sweep of motion_thresh_frac / min_rally_s / max_gap_s
  - diag/rally_diag.png: motion signal + threshold + detected segments + audio
"""
import argparse, json, subprocess
import numpy as np

from . import rally as R
from .config import Config


def keyframe_times(video, limit_s=None):
    """Keyframe pts from packet flags (no decode, fast)."""
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0",
           "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0"]
    if limit_s:
        cmd += ["-read_intervals", f"%+{limit_s}"]
    out = subprocess.run(cmd + [video], capture_output=True, text=True).stdout
    ts = []
    for line in out.splitlines():
        parts = line.split(",")
        if len(parts) >= 2 and "K" in parts[1]:
            try:
                ts.append(float(parts[0]))
            except ValueError:
                pass
    return np.array(ts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--court", help="court file from Camera setup page")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--dur", type=float, default=None)
    ap.add_argument("-o", "--out", default="diag")
    a = ap.parse_args()

    cfg = Config.from_court_file(a.court) if a.court else Config()

    # --- 1. keyframe interval sanity check -------------------------------
    kts = keyframe_times(a.video, limit_s=300)
    if len(kts) > 2:
        iv = np.diff(kts)
        med = float(np.median(iv))
        print(f"[keyframes] n={len(kts)} in first ~5min, median interval="
              f"{med:.2f}s (min {iv.min():.2f} / max {iv.max():.2f})")
        if not 0.5 <= med <= 1.5:
            print(f"  *** WARNING: rally.py assumes ~1 keyframe/sec. At "
                  f"{med:.2f}s, all times are scaled {med:.1f}x wrong, "
                  f"min_rally_s={cfg.min_rally_s} really filters rallies "
                  f"shorter than {cfg.min_rally_s * med:.0f}s, and gap "
                  f"merging spans {cfg.max_gap_s * med:.0f}s. ***")
    else:
        med = 1.0
        print("[keyframes] could not read packet flags; skipping check")

    # --- 2. signals -------------------------------------------------------
    print("[signals] extracting motion + audio...")
    motion = R.motion_signal(a.video, cfg.court_poly, start=a.start, dur=a.dur)
    audio = R.audio_signal(a.video)
    ms = np.convolve(motion, np.ones(3) / 3, mode="same")
    lo, hi = np.percentile(ms, 20), np.percentile(ms, 90)
    thr = lo + cfg.motion_thresh_frac * (hi - lo)
    active_frac = float((ms > thr).mean())
    print(f"[motion] n={len(motion)} samples, p20={lo:.4f} p90={hi:.4f} "
          f"spread={hi - lo:.4f} thr={thr:.4f} active={active_frac:.0%}")
    if hi - lo < 0.01:
        print("  *** WARNING: p20-p90 spread is tiny — adaptive threshold is "
              "meaningless on this recording (court poly wrong? camera far?) ***")

    # --- 3. current config result ----------------------------------------
    segs = R.segment(motion, audio, cfg)
    print(f"\n[current cfg] {len(segs)} rallies "
          f"(motion_thresh_frac={cfg.motion_thresh_frac}, "
          f"min_rally_s={cfg.min_rally_s}, max_gap_s={cfg.max_gap_s})")
    durs = [s["end"] - s["start"] for s in segs]
    if durs:
        print(f"  durations: median={np.median(durs):.0f}s "
              f"min={min(durs):.0f}s max={max(durs):.0f}s")

    # --- 4. parameter sweep -----------------------------------------------
    print("\n[sweep] rally counts (rows=thresh_frac, cols=min_rally_s), "
          f"max_gap_s={cfg.max_gap_s}:")
    fracs = [0.15, 0.20, 0.25, 0.30, 0.35, 0.45]
    mins = [2.0, 3.0, 4.0, 6.0]
    print("        " + "".join(f"min={m:<6}" for m in mins))
    from copy import copy
    for f in fracs:
        row = []
        for m in mins:
            c = copy(cfg); c.motion_thresh_frac = f; c.min_rally_s = m
            row.append(len(R.segment(motion, audio, c)))
        print(f"  f={f:.2f} " + "".join(f"{n:<10}" for n in row))
    print("\n[sweep] gap sensitivity (current frac/min):")
    for g in [1.0, 2.0, 3.0, 4.0, 6.0]:
        c = copy(cfg); c.max_gap_s = g
        print(f"  max_gap_s={g}: {len(R.segment(motion, audio, c))} rallies")

    # --- 5. plot -----------------------------------------------------------
    import os
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    os.makedirs(a.out, exist_ok=True)
    t = np.arange(len(ms)) * med + a.start
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(16, 7), sharex=True,
                                   height_ratios=[3, 1])
    ax1.plot(t, ms, lw=0.6, label="motion (smoothed)")
    ax1.axhline(thr, color="r", ls="--", lw=0.8,
                label=f"thr={thr:.3f} (frac={cfg.motion_thresh_frac})")
    ax1.axhline(lo, color="gray", ls=":", lw=0.6, label="p20")
    ax1.axhline(hi, color="gray", ls="-.", lw=0.6, label="p90")
    for s in segs:
        ax1.axvspan(s["start"] * med + a.start, s["end"] * med + a.start,
                    color="g", alpha=0.2)
    ax1.set_ylabel("court motion frac")
    ax1.legend(loc="upper right", fontsize=8)
    ax1.set_title(f"{len(segs)} rallies detected — green = detected segment")
    ta = np.arange(len(audio)) / 4.0
    ax2.plot(ta, audio, lw=0.4, color="purple")
    ax2.axhline(np.percentile(audio, 92), color="r", ls="--", lw=0.8)
    ax2.set_ylabel("audio peak")
    ax2.set_xlabel("time (s)" + ("" if 0.5 <= med <= 1.5 else
                                 f"  [scaled by measured keyframe interval {med:.2f}s]"))
    fig.tight_layout()
    fp = os.path.join(a.out, "rally_diag.png")
    fig.savefig(fp, dpi=110)
    print(f"\n[plot] {fp}")

    with open(os.path.join(a.out, "rally_diag.json"), "w") as f:
        json.dump({"keyframe_interval_s": med, "p20": float(lo),
                   "p90": float(hi), "thr": float(thr),
                   "active_frac": active_frac, "n_rallies": len(segs),
                   "segments": segs}, f, indent=1)


if __name__ == "__main__":
    main()
