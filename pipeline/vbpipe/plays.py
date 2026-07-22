"""Contact detection + player attribution + play typing.
v2: player-foot side determination, spurious-contact rejection, gap bridging."""
import numpy as np

NET = ((0.34, 0.667), (0.70, 0.796))   # default net floor line (M1 gym)
W, H = 1280, 720

def set_net(net):
    """Override net line from venue calibration."""
    global NET
    NET = (tuple(net[0]), tuple(net[1]))

def _side(x, y):
    (x1,y1),(x2,y2) = NET
    return 1 if (x2-x1)*(y/H - y1) - (y2-y1)*(x/W - x1) > 0 else -1

def _dist_to_net(x, y):
    (x1,y1),(x2,y2) = NET
    a = np.array([x1*W, y1*H]); b = np.array([x2*W, y2*H]); p = np.array([x, y])
    ab = b - a
    t = np.clip(np.dot(p-a, ab)/np.dot(ab, ab), 0, 1)
    return float(np.linalg.norm(p - (a + t*ab)))

def find_contacts(ball_pts, min_gap=0.35, cos_thr=0.55, dv_thr=260):
    """Velocity discontinuities -> candidate contact events [{t,x,y}]."""
    if len(ball_pts) < 5: return []
    P = np.array([[p[0], p[1], p[2]] for p in ball_pts])
    ev = []
    for i in range(2, len(P)-2):
        t = P[i,0]
        if P[i+2,0] - P[i-2,0] > 1.2: continue     # don't bridge decode gaps
        v1 = (P[i,1:]-P[i-2,1:])/max(P[i,0]-P[i-2,0], 1e-3)
        v2 = (P[i+2,1:]-P[i,1:])/max(P[i+2,0]-P[i,0], 1e-3)
        s1, s2 = np.linalg.norm(v1), np.linalg.norm(v2)
        if s1 < 60 and s2 < 60: continue
        cosang = np.dot(v1, v2)/(s1*s2 + 1e-6)
        vy_flip = v1[1] > 40 and v2[1] < -40
        mag = abs(s2-s1)
        if cosang < cos_thr or vy_flip or mag > dv_thr:
            if ev and t - ev[-1]["t"] < min_gap:
                if mag > ev[-1]["_m"]:
                    ev[-1] = {"t": round(t,2), "x": P[i,1], "y": P[i,2], "_m": mag}
                continue
            ev.append({"t": round(t,2), "x": P[i,1], "y": P[i,2], "_m": mag})
    for e in ev: e.pop("_m", None)
    return ev

def attribute(contacts, tracklets, rally_idx):
    """Nearest player; contacts with nobody within 260px are dropped as spurious.
    Court side comes from the player's feet (geometrically unambiguous)."""
    trs = [tr for tr in tracklets if tr["rally"] == rally_idx]
    out = []
    for c in contacts:
        best, bd, bbox = None, 1e9, None
        for tr in trs:
            for b in tr["boxes"]:
                if abs(b[0] - c["t"]) > 0.3: continue
                bx, by = b[1]+b[3]/2, b[2]+b[4]*0.35
                d = np.hypot(bx - c["x"], (by - c["y"])*0.6)
                if d < bd: bd, best, bbox = d, tr, b
        if best is None or bd > 260:
            continue
        c["cluster"] = best.get("cluster") if bd < 120 else None
        c["tracklet"] = best["id"]
        c["dist_px"] = round(float(bd), 1)
        c["side"] = _side(bbox[1]+bbox[3]/2, bbox[2]+bbox[4])
        out.append(c)
    return out

def classify(contacts):
    """Rule-based play typing over one rally's contact sequence."""
    if not contacts: return contacts
    contacts[0]["play"] = "serve"
    side, touch, prev_attack = contacts[0]["side"], 0, None
    for c in contacts[1:]:
        if c["side"] != side:
            side, touch = c["side"], 1
        else:
            touch += 1
        if prev_attack and c["t"]-prev_attack < 0.45 and _dist_to_net(c["x"], c["y"]) < 90:
            c["play"] = "block"; touch = 0
        elif touch <= 1:
            c["play"] = "dig" if prev_attack and c["t"]-prev_attack < 2.0 else "receive"
        elif touch == 2:
            c["play"] = "set"
        else:
            c["play"] = "attack"
        if c["play"] == "attack": prev_attack = c["t"]
    return contacts
