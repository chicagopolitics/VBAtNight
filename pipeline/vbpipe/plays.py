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

def find_contacts(ball_pts, min_gap=0.35, cos_thr=0.55, dv_thr=260, vel_win=0.1):
    """Velocity discontinuities -> candidate contact events [{t,x,y}].

    fps-independent: the velocity window spans at least 2 points AND at least
    `vel_win` seconds on each side. On 20fps-sampled data (all footage through
    2026-07) 2 points already cover >=0.1s, so this is bit-identical to the
    old fixed +/-2-index window; at 60fps the time floor stops the baseline
    collapsing to 33ms (which would amplify pixel jitter into velocity noise).
    """
    if len(ball_pts) < 5: return []
    P = np.array([[p[0], p[1], p[2]] for p in ball_pts])
    T = P[:, 0]
    n = len(P)
    EPS = 1e-6
    ev = []
    for i in range(2, n - 2):
        b = i - 2
        while b > 0 and T[i] - T[b] < vel_win - EPS: b -= 1
        f = i + 2
        while f < n - 1 and T[f] - T[i] < vel_win - EPS: f += 1
        if T[i] - T[b] < vel_win - EPS or T[f] - T[i] < vel_win - EPS:
            continue                                # too close to a rally edge
        t = T[i]
        if T[f] - T[b] > 1.2: continue              # don't bridge decode gaps
        v1 = (P[i,1:]-P[b,1:])/max(T[i]-T[b], 1e-3)
        v2 = (P[f,1:]-P[i,1:])/max(T[f]-T[i], 1e-3)
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

def classify(contacts, resync_at=None, max_touch_gap=None, serve_gate=True):
    """Rule-based play typing with a serve anchor.

    contacts[0] is labeled "serve" only when the next contact is on the OTHER
    side (a legal serve must cross the net). When the serve was missed by the
    detector, the first seen touch now types normally instead of shifting
    every later label. A/B on game2 corrections (2026-07-22): 39% vs 37%
    exact, and most receive->serve confusions gone.

    resync_at / max_touch_gap are stricter resync anchors (a `resync_at`-th
    same-side touch, or a same-side gap > max_touch_gap seconds, imply missed
    contacts -> restart the possession). Every setting HURT on game2 at
    contacts P51/R57 — half the contacts are spurious, so these anchors fire
    on noise and demote real attacks (25->7 correct). Left OFF by default;
    retest on gen-3+ reprocessed output with `pipeline/typer_sweep.py`.
    """
    if not contacts: return contacts
    side, touch, prev_attack = None, 0, None
    for i, c in enumerate(contacts):
        prev = contacts[i - 1] if i else None
        # serve anchor: only claim it when the evidence fits
        if i == 0:
            nxt = contacts[1] if len(contacts) > 1 else None
            if not serve_gate or nxt is None or nxt["side"] != c["side"]:
                c["play"] = "serve"; side, touch = c["side"], 1
                continue
        is_block = (prev_attack is not None and c["t"] - prev_attack < 0.45
                    and _dist_to_net(c["x"], c["y"]) < 90)
        new_poss = (side is None or c["side"] != side
                    or (max_touch_gap and prev is not None and c["t"] - prev["t"] > max_touch_gap)
                    or (resync_at and touch >= resync_at))
        if is_block:
            c["play"] = "block"; side, touch = c["side"], 0
        else:
            if new_poss: side, touch = c["side"], 1
            else: touch += 1
            if touch <= 1:
                c["play"] = "dig" if prev_attack and c["t"] - prev_attack < 2.0 else "receive"
            elif touch == 2:
                c["play"] = "set"
            else:
                c["play"] = "attack"
        if c["play"] == "attack": prev_attack = c["t"]
    return contacts
