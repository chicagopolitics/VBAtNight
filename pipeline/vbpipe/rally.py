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

def _duration(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration", "-of", "csv=p=0", video],
                         capture_output=True, text=True).stdout.strip()
    try: return float(out)
    except ValueError: return None


_PASSTHROUGH = None

def _passthrough():
    """Flag telling ffmpeg NOT to resample output to a constant frame rate.

    Load-bearing for the keyframe path below: `-skip_frame nokey` piped to
    rawvideo under CFR would duplicate each keyframe back up to the source
    rate, so we would read far more samples than seconds and segment() — which
    reads sample indices as seconds — would place every rally wrong.

    The flag was renamed underneath us: `-vsync 0` through ffmpeg 4.x,
    `-fps_mode passthrough` from 5.0, and 9.0 dropped `-vsync` entirely (local
    Windows builds are already on 9.0; Colab's Ubuntu image is still on 4.4).
    Ask the binary which spelling it accepts instead of pinning a version.
    """
    global _PASSTHROUGH
    if _PASSTHROUGH is None:
        h = subprocess.run(["ffmpeg", "-hide_banner", "-h", "full"],
                           capture_output=True, text=True).stdout
        _PASSTHROUGH = (["-fps_mode", "passthrough"] if "-fps_mode" in h
                        else ["-vsync", "0"])
    return _PASSTHROUGH


def _keyframe_rate(video, window=180.0):
    """Keyframes per second, measured by demuxing (no decode) a short window.

    The fast motion path assumes ONE KEYFRAME PER SECOND. That is a property
    of the encoder, not of video in general — it happens to hold for the
    cameras used so far (measured: exactly 1.00/s on cca-one, and on games 13
    and 14). A camera that writes a longer GOP silently produces fewer
    samples than seconds, and since segment() reads sample INDICES AS
    SECONDS, every rally time then lands early and the tail of the match
    falls off the end of the signal entirely — the video looks like it simply
    stops having rallies partway through.
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_packets",
         "-read_intervals", f"%+{window}", "-show_entries", "packet=flags",
         "-of", "csv=p=0", video], capture_output=True, text=True).stdout
    kf = sum(1 for line in out.splitlines() if line.startswith("K"))
    return kf / window if kf else None


def motion_signal(video, court_poly, start=0.0, dur=None):
    """1 Hz motion signal over the court polygon.

    Keyframe-only decode when the source has ~1 keyframe/second (fast, ~20x
    realtime); otherwise a full decode resampled to exactly 1 fps, which is
    slower but is the only way to get a real 1 Hz signal out of a long-GOP
    file. Either way the contract is the same and segment() can keep treating
    one sample as one second.
    """
    kfr = _keyframe_rate(video)
    fast = kfr is not None and kfr >= 0.8
    if not fast:
        print(f"[rally] source has {kfr:.2f} keyframes/s" if kfr else
              "[rally] could not measure keyframe rate", end="")
        print(" — using full decode at 1 fps (slower, but the keyframe "
              "shortcut would misplace every rally on this file)")

    cmd = ["ffmpeg", "-v", "error"]
    if fast: cmd += ["-skip_frame", "nokey"]
    cmd += ["-ss", str(start)]
    if dur: cmd += ["-t", str(dur)]
    cmd += ["-i", video] + _passthrough() + [
            "-vf", f"scale={W}:{H},format=gray" if fast
                   else f"fps=1,scale={W}:{H},format=gray",
            "-f", "rawvideo", "-"]
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

    # Guard the contract rather than trusting it. One sample per second is
    # what makes segment()'s indices mean seconds; if the signal is much
    # shorter than the video, rally times are wrong and everything past the
    # end of the signal is invisible. Loud, because the failure is otherwise
    # indistinguishable from "the second half of the game was quiet".
    total = _duration(video)
    span = (dur if dur else (total - start if total else None))
    if span and span > 30:
        ratio = len(vals) / span
        if not 0.75 <= ratio <= 1.35:
            print(f"[rally] WARNING: motion signal is {len(vals)} samples for "
                  f"{span:.0f}s of video ({ratio:.2f} samples/s, expected ~1.0). "
                  f"Rally times will be wrong and roughly the last "
                  f"{max(0, span - len(vals)):.0f}s will yield no rallies at all.")
    return np.array(vals, np.float32)   # 1 sample/sec

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
