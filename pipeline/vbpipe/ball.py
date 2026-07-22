"""Ball detection with multi-candidate tracking + game-ball track selection."""
import numpy as np

W, H = 1280, 720

def detect_ball(video, rallies, cfg, fps=20.0):
    """Per rally: candidate detections -> linked tracks -> best 'game ball' track.
    Returns list (per rally) of [t, x, y, conf]."""
    from ultralytics import YOLO
    from .track import _frames
    import cv2
    model = YOLO(cfg.det_model)
    poly = np.array([[int(x*W), int(y*H)] for x, y in cfg.court_poly], np.int32)
    out = []
    for ri, r in enumerate(rallies):
        if r.get("phase") == "warmup":
            out.append([]); continue
        dets = []   # [t, x, y, conf]
        for t, frame in _frames(video, r["start"], r["end"] - r["start"], fps):
            res = model.predict(frame, classes=[32], conf=0.08, imgsz=1280,
                                verbose=False)[0]
            for b in res.boxes:
                x, y, w, h = b.xywh[0].tolist()
                if w > 70 or h > 70: continue
                dets.append([round(t,3), x, y, float(b.conf[0])])
        tracks = _link(dets)
        best = _select_game_track(tracks, poly)
        out.append(best)
        print(f"  rally {ri}: {len(dets)} dets, {len(tracks)} tracks, "
              f"game-ball pts: {len(best)}")
    return out

def _link(dets, max_gap=0.45, max_speed=900.0):
    """Greedy nearest-neighbour linking into tracks."""
    tracks = []
    for d in sorted(dets, key=lambda d: d[0]):
        best, bd = None, 1e9
        for tr in tracks:
            q = tr[-1]
            dt = d[0] - q[0]
            if dt <= 0 or dt > max_gap: continue
            dist = np.hypot(d[1]-q[1], d[2]-q[2])
            if dist / dt > max_speed: continue
            if dist < bd: bd, best = dist, tr
        if best is not None: best.append(d)
        else: tracks.append([d])
    return [t for t in tracks if len(t) >= 5]

def _select_game_track(tracks, poly):
    """Score tracks by game-ball behaviour; return the winner's points."""
    import cv2
    if not tracks: return []
    def score(tr):
        P = np.array(tr)
        dur = P[-1,0] - P[0,0]
        inside = np.mean([cv2.pointPolygonTest(poly, (float(x), float(min(y+80, H-1))),
                                               False) >= 0 for _, x, y, _ in tr])
        xextent = P[:,1].max() - P[:,1].min()
        travel = min(1.0, xextent / 350.0)       # bounce-in-place has tiny x range
        return dur * (0.3 + inside) * (0.3 + travel)
    tracks.sort(key=score, reverse=True)
    return tracks[0]
