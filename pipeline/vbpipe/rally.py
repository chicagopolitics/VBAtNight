"""Rally segmentation from motion (keyframe decode) + audio transients.
CPU-only, ~20x realtime. Validated in M1 spike."""
import subprocess, numpy as np

W, H = 480, 270

def _poly_mask(poly, w, h):
    import cv2
    m = np.zeros((h, w), np.uint8)
    pts = np.array([[int(x*w), int(y*h)] for x, y in poly], np.int32)
    cv2.fillPoly(m, [pts], 255)
    return m > 0

def motion_signal(video, court_poly, start=0.0, dur=None):
    """1 Hz motion signal from keyframe-only decode (fast on CPU)."""
    cmd = ["ffmpeg", "-v", "error", "-skip_frame", "nokey", "-ss", str(start)]
    if dur: cmd += ["-t", str(dur)]
    cmd += ["-i", video, "-vsync", "0",
            "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=W*H*4)
    mask = _poly_mask(court_poly, W, H)
    prev, vals = None, []
    while True:
        buf = p.stdout.read(W*H)
        if len(buf) < W*H: break
        f = np.frombuffer(buf, np.uint8).reshape(H, W).astype(np.int16)
        if prev is not None:
            d = np.abs(f - prev)[mask]
            vals.append(float((d > 14).mean()))
        prev = f
    p.wait()
    return np.array(vals, np.float32)   # ~1 sample/sec

def audio_signal(video, sr=16000):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-ac", "1",
                          "-ar", str(sr), "-f", "f32le", "-"],
                         capture_output=True).stdout
    x = np.frombuffer(raw, np.float32)
    win = sr // 4
    n = len(x) // win
    seg = x[:n*win].reshape(n, win)
    return np.abs(seg).max(1)           # 4 Hz peak amplitude

def segment(motion, audio_peak, cfg):
    """Return [{start, end, contacts_per_10s}] rally segments."""
    ms = np.convolve(motion, np.ones(3)/3, mode="same")
    lo, hi = np.percentile(ms, 20), np.percentile(ms, 90)
    active = ms > lo + cfg.motion_thresh_frac * (hi - lo)
    segs, start, merged = [], None, []
    for i, v in enumerate(active):
        if v and start is None: start = i
        elif not v and start is not None: segs.append([start, i]); start = None
    if start is not None: segs.append([start, len(active)])
    for s in segs:
        if merged and s[0] - merged[-1][1] < cfg.max_gap_s: merged[-1][1] = s[1]
        else: merged.append(list(s))
    merged = [s for s in merged if s[1] - s[0] >= cfg.min_rally_s]
    pk_thr = np.percentile(audio_peak, 92)
    out = []
    for s0, s1 in merged:
        t = int((audio_peak[s0*4:s1*4] > pk_thr).sum())
        out.append({"start": float(s0), "end": float(s1),
                    "contacts_per_10s": round(t/(s1-s0)*10, 1)})
    return out
