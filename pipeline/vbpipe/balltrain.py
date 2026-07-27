"""Bootstrap ball detector: auto-label frames from physics-verified CV arcs,
fine-tune YOLO, re-detect at 1080p. Run on GPU (Colab)."""
import json, os, subprocess, numpy as np

W, H = 1920, 1080
SC = 1.5   # ball_v3 points are in 1280x720 coords

def build_dataset(video, ball_json, out="dataset", neg_per_pos=0.3):
    """Extract frames at verified ball times; YOLO labels with ~16px boxes."""
    import cv2
    ball = json.load(open(ball_json))
    os.makedirs(f"{out}/images/train", exist_ok=True)
    os.makedirs(f"{out}/labels/train", exist_ok=True)
    items = []   # (t, x, y) in 1080p coords
    for ri, pts in ball.items():
        for p in pts:
            items.append((p[0], p[1]*SC, p[2]*SC))
    items.sort()
    # dedupe to ~2 per second to limit near-duplicate frames
    sel, last = [], -1
    for t, x, y in items:
        if t - last >= 0.45: sel.append((t, x, y)); last = t
    print(f"{len(items)} labeled points -> {len(sel)} training frames")
    n = 0
    for t, x, y in sel:
        fn = f"{out}/images/train/f{int(t*100):07d}.jpg"
        subprocess.run(["ffmpeg","-v","error","-ss",str(t),"-i",video,
                        "-frames:v","1","-q:v","3",fn,"-y"])
        if not os.path.exists(fn): continue
        bw = 26 if y < H*0.6 else 40   # box size by depth
        with open(fn.replace("/images/","/labels/").replace(".jpg",".txt"),"w") as f:
            f.write(f"0 {x/W:.5f} {y/H:.5f} {bw/W:.5f} {bw/H:.5f}\n")
        n += 1
    # negatives: frames at random non-ball times (empty label files)
    rng = np.random.default_rng(0)
    tmax = max(t for t,_,_ in items)
    for t in rng.uniform(0, tmax, int(n*neg_per_pos)):
        if any(abs(t-s[0]) < 0.5 for s in sel[::5]): continue
        fn = f"{out}/images/train/neg{int(t*100):07d}.jpg"
        subprocess.run(["ffmpeg","-v","error","-ss",str(t),"-i",video,
                        "-frames:v","1","-q:v","3",fn,"-y"])
        open(fn.replace("/images/","/labels/").replace(".jpg",".txt"),"w").close()
    with open(f"{out}/data.yaml","w") as f:
        f.write(f"path: {os.path.abspath(out)}\ntrain: images/train\n"
                f"val: images/train\nnames: {{0: ball}}\n")
    print(f"dataset ready: {n} positives")
    return f"{out}/data.yaml"

def train(data_yaml, epochs=60):
    from ultralytics import YOLO
    m = YOLO("yolo11n.pt")
    m.train(data=data_yaml, epochs=epochs, imgsz=1088, batch=8, patience=20,
            mosaic=0.3, scale=0.2, degrees=0, fliplr=0.5, plots=False)
    return m

def _pick_moving(raw, cell=40, static_frac=0.15, also_static=None):
    """From all per-frame ball detections [t,x,y,conf], drop STATIONARY
    clutter (a spare/dead ball on the sideline reads as a confident ball in a
    huge fraction of frames) and return the best MOVING detection per frame.

    A 40px cell that lights up in > static_frac of the rally's frames can't be
    the game ball (which passes through any cell only briefly) — suppress that
    cell and its 8-neighborhood (a blob spans cells). cca-two: a left-edge
    spare ball owned 91% of detections at conf 0.70 and starved the real ball
    (detect_all kept only the single highest-conf det/frame, so the game ball
    was discarded in every frame the spare was visible).

    static_frac lowered 0.25 -> 0.15 (2026-07-24): a ceiling light/wall sign
    recurred at ~15% of a rally's frames. `also_static` adds a GLOBAL
    cross-rally static set (see global_static_cells) — a gym has SEVERAL
    fixed round objects (lights, signs, scoreboard); each stays under the
    per-rally cutoff but recurs at the SAME cell across many rallies, which
    the ball never does. The cca-one pose smoke test showed ~41% of contacts
    were still static-FP garbage at ~(776,113)/(43,348) — the global map
    catches those."""
    if not raw:
        return []
    from collections import defaultdict
    frames = {round(t, 3) for t, *_ in raw}
    nfr = max(len(frames), 1)
    cellframes = defaultdict(set)
    for t, x, y, c in raw:
        cellframes[(int(x // cell), int(y // cell))].add(round(t, 3))
    static = {k for k, fs in cellframes.items() if len(fs) > static_frac * nfr}
    static |= set(also_static or ())
    def is_static(x, y):
        kx, ky = int(x // cell), int(y // cell)
        return any((kx + dx, ky + dy) in static
                   for dx in (-1, 0, 1) for dy in (-1, 0, 1))
    best = {}
    for t, x, y, c in raw:
        if is_static(x, y):
            continue
        tt = round(t, 3)
        if tt not in best or c > best[tt][3]:
            best[tt] = [tt, float(x), float(y), float(c)]
    return [best[t] for t in sorted(best)]


def global_static_cells(raw_by_rally, cell=40, min_rallies=3, min_frames=12,
                        max_std=2.5):
    """Cells that are a FIXED object (light/sign/scoreboard): sustained
    presence (>= min_frames) in >= min_rallies separate rallies, AND the
    pooled detections barely move (position std < max_std px in both axes).

    The variance gate is the key: a light sits at the EXACT same pixel
    (std ~0.7px measured on cca-two's wall sign), while the game ball passing
    through a busy centre-court cell scatters across it (std ~10-40px). Without
    it, dwelling-count alone flags the centre of the court, where the ball
    legitimately spends many frames every rally (that nuked recall to 4%).
    Returns a cell-key set to suppress everywhere."""
    import numpy as np
    from collections import defaultdict
    cellframes = defaultdict(lambda: defaultdict(list))   # cell -> rally -> [(x,y)]
    for ri, raw in enumerate(raw_by_rally):
        for t, x, y, c in (raw or []):
            cellframes[(int(x // cell), int(y // cell))][ri].append((x, y))
    out = set()
    for k, byr in cellframes.items():
        rallies_hit = [pts for pts in byr.values() if len(pts) >= min_frames]
        if len(rallies_hit) < min_rallies:
            continue
        allpts = np.array([p for pts in byr.values() for p in pts])
        if allpts[:, 0].std() < max_std and allpts[:, 1].std() < max_std:
            out.add(k)
    return out


def detect_all(model, video, rallies, fps=20.0, hi_res=False, conf=0.15,
               suppress_static=True):
    """Ball detection with the trained model; returns per-rally points as
    [t, x, y, conf] in the 1280x720 reference space (so downstream contact
    detection + the review overlay are unaffected by the decode resolution).

    hi_res=False (default): decode 1280x720, infer at imgsz=1088 — the
        original behavior.
    hi_res=True: decode native 1920x1080, infer at imgsz=1920 — the tiny,
        fast ball keeps ~1.5x more pixels before YOLO sees it. ~2-3x slower.
    conf: detection confidence threshold (raise it to trade recall for
        precision — useful when a hi-res model over-fires).
    suppress_static: drop stationary-clutter detections (spare balls on the
        sideline) via _pick_moving. Keeps ALL detections per frame so the
        real moving ball survives even when a confident spare ball shares the
        frame (the old best-per-frame logic discarded it).
    """
    from .track import _frames, W, H
    dec_w, dec_h, imgsz = (1920, 1080, 1920) if hi_res else (W, H, 1088)
    sx, sy = W / dec_w, H / dec_h   # map detections back to the 720p reference
    # PASS 1: raw detections per rally (the expensive model pass, done once)
    raw_by_rally = []
    for ri, r in enumerate(rallies):
        if r.get("phase") == "warmup":
            raw_by_rally.append([]); continue
        raw = []
        for t, frame in _frames(video, r["start"], r["end"]-r["start"], fps, dec_w, dec_h):
            res = model.predict(frame, conf=conf, imgsz=imgsz, verbose=False)[0]
            for b in res.boxes:
                x, y, w, h = b.xywh[0].tolist()
                raw.append([round(t, 3), x*sx, y*sy, float(b.conf[0])])
        raw_by_rally.append(raw)
    # global static map: fixed objects (lights/signs) recur across rallies
    gstatic = global_static_cells(raw_by_rally) if suppress_static else set()
    if gstatic:
        print(f"  [ball] global static cells suppressed: {len(gstatic)} "
              f"(fixed lights/signs across rallies)")
    # PASS 2: pick the moving ball per rally, minus per-rally + global clutter
    out = []
    for ri, raw in enumerate(raw_by_rally):
        if not raw:
            out.append([]); continue
        pts = (_pick_moving(raw, also_static=gstatic) if suppress_static
               else _best_per_frame(raw))
        r = rallies[ri]
        nfr = int((r['end']-r['start'])*fps)
        print(f"  rally {ri}: {len(pts)}/{nfr} frames"
              f"{f' ({len(raw)-len(pts)} static/dup dropped)' if raw else ''}")
        out.append(pts)
    return out


def _best_per_frame(raw):
    """Legacy behavior: single highest-conf detection per frame (no static
    suppression). Kept for A/B and the --no-suppress-static escape hatch."""
    best = {}
    for t, x, y, c in raw:
        if t not in best or c > best[t][3]:
            best[t] = [t, float(x), float(y), float(c)]
    return [best[t] for t in sorted(best)]
