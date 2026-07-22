"""Render annotated eval clips: ball dot, contact flashes, play labels."""
import numpy as np, os, subprocess

W, H = 1280, 720

def render_rally(video, rally, ball_pts, contacts, out_path, fps=20.0):
    import cv2
    from .track import _frames
    tmp = out_path + ".raw.mp4"
    vw = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
    bp = {round(p[0]*fps): p for p in ball_pts}
    for t, frame in _frames(video, rally["start"], rally["end"]-rally["start"], fps):
        k = round(t*fps)
        for dk in range(-3, 1):          # short trail
            p = bp.get(k+dk)
            if p: cv2.circle(frame, (int(p[1]), int(p[2])), 7+dk*1, (0,255,255), 2)
        for c in contacts:
            if abs(c["t"] - t) < 0.25:
                cv2.circle(frame, (int(c["x"]), int(c["y"])), 26, (0,0,255), 3)
                lbl = f'{c.get("play","?")} P{c.get("cluster","?")}'
                cv2.putText(frame, lbl, (int(c["x"])-40, int(c["y"])-32),
                            0, 0.8, (0,0,255), 2)
        cv2.putText(frame, f"t={t:.1f}s", (12, 30), 0, 0.8, (255,255,255), 2)
        vw.write(frame)
    vw.release()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp,
                    "-c:v", "libx264", "-crf", "24", out_path])
    try: os.remove(tmp)
    except OSError: pass
