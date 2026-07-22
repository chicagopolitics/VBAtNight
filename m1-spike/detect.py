"""Player detection via MOG2 background subtraction on a rally window.
Usage: detect.py <start> <dur> — saves crops + metadata."""
import subprocess, numpy as np, cv2, sys, os, json

VIDEO = "/sessions/eloquent-dazzling-hawking/mnt/balltime/example.mp4"
OUT = "/sessions/eloquent-dazzling-hawking/mnt/outputs/spike"
W, H, FPS = 1280, 720, 6

# Court polygon at 720p (scaled from 1080p inspection, with margin)
POLY = np.array([[380,360],[850,355],[1030,470],[1000,680],[100,715],[95,660]], np.int32)
MASK = np.zeros((H, W), np.uint8)
cv2.fillPoly(MASK, [POLY], 255)

def run(start, dur):
    os.makedirs(f"{OUT}/crops", exist_ok=True)
    cmd = ["ffmpeg","-v","error","-ss",str(start),"-t",str(dur),"-i",VIDEO,
           "-vf",f"fps={FPS},scale={W}:{H}","-f","rawvideo","-pix_fmt","bgr24","-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=W*H*3*2)
    bg = cv2.createBackgroundSubtractorMOG2(history=80, varThreshold=28, detectShadows=True)
    meta, i = [], 0
    while True:
        buf = p.stdout.read(W*H*3)
        if len(buf) < W*H*3: break
        f = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        fg = bg.apply(f)
        i += 1
        if i < 12: continue          # let bg model warm up
        if i % 3: continue           # sample every 0.5s
        fg = cv2.threshold(fg, 200, 255, cv2.THRESH_BINARY)[1]  # drop shadows
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3,3),np.uint8))
        fg = cv2.dilate(fg, np.ones((7,7),np.uint8), 2)
        fg = cv2.bitwise_and(fg, MASK)
        cnts,_ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            x,y,w,h = cv2.boundingRect(c)
            if h < 40 or w < 15 or h > 350 or w > h*1.3 or cv2.contourArea(c) < 500: continue
            # distance-normalized min height: far players (small y) are smaller
            if h < 40 + (y+h-355)*0.12: continue
            t = start + i/FPS
            crop = f[max(0,y-5):y+h+5, max(0,x-5):x+w+5]
            fn = f"crop_{t:07.1f}_{x}_{y}.jpg"
            cv2.imwrite(f"{OUT}/crops/{fn}", crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
            meta.append({"t": round(t,1), "x": x, "y": y, "w": w, "h": h, "f": fn})
    p.wait()
    mf = f"{OUT}/crops_meta.json"
    old = json.load(open(mf)) if os.path.exists(mf) else []
    json.dump(old + meta, open(mf, "w"))
    print(f"rally {start}: {len(meta)} crops (total {len(old)+len(meta)})")

run(float(sys.argv[1]), float(sys.argv[2]))
