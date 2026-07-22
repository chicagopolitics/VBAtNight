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

def detect_all(model, video, rallies, fps=20.0, hi_res=False, conf=0.15):
    """Ball detection with the trained model; returns per-rally points as
    [t, x, y, conf] in the 1280x720 reference space (so downstream contact
    detection + the review overlay are unaffected by the decode resolution).

    hi_res=False (default): decode 1280x720, infer at imgsz=1088 — the
        original behavior.
    hi_res=True: decode native 1920x1080, infer at imgsz=1920 — the tiny,
        fast ball keeps ~1.5x more pixels before YOLO sees it. ~2-3x slower.
    conf: detection confidence threshold (raise it to trade recall for
        precision — useful when a hi-res model over-fires).
    """
    from .track import _frames, W, H
    dec_w, dec_h, imgsz = (1920, 1080, 1920) if hi_res else (W, H, 1088)
    sx, sy = W / dec_w, H / dec_h   # map detections back to the 720p reference
    out = []
    for ri, r in enumerate(rallies):
        if r.get("phase") == "warmup":
            out.append([]); continue
        pts = []
        for t, frame in _frames(video, r["start"], r["end"]-r["start"], fps, dec_w, dec_h):
            res = model.predict(frame, conf=conf, imgsz=imgsz, verbose=False)[0]
            best = None
            for b in res.boxes:
                x, y, w, h = b.xywh[0].tolist()
                c = float(b.conf[0])
                if best is None or c > best[3]: best = [round(t,3), x*sx, y*sy, c]
            if best: pts.append(best)
        print(f"  rally {ri}: {len(pts)}/{int((r['end']-r['start'])*fps)} frames")
        out.append(pts)
    return out
