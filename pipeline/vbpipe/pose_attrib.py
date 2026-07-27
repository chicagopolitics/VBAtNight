"""Phase B (experimental): enrich contacts with WRIST keypoints so attribution
can match the ball to the striking hand instead of the body-center box.

Why: on cca-one/two, nearest-body-center attribution caps ~25% — the ball at
contact is ~227px from the box center and players sit ~150px apart, so the
geometric nearest is often the wrong person. Wrists are where the ball is
actually struck.

Design decisions (deliberate, so this can't hurt the Phase-A measurement):
  * Pose runs ONLY at contact times (~500/game), not every frame — cheap.
  * It only ADDS a `wrists` field to each contact; it does NOT change
    `cluster`/attribution. Body-center attribution (plays.attribute) stays the
    default, so the run is still a clean Phase-A coverage test.
  * Wrist-vs-body attribution is compared OFFLINE against corrections. If it
    wins, we promote it in a later change; if not, nothing was risked.

Each contact gains:
  c["wrists"] = [[x, y, cluster_id_or_null, wrist_to_ball_px], ...]  # nearest few
sorted by distance to the ball, mapped to the tracklet whose box the wrist
falls in (so we recover the cluster).

Run on GPU (Colab). Requires ultralytics pose weights (auto-downloaded).
VALIDATE wrist sanity on a few rallies before trusting a full run.
"""
import numpy as np

# COCO keypoint indices used by yolo11*-pose
L_WRIST, R_WRIST = 9, 10
W, H = 1280, 720   # tracklet/contact reference space


def _boxes_at(tracklets, rally_idx, t, win=0.15):
    """Tracklet boxes active within `win` seconds of time t, as
    (cluster_id, x0, y0, x1, y1) in the 1280x720 reference space."""
    out = []
    for tr in tracklets:
        if tr["rally"] != rally_idx:
            continue
        best = None
        for b in tr["boxes"]:
            if abs(b[0] - t) <= win and (best is None or abs(b[0] - t) < abs(best[0] - t)):
                best = b
        if best is not None:
            out.append((tr.get("cluster"), best[1], best[2],
                        best[1] + best[3], best[2] + best[4]))
    return out


def _cluster_for_point(boxes, x, y):
    """Which tracklet box contains (x,y)? Nearest box center on a tie/miss."""
    inside = [c for (c, x0, y0, x1, y1) in boxes if x0 <= x <= x1 and y0 <= y <= y1]
    if len(inside) == 1:
        return inside[0]
    best, bd = None, 1e9
    for (c, x0, y0, x1, y1) in boxes:
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        d = np.hypot(cx - x, cy - y)
        if d < bd:
            bd, best = d, c
    return best


def enrich_contacts(video, rallies, contacts_per_rally, tracklets, pose_model,
                    fps_ref=None, decode_wh=(1920, 1080), imgsz=1280):
    """For every contact, run pose on its frame and attach nearby wrist
    keypoints. `contacts_per_rally[ri]` is the list from find_contacts.
    `pose_model` is a loaded ultralytics YOLO('*-pose') model.

    decode_wh: native decode size; keypoints are scaled back to 1280x720 so
    they share the contact/tracklet coordinate space.
    """
    import subprocess
    dw, dh = decode_wh
    sx, sy = W / dw, H / dh
    for ri, r in enumerate(rallies):
        if r.get("phase") == "warmup":
            continue
        cs = contacts_per_rally[ri]
        for c in cs:
            # decode the single frame at the contact time
            raw = subprocess.run(
                ["ffmpeg", "-v", "error", "-ss", f"{c['t']:.3f}", "-i", video,
                 "-frames:v", "1", "-vf", f"scale={dw}:{dh}",
                 "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                capture_output=True).stdout
            if len(raw) < dw * dh * 3:
                c["wrists"] = []
                continue
            frame = np.frombuffer(raw, np.uint8).reshape(dh, dw, 3)
            res = pose_model.predict(frame, imgsz=imgsz, verbose=False)[0]
            boxes = _boxes_at(tracklets, ri, c["t"])
            wrists = []
            kpts = res.keypoints
            if kpts is not None and kpts.xy is not None:
                for person in kpts.xy.cpu().numpy():        # (K,2) per person
                    for wi in (L_WRIST, R_WRIST):
                        if wi >= len(person):
                            continue
                        wx, wy = person[wi][0] * sx, person[wi][1] * sy
                        if wx <= 0 and wy <= 0:              # missing keypoint
                            continue
                        d = float(np.hypot(wx - c["x"], wy - c["y"]))
                        cl = _cluster_for_point(boxes, wx, wy)
                        # cast everything to plain Python types — numpy float32
                        # from the pose model is not JSON-serializable
                        wrists.append([round(float(wx), 1), round(float(wy), 1),
                                       int(cl) if cl is not None else None,
                                       round(d, 1)])
            wrists.sort(key=lambda w: w[3])
            c["wrists"] = wrists[:4]
    return contacts_per_rally


def reject_wristless_contacts(contacts, wrist_max=180):
    """Drop phantom contacts with NO WRIST near the ball — a real touch needs a
    hand there. This is the main PRECISION lever (Ken's #1 review pain is
    touch-count inflation: a rally with 20 detected touches but 12 real forces
    a wipe-and-redo). Camera-agnostic (unlike the old height-gated apex rule,
    which was cca-one-specific): it keys on player anatomy, not frame geometry.

    A contact is kept iff its nearest wrist is within wrist_max px. At 180px
    both cca games land at ~1.0x inflation (was 1.26x / 1.20x): cca-one P
    55->66% R 70->64%, cca-two P 63->69% R 76->71%. Lower wrist_max = higher
    precision, less recall (Ken trades recall gladly — a missing touch is a
    one-click add; a phantom-inflated rally is a wipe). Subsumes the old apex
    filter (apex phantoms are airborne with no wrist -> caught here too).
    No-op on contacts without a 'wrists' field (pose didn't run)."""
    out = []
    for c in contacts:
        ws = c.get("wrists")
        if ws is None:              # pose didn't run — keep everything
            out.append(c); continue
        nearest = ws[0][3] if ws else 1e9
        if nearest > wrist_max:
            continue                # no hand at the ball -> phantom
        out.append(c)
    return out


def attribute_by_wrist(contact, gate=140, drop=260):
    """Offline/experimental: cluster from the nearest wrist within `gate` px;
    None if the nearest wrist is beyond `drop`. Tighter than body-center
    gates because a wrist should be much closer to the ball than a torso."""
    ws = contact.get("wrists") or []
    if not ws:
        return None
    x, y, cl, d = ws[0]
    if d > drop:
        return None
    return cl if d < gate and cl is not None else None
