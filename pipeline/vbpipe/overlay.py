"""Model-view renderer: draw what the pipeline sees onto the video.

This is the shared ground-truth instrument — a full-game model-view is a
standard pipeline output so bugs like static false-positive "balls" (a ceiling
light, a wall sign) are visible at a glance instead of inferred from numbers.

Draws, per frame:
  RED dot + conf  = ball detection at that time (game.json 'ball')
  CYAN trail      = ball's last ~0.5s
  GREEN box + cN  = tracked player, labelled with cluster id ('tracklets')
  YELLOW ring     = a contact (touch) near the playhead: play type + cluster

Coordinates in game.json are the 1280x720 reference space; scaled to the
render size automatically.
"""
import subprocess, json, numpy as np

REF_W, REF_H = 1280, 720


def _probe(video, entry):
    return subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", f"stream={entry}", "-of", "csv=p=0", video],
        capture_output=True, text=True).stdout.strip()


def render_overlay(video, game, out, t0=0.0, t1=None, fps=15.0,
                   render_w=1280, render_h=720, players=True, game_only=False):
    """Render [t0,t1] of `video` with pipeline overlays to `out` (H.264).
    game: parsed game.json dict. t1=None -> whole video.
    game_only: skip warmup/skipped rally spans (dead time) — but by default we
    render EVERYTHING so warmup false-positives stay visible."""
    import cv2
    if t1 is None:
        t1 = float(_probe(video, "duration") or 0) or 1e9

    ball = np.array([[p[0], p[1], p[2], p[3]]
                     for pts in game.get("ball", []) for p in pts
                     if t0 <= p[0] <= t1]) if game.get("ball") else np.zeros((0, 4))
    contacts = [c for r in game["rallies"] for c in r.get("contacts", [])
                if t0 <= c["t"] <= t1]
    trs = game["tracklets"] if players else []
    # spans to actually draw/keep (game_only trims dead time)
    keep = None
    if game_only:
        keep = [(r["start"], r["end"]) for r in game["rallies"]
                if r.get("phase") == "game"]

    sx, sy = render_w / REF_W, render_h / REF_H
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    tmp = out + ".raw.mp4"
    vw = cv2.VideoWriter(tmp, fourcc, fps, (render_w, render_h))
    cmd = ["ffmpeg", "-v", "error", "-ss", str(t0), "-t", str(t1 - t0), "-i", video,
           "-vf", f"fps={fps},scale={render_w}:{render_h}",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=render_w * render_h * 3 * 2)
    fi = 0
    while True:
        buf = p.stdout.read(render_w * render_h * 3)
        if len(buf) < render_w * render_h * 3:
            break
        t = t0 + fi / fps
        fi += 1
        if keep is not None and not any(a <= t <= b for a, b in keep):
            continue
        frame = np.frombuffer(buf, np.uint8).reshape(render_h, render_w, 3).copy()
        for tr in trs:
            if tr["t1"] < t - 0.2 or tr["t0"] > t + 0.2:
                continue
            b = min((bb for bb in tr["boxes"] if abs(bb[0] - t) < 0.12),
                    key=lambda bb: abs(bb[0] - t), default=None)
            if b is None:
                continue
            cv2.rectangle(frame, (int(b[1] * sx), int(b[2] * sy)),
                          (int((b[1] + b[3]) * sx), int((b[2] + b[4]) * sy)), (0, 200, 0), 2)
            cv2.putText(frame, f"c{tr.get('cluster')}", (int(b[1] * sx), max(int(b[2] * sy) - 6, 12)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 0), 2)
        if len(ball):
            for bp in ball[(ball[:, 0] >= t - 0.5) & (ball[:, 0] <= t)]:
                cv2.circle(frame, (int(bp[1] * sx), int(bp[2] * sy)), 4, (255, 220, 0), -1)
            for bp in ball[np.abs(ball[:, 0] - t) < (0.6 / fps)]:
                cv2.circle(frame, (int(bp[1] * sx), int(bp[2] * sy)), 11, (0, 0, 255), 3)
                cv2.putText(frame, f"{bp[3]:.2f}", (int(bp[1] * sx) + 12, int(bp[2] * sy)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
        for c in contacts:
            if abs(c["t"] - t) < 0.25:
                cx, cy = int(c["x"] * sx), int(c["y"] * sy)
                cv2.circle(frame, (cx, cy), 22, (0, 255, 255), 3)
                lbl = c.get("play", "?") + (f" c{c['cluster']}" if c.get("cluster") is not None else "")
                cv2.putText(frame, lbl, (cx - 20, cy - 28),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        cv2.putText(frame, f"t={t:.1f}s", (12, 26),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        vw.write(frame)
    p.wait(); vw.release()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp,
                    "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", out])
    subprocess.run(["rm", "-f", tmp])
    return out
