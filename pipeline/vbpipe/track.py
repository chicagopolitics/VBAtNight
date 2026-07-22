"""Person detection + tracking over rally windows (YOLO + ByteTrack via ultralytics).
Requires GPU extras: pip install vbpipe[gpu]"""
import subprocess, numpy as np, os

W, H = 1280, 720

def _frames(video, start, dur, fps, w=None, h=None):
    # w/h default to the 720p decode the person tracker expects; the ball
    # detector can ask for a larger decode (e.g. native 1080p) so the tiny
    # ball keeps more pixels before YOLO sees it.
    w, h = w or W, h or H
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(dur), "-i", video,
           "-vf", f"fps={fps},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=w*h*3*2)
    i = 0
    while True:
        buf = p.stdout.read(w*h*3)
        if len(buf) < w*h*3: break
        yield start + i / fps, np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()
        i += 1
    p.wait()

def track_rallies(video, rallies, cfg, out_dir):
    """Run detection+tracking per rally. Returns tracklets:
    [{id, rally, t0, t1, boxes: [[t,x,y,w,h]], crops: [paths]}]"""
    import cv2
    from ultralytics import YOLO
    model = YOLO(cfg.det_model)
    poly = np.array([[int(x*W), int(y*H)] for x, y in cfg.court_poly], np.int32)
    os.makedirs(f"{out_dir}/crops", exist_ok=True)
    tracklets, next_id = {}, 0
    for ri, r in enumerate(rallies):
        model.predictor = None  # reset tracker state between rallies
        seen = {}
        for t, frame in _frames(video, r["start"], r["end"] - r["start"], cfg.det_fps):
            res = model.track(frame, classes=[0], conf=cfg.det_conf,
                              persist=True, verbose=False, tracker="bytetrack.yaml")[0]
            if res.boxes.id is None: continue
            for box, tid in zip(res.boxes.xywh.cpu().numpy(),
                                res.boxes.id.int().cpu().numpy()):
                cx, cy, w, h = box
                if h < cfg.min_box_h_px: continue
                foot = (int(cx), int(cy + h/2))
                if cv2.pointPolygonTest(poly, foot, False) < 0: continue
                key = (ri, int(tid))
                if key not in seen:
                    seen[key] = {"id": next_id, "rally": ri, "boxes": [], "crops": []}
                    tracklets[key] = seen[key]; next_id += 1
                tr = seen[key]
                tr["boxes"].append([round(t,2), float(cx-w/2), float(cy-h/2),
                                    float(w), float(h)])
                if len(tr["boxes"]) % 5 == 1:   # save every 5th crop
                    x0,y0 = max(0,int(cx-w/2)-4), max(0,int(cy-h/2)-4)
                    crop = frame[y0:int(cy+h/2)+4, x0:int(cx+w/2)+4]
                    fn = f"crops/t{tr['id']:04d}_{len(tr['crops']):03d}.jpg"
                    cv2.imwrite(f"{out_dir}/{fn}", crop,
                                [cv2.IMWRITE_JPEG_QUALITY, 92])
                    tr["crops"].append(fn)
    out = [tr for tr in tracklets.values() if len(tr["boxes"]) >= cfg.min_tracklet_len]
    for tr in out:
        tr["t0"], tr["t1"] = tr["boxes"][0][0], tr["boxes"][-1][0]
    return out
