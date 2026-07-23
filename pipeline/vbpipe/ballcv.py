"""Motion-based ball detection (CPU): triple-frame differencing, body-mask
exclusion, prediction-gated linking, physics (parabola) verification.
Validated on M1 footage — replaces YOLO 'sports ball' which sees ~3% of frames."""
import subprocess, numpy as np, json

W, H, FPS = 1280, 720, 20.0   # FPS = default sampling rate (historical tuning)

def _frames_gray(video, start, dur, fps=FPS):
    import cv2
    cmd = ["ffmpeg","-v","error","-ss",str(start),"-t",str(dur),"-i",video,
           "-vf",f"fps={fps},scale={W}:{H}","-f","rawvideo","-pix_fmt","gray","-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=W*H*2)
    i = 0
    while True:
        buf = p.stdout.read(W*H)
        if len(buf) < W*H: break
        yield start + i/fps, np.frombuffer(buf, np.uint8).reshape(H, W)
        i += 1
    p.wait()

def _player_buckets(tracklets, rally_idx, t0, t1):
    b = {}
    for tr in tracklets:
        for bx in tr["boxes"]:
            t, x, y, w, h = bx
            if t0-0.5 <= t <= t1+0.5:
                b.setdefault(round(t,1), []).append((x-12,y-14,x+w+12,y+h+8))
    return b

def _in_boxes(b, t, x, y):
    for k in (round(t,1), round(t-0.1,1), round(t+0.1,1)):
        for (x0,y0,x1,y1) in b.get(k,[]):
            if x0<=x<=x1 and y0<=y<=y1: return True
    return False

def detect_rally(video, rally, tracklets, rally_idx, fps=FPS):
    """fps: sampling rate. Default 20 reproduces historical behavior exactly.
    At higher fps the frame-differencing baseline is kept at ~50ms via a
    stride (a slow-moving ball overlaps itself between 16ms frames, which
    would erase it from consecutive-frame diffs), while candidates are still
    emitted at the full rate."""
    import cv2
    from collections import deque
    stride = max(1, round(fps / FPS))     # diff across ~50ms regardless of fps
    hist = deque(maxlen=2*stride + 1)     # [oldest .. newest]
    t0, t1 = rally["start"], rally["end"]
    buckets = _player_buckets(tracklets, rally_idx, t0, t1)
    dets = []
    for t, f in _frames_gray(video, t0, t1-t0, fps):
        hist.append(f)
        if len(hist) == 2*stride + 1:
            prev2, prev1 = hist[0], hist[stride]
            tt = t - stride/fps
            d1 = cv2.absdiff(f, prev1); d2 = cv2.absdiff(prev1, prev2)
            m = cv2.threshold(cv2.min(d1,d2), 24, 255, cv2.THRESH_BINARY)[1]
            m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2,2),np.uint8))
            big = cv2.threshold(d1, 20, 255, cv2.THRESH_BINARY)[1]
            big = cv2.morphologyEx(big, cv2.MORPH_CLOSE, np.ones((9,9),np.uint8))
            bc,_ = cv2.findContours(big, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            mask = np.zeros((H,W), np.uint8)
            for c in bc:
                if cv2.contourArea(c) > 1200:
                    cv2.drawContours(mask, [c], -1, 255, -1)
            mask = cv2.dilate(mask, np.ones((13,13),np.uint8))
            cands = []
            cnts,_ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for c in cnts:
                x,y,w,h = cv2.boundingRect(c)
                cx, cy = x+w/2, y+h/2
                if not (9 <= w*h <= 700 and w < 38 and h < 38): continue
                if cy > H*0.92 or cy < H*0.18: continue
                if _in_boxes(buckets, tt, cx, cy): continue
                if mask[int(min(cy,H-1)), int(min(cx,W-1))]: continue
                cands.append((cx, cy))
            dets.append((round(tt,3), cands))
    return _select(_link(dets), fps)

def _link(dets):
    tracks = []
    for t, cands in dets:
        used = set()
        for tr in tracks:
            if t - tr[-1][0] > 0.3: continue
            if len(tr) >= 2:
                (ta,xa,ya),(tb,xb,yb) = tr[-1], tr[-2]
                vx, vy = (xa-xb)/(ta-tb+1e-6), (ya-yb)/(ta-tb+1e-6)
            else: vx = vy = 0.0
            dt = t - tr[-1][0]
            px, py = tr[-1][1]+vx*dt, tr[-1][2]+vy*dt+0.5*900*dt*dt
            best, bd = None, 55.0 if len(tr) >= 2 else 90.0
            for i,(x,y) in enumerate(cands):
                if i in used: continue
                d = np.hypot(x-px, y-py)
                if d < bd: bd, best = d, i
            if best is not None:
                tr.append((t, cands[best][0], cands[best][1])); used.add(best)
        for i,(x,y) in enumerate(cands):
            if i not in used: tracks.append([(t,x,y)])
    return [tr for tr in tracks if len(tr) >= 5]

def _parab_ok(tr):
    P = np.array(tr); t = P[:,0]-P[0,0]; x = P[:,1]; y = P[:,2]
    ry = y - np.polyval(np.polyfit(t,y,2), t)
    rx = x - np.polyval(np.polyfit(t,x,1), t)
    r = np.sqrt(ry**2 + rx**2)
    return (float(np.sqrt((r**2).mean())), int(np.argmax(r)))

def _split_check(tr, depth=0):
    """Keep parabola-consistent segments; split at worst point otherwise."""
    if len(tr) < 5: return []
    res, worst = _parab_ok(tr)
    if res <= 14: return [tr]
    if depth >= 3: return []
    a, b = tr[:max(worst,1)], tr[max(worst,1):]
    return _split_check(a, depth+1) + _split_check(b, depth+1)

def _select(tracks, fps=FPS):
    """Physics filter + merge into single time-sorted point list."""
    kept = []
    for tr in tracks:
        P = np.array(tr); t = P[:,0]-P[0,0]; x = P[:,1]; y = P[:,2]
        if t[-1] < 0.25: continue
        speed = np.hypot(np.diff(x), np.diff(y)).sum()/t[-1]
        if speed < 250 or y.min() > 560: continue
        if max(x.max()-x.min(), y.max()-y.min()) < 50: continue
        kept.extend(_split_check(tr))
    pts = sorted((p for tr in kept for p in tr), key=lambda p: p[0])
    # dedupe near-simultaneous duplicates (parallel tracks). Window must stay
    # below the frame interval or real consecutive points get eaten at high
    # fps; 0.8/fps = the historical 0.04s at 20fps.
    out = []
    for p in pts:
        if out and p[0]-out[-1][0] < 0.8/fps and np.hypot(p[1]-out[-1][1], p[2]-out[-1][2]) < 40:
            continue
        out.append([round(p[0],3), float(p[1]), float(p[2]), 1.0])
    return out
