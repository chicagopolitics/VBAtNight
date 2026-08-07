"""Re-price the pipeline's PIXEL-SPACE constants for a new camera position.

    python camera_check.py NEW/game.json
    python camera_check.py NEW/game.json --ref ../game.json     # side-by-side

Why this exists: almost every threshold in vbpipe is in pixels, and pixels are
a property of where the tripod stood. Move the camera - higher, wider, closer -
and `gate=220`, `dv_thr=260`, `wrist_max=180`, `min_box_h_px=45` all silently
mean something different in the real world, while the code keeps running and
producing plausible-looking garbage. Discovering that after six games of REVIEW
is the expensive way to find out.

Reads game.json only. No GPU, no torch, no video, **stdlib only** - so it runs
on the review machine straight after a pilot run with nothing installed.

Headline output is a SCALE FACTOR: players are a fixed real-world size, so the
ratio of median tracked box height (new vs reference) estimates how the pixel
scale moved, and every px constant is rescaled by it as a starting point.
That is an approximation - a higher camera also flattens the depth gradient,
so near/far are reported separately and the two should be sanity-checked
against each other before trusting a single number.
"""
import argparse, json, math
from collections import defaultdict
from statistics import median

# Current defaults, i.e. what the pipeline will use if nothing is changed.
# Kept here rather than imported so this script stays stdlib-only (vbpipe
# pulls in numpy, which the review machine need not have).
CONST = {
    "min_box_h_px": 45,      # config.Config
    "court_margin_px": 90,   # config.Config
    "gate": 220,             # plays.attribute
    "drop": 340,             # plays.attribute
    "y_weight": 0.6,         # plays.attribute
    "dv_thr": 260,           # plays.find_contacts (px/s)
    "wrist_max": 180,        # pose_attrib.reject_wristless_contacts
    "ball_max_dim": 70,      # ball.detect_ball size filter
    "max_speed": 900,        # ball._link (px/s)
    "cluster_thresh": 0.12,  # config.Config
}


def pct(xs, p):
    """p-th percentile of an unsorted list (nearest-rank). Empty -> None."""
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, int(round(p / 100 * len(s))) - 1))]


def fmt(x, n=1):
    return "n/a" if x is None else f"{x:.{n}f}"


def line(label, new, ref=None, n=1):
    """One metric row; shows the ratio when a reference run is supplied."""
    s = f"  {label:<38} {fmt(new, n):>9}"
    if ref is not None:
        r = f"{new/ref:.2f}x" if (ref and new is not None) else "n/a"
        s += f"   ref {fmt(ref, n):>9}   {r:>6}"
    print(s)


# ---------------------------------------------------------------- measurement

def anchor(b):
    """The point plays.attribute measures to: box centre-x, 35% down (upper
    torso). Must stay identical to plays.attribute or the gate advice is wrong."""
    return b[1] + b[3] / 2, b[2] + b[4] * 0.35


def measure(g):
    """Every camera-dependent distribution we can recover from game.json."""
    m = {}
    trs = g.get("tracklets", [])
    rallies = g.get("rallies", [])
    ball = g.get("ball", [])

    # --- pipeline provenance (vbpipe >= 1.0.0) ---------------------------
    m["stamp"] = g.get("pipeline")

    # --- player scale ----------------------------------------------------
    # Box height is the proxy for pixel scale: a volleyball player is ~1.7m
    # whatever the camera does, so the ratio of median heights IS the scale
    # change. Split near/far by foot position because a higher camera changes
    # the depth gradient, not just the overall zoom.
    heights, near_h, far_h = [], [], []
    for tr in trs:
        for b in tr["boxes"]:
            foot_y = b[2] + b[4]
            heights.append(b[4])
            (near_h if foot_y > 460 else far_h).append(b[4])
    m["box_h_med"] = median(heights) if heights else None
    m["box_h_p05"] = pct(heights, 5)
    m["box_h_near_med"] = median(near_h) if near_h else None
    m["box_h_far_med"] = median(far_h) if far_h else None
    m["box_below_gate_pct"] = (100 * sum(h < CONST["min_box_h_px"] for h in heights)
                               / len(heights)) if heights else None

    # --- tracking coverage ----------------------------------------------
    # The headline health check. cca-one targeted ~11-12 concurrent of 12 on
    # court; well below that means the court polygon or det_conf is wrong for
    # this camera, and nothing downstream can be trusted.
    peaks = []
    for ri, r in enumerate(rallies):
        rt = [tr for tr in trs if tr["rally"] == ri]
        if not rt:
            continue
        best = 0
        t = r["start"]
        while t <= r["end"]:
            best = max(best, sum(1 for tr in rt if tr["t0"] <= t <= tr["t1"]))
            t += 0.5
        peaks.append(best)
    m["concurrent_med"] = median(peaks) if peaks else None
    m["tracklets_per_rally"] = (len(trs) / len(rallies)) if rallies else None
    durs = [tr["t1"] - tr["t0"] for tr in trs]
    m["tracklet_dur_med"] = median(durs) if durs else None

    # --- inter-player spacing -------------------------------------------
    # The scale reference for the attribution gate. Nearest-player attribution
    # is only meaningful if `gate` is comfortably under HALF the typical
    # spacing; at gate > spacing/2 the rule is closer to a coin flip.
    spacings = []
    for ri, r in enumerate(rallies):
        rt = [tr for tr in trs if tr["rally"] == ri]
        t = r["start"]
        while t <= r["end"]:
            pts = []
            for tr in rt:
                b = min((bb for bb in tr["boxes"] if abs(bb[0] - t) < 0.2),
                        key=lambda bb: abs(bb[0] - t), default=None)
                if b:
                    pts.append(anchor(b))
            for i in range(len(pts)):
                for j in range(i + 1, len(pts)):
                    spacings.append(math.hypot(pts[i][0] - pts[j][0],
                                               pts[i][1] - pts[j][1]))
            t += 2.0        # coarse sample; spacing changes slowly
    m["spacing_med"] = median(spacings) if spacings else None
    m["spacing_p10"] = pct(spacings, 10)

    # --- contact -> player geometry (gate / drop / y-weight) -------------
    # Recomputed rather than read from the stored dist_px, so dx and dy can be
    # decomposed: the 0.6 y-weight exists to cancel perspective compression,
    # and a higher camera changes exactly that. If weighted dy no longer
    # roughly matches dx in magnitude, 0.6 is the wrong number now.
    cdist, cdx, cdy = [], [], []
    for ri, r in enumerate(rallies):
        rt = [tr for tr in trs if tr["rally"] == ri]
        for c in r.get("contacts", []):
            best = None
            for tr in rt:
                for b in tr["boxes"]:
                    if abs(b[0] - c["t"]) > 0.3:
                        continue
                    bx, by = anchor(b)
                    dx, dy = abs(bx - c["x"]), abs(by - c["y"])
                    d = math.hypot(dx, dy * CONST["y_weight"])
                    if best is None or d < best[0]:
                        best = (d, dx, dy)
            if best:
                cdist.append(best[0]); cdx.append(best[1]); cdy.append(best[2])
    m["contact_d_med"] = median(cdist) if cdist else None
    m["contact_d_p75"] = pct(cdist, 75)
    m["contact_d_p95"] = pct(cdist, 95)
    m["contact_dx_med"] = median(cdx) if cdx else None
    m["contact_dy_med"] = median(cdy) if cdy else None
    m["n_contacts"] = len(cdist)

    # --- wrist distances (only if pose ran) ------------------------------
    wr = [c["wrists"][0][3] for r in rallies for c in r.get("contacts", [])
          if c.get("wrists")]
    m["wrist_med"] = median(wr) if wr else None
    m["wrist_p75"] = pct(wr, 75)
    m["n_wrist_contacts"] = len(wr)

    # --- ball: detection density, speed, and what the rules would fire on -
    # Sampling rate: prefer the stamp. Failing that, estimate it from the
    # data - do NOT assume the legacy 20. game.json rounds ball timestamps to
    # 2dp, so at 60fps a frame gap quantises to 0.01 or 0.02 and any single
    # frame-to-frame speed carries a 2x error. Averaging the sub-p75 gaps
    # (i.e. genuinely adjacent frames) recovers the true interval.
    st = (g.get("pipeline") or {}).get("stages", {}).get("plays", {})
    fps = (st.get("params", {}) or {}).get("ball_fps") if st else None
    if not fps:
        gaps = [b[0] - a[0] for pts in ball for a, b in zip(pts, pts[1:])
                if 0 < b[0] - a[0] < 1.0]
        cut = pct(gaps, 75)
        adj = [d for d in gaps if d <= cut] if cut else []
        fps = round(1 / (sum(adj) / len(adj))) if adj else 20.0

    got, want = 0, 0
    for ri, pts in enumerate(ball):
        if ri < len(rallies):
            r = rallies[ri]
            if r.get("phase") == "warmup":
                continue
            want += (r["end"] - r["start"]) * fps
        got += len(pts)

    # Speed and speed-CHANGE measured over the SAME ~0.1s baseline that
    # find_contacts uses, so the numbers are directly comparable to dv_thr
    # and cos_thr rather than to frame-to-frame noise.
    WIN = 0.1
    STATIC = 20.0     # px/s over 0.1s - below this the "ball" is not moving
    samples = []      # (speed, dspeed|None, cos|None)
    for pts in ball:
        T = [p[0] for p in pts]
        n = len(pts)

        def vel(i, j):
            dt = T[j] - T[i]
            if dt <= 0:
                return None
            return ((pts[j][1] - pts[i][1]) / dt, (pts[j][2] - pts[i][2]) / dt)

        for i in range(n):
            f = i
            while f < n - 1 and T[f] - T[i] < WIN:
                f += 1
            if T[f] - T[i] < WIN or T[f] - T[i] > 3 * WIN:
                continue
            v = vel(i, f)
            if not v:
                continue
            sp = math.hypot(*v)
            b = i
            while b > 0 and T[i] - T[b] < WIN:
                b -= 1
            v1 = vel(b, i) if (WIN <= T[i] - T[b] <= 3 * WIN) else None
            if not v1:
                samples.append((sp, None, None))
                continue
            s1, s2 = math.hypot(*v1), sp
            cs = ((v1[0]*v[0] + v1[1]*v[1]) / (s1 * s2)) if (s1 > 1 and s2 > 1) else None
            samples.append((sp, abs(s2 - s1), cs))

    m["ball_fps"] = fps
    m["ball_coverage_pct"] = (100 * got / want) if want else None
    # Static contamination: a fixed round object (ceiling light, wall sign,
    # spare ball on the sideline) detected as the ball sits at ~0 px/s. It
    # drags the median to nothing and randomises the direction test, so it
    # must be measured and excluded before any threshold is repriced.
    # Measured on cca-two: its known spare-ball problem shows up here as a
    # ~2 px/s median, versus ~125 px/s on the cleaner cca-one.
    m["ball_static_pct"] = (100 * sum(s[0] < STATIC for s in samples)
                            / len(samples)) if samples else None
    mv = [s for s in samples if s[0] >= STATIC]      # moving samples only
    speeds = [s[0] for s in mv]
    dspeeds = [s[1] for s in mv if s[1] is not None]
    coss = [s[2] for s in mv if s[2] is not None]
    m["ball_speed_med"] = median(speeds) if speeds else None
    m["ball_speed_p90"] = pct(speeds, 90)
    m["ball_dspeed_med"] = median(dspeeds) if dspeeds else None
    m["ball_dspeed_p90"] = pct(dspeeds, 90)
    # What fraction of MOVING samples each current rule would fire on. Not a
    # phantom rate on its own, but if these move sharply against the reference
    # the thresholds no longer mean what they meant on the old camera.
    m["trip_dv_pct"] = (100 * sum(d > CONST["dv_thr"] for d in dspeeds)
                        / len(dspeeds)) if dspeeds else None
    m["trip_cos_pct"] = (100 * sum(c < 0.55 for c in coss) / len(coss)) if coss else None
    ngame = sum(1 for r in rallies if r.get("phase") != "warmup") or len(rallies)
    m["contacts_per_rally"] = (sum(len(r.get("contacts", [])) for r in rallies)
                               / ngame) if ngame else None

    # --- identity separation (label-free) --------------------------------
    # Tracklets that OVERLAP IN TIME cannot be the same person. So their
    # embedding distances are known negatives, with zero human labelling -
    # and any of them below cluster_thresh is a merge the clusterer is at
    # risk of making. This is a one-sided diagnostic: it bounds false merges
    # but says nothing about whether same-person tracklets are close enough.
    # The full AUC needs crops + GPU, or review labels.
    negs = []
    byr = defaultdict(list)
    for tr in trs:
        if tr.get("emb"):
            byr[tr["rally"]].append(tr)
    for rt in byr.values():
        for i in range(len(rt)):
            for j in range(i + 1, len(rt)):
                a, b = rt[i], rt[j]
                if a["t1"] < b["t0"] - 0.2 or b["t1"] < a["t0"] - 0.2:
                    continue            # not simultaneous: could be one person
                u, v = a["emb"], b["emb"]
                dot = sum(x * y for x, y in zip(u, v))
                nu = math.sqrt(sum(x * x for x in u))
                nv = math.sqrt(sum(x * x for x in v))
                negs.append(1 - dot / (nu * nv + 1e-9))
    m["neg_dist_med"] = median(negs) if negs else None
    m["neg_dist_p05"] = pct(negs, 5)
    m["neg_under_thresh_pct"] = (100 * sum(d < CONST["cluster_thresh"] for d in negs)
                                 / len(negs)) if negs else None
    m["n_neg_pairs"] = len(negs)
    return m


# -------------------------------------------------------------------- report

def report(m, ref=None):
    r = ref or {}
    g = lambda k: r.get(k) if ref else None

    print("\n=== provenance ===")
    if m["stamp"]:
        s = m["stamp"]
        print(f"  vbpipe {s.get('vbpipe_version')}   stages: {list(s.get('stages', {}))}")
        pl = s.get("stages", {}).get("plays", {}).get("params", {})
        if pl:
            print(f"  ball: {pl.get('ball_source')}  fps={pl.get('ball_fps')}  "
                  f"pose={pl.get('pose_model')}  wrist_max={pl.get('wrist_max')}")
    else:
        print("  UNSTAMPED (pre-1.0.0 bundle) - evaluation-only labels")

    print("\n=== player scale (drives every px constant) ===")
    line("median tracked box height", m["box_h_med"], g("box_h_med"))
    line("  near court", m["box_h_near_med"], g("box_h_near_med"))
    line("  far court", m["box_h_far_med"], g("box_h_far_med"))
    line("5th pct box height", m["box_h_p05"], g("box_h_p05"))
    line(f"% boxes below min_box_h_px={CONST['min_box_h_px']}",
         m["box_below_gate_pct"], g("box_below_gate_pct"))

    print("\n=== tracking coverage (health check) ===")
    line("median concurrent tracked players", m["concurrent_med"], g("concurrent_med"))
    line("tracklets per rally", m["tracklets_per_rally"], g("tracklets_per_rally"))
    line("median tracklet duration (s)", m["tracklet_dur_med"], g("tracklet_dur_med"))
    if m["concurrent_med"] is not None and m["concurrent_med"] < 9:
        print("  !! below ~9 of 12 - suspect the court polygon or det_conf for this camera")

    print("\n=== attribution geometry ===")
    line("median inter-player spacing", m["spacing_med"], g("spacing_med"))
    line("10th pct spacing (tightest)", m["spacing_p10"], g("spacing_p10"))
    line(f"contact->nearest player (n={m['n_contacts']})", m["contact_d_med"], g("contact_d_med"))
    line("  p75", m["contact_d_p75"], g("contact_d_p75"))
    line("  p95", m["contact_d_p95"], g("contact_d_p95"))
    line("raw dx at contact", m["contact_dx_med"], g("contact_dx_med"))
    line("raw dy at contact", m["contact_dy_med"], g("contact_dy_med"))
    # The 0.6 y-weight exists because a given real distance spans fewer
    # vertical than horizontal pixels under perspective - so it is purely a
    # camera property, and raising the camera changes it. Rather than guess an
    # absolute value, hold the vertical term's RELATIVE contribution fixed at
    # whatever was tuned on the reference camera.
    if m["contact_dx_med"] and m["contact_dy_med"]:
        ratio = m["contact_dy_med"] / m["contact_dx_med"]
        print(f"  dy/dx at contact: {ratio:.2f}", end="")
        if ref and r.get("contact_dx_med") and r.get("contact_dy_med"):
            rratio = r["contact_dy_med"] / r["contact_dx_med"]
            print(f"   (ref {rratio:.2f})")
            print(f"  y-weight preserving the reference's vertical weighting: "
                  f"{CONST['y_weight'] * rratio / ratio:.2f}"
                  f"   (currently {CONST['y_weight']})")
        else:
            print("   (pass --ref to price the y-weight)")

    print("\n=== wrist (pose) ===")
    if m["n_wrist_contacts"]:
        line(f"ball->nearest wrist (n={m['n_wrist_contacts']})", m["wrist_med"], g("wrist_med"))
        line("  p75", m["wrist_p75"], g("wrist_p75"))
    else:
        print("  pose did not run - re-run the pilot with --pose-model to price wrist_max")

    print("\n=== ball (speeds over the same 0.1s window find_contacts uses) ===")
    line("sampling fps", m["ball_fps"], g("ball_fps"))
    line("% of frames with a ball point", m["ball_coverage_pct"], g("ball_coverage_pct"))
    line("% STATIC (fixed object, not the ball)", m["ball_static_pct"], g("ball_static_pct"))
    if m["ball_static_pct"] and m["ball_static_pct"] > 25:
        print("  !! heavy static contamination - a light/sign/spare ball is being")
        print("     tracked as the game ball. Fix that before repricing anything.")
    line("median speed (px/s)", m["ball_speed_med"], g("ball_speed_med"), 0)
    line("p90 speed", m["ball_speed_p90"], g("ball_speed_p90"), 0)
    line("median |speed change|", m["ball_dspeed_med"], g("ball_dspeed_med"), 0)
    line("p90 |speed change|", m["ball_dspeed_p90"], g("ball_dspeed_p90"), 0)
    line(f"% samples tripping dv_thr={CONST['dv_thr']}", m["trip_dv_pct"], g("trip_dv_pct"))
    line("% samples tripping cos_thr=0.55", m["trip_cos_pct"], g("trip_cos_pct"))
    line("contacts detected per game rally", m["contacts_per_rally"], g("contacts_per_rally"))

    print("\n=== identity separation (label-free, one-sided) ===")
    if m["n_neg_pairs"]:
        line(f"known-different pair distance (n={m['n_neg_pairs']})",
             m["neg_dist_med"], g("neg_dist_med"), 3)
        line("  5th pct (closest confusions)", m["neg_dist_p05"], g("neg_dist_p05"), 3)
        line(f"% under cluster_thresh={CONST['cluster_thresh']} (false-merge risk)",
             m["neg_under_thresh_pct"], g("neg_under_thresh_pct"), 1)
        print("  (lower % = better separation. Does NOT prove same-person")
        print("   tracklets are close enough - that needs review labels.)")
    else:
        print("  no embeddings in this game.json - run the 'full' stage first")

    # ---- rescaled constants -------------------------------------------
    if ref and m["box_h_med"] and r.get("box_h_med"):
        s = m["box_h_med"] / r["box_h_med"]
        print(f"\n=== suggested rescale (scale factor {s:.2f}x from player height) ===")
        print("  Starting points, NOT answers - confirm each against the")
        print("  distributions above and the model-view overlay.\n")
        for k in ("min_box_h_px", "gate", "drop", "dv_thr", "wrist_max",
                  "ball_max_dim", "max_speed", "court_margin_px"):
            print(f"  {k:<20} {CONST[k]:>7}  ->  {CONST[k]*s:>7.0f}")
        if m["spacing_med"]:
            half = m["spacing_med"] / 2
            print(f"\n  sanity: gate should sit well under half the median")
            print(f"  inter-player spacing = {half:.0f}px. "
                  f"Rescaled gate is {CONST['gate']*s:.0f}px "
                  f"({'OK' if CONST['gate']*s < half else 'TOO WIDE - attribution will guess'}).")
    elif not ref:
        print("\n  (pass --ref OLD/game.json for a side-by-side and rescaled constants)")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("game", help="game.json from the new camera")
    ap.add_argument("--ref", help="game.json from the old camera, for comparison")
    a = ap.parse_args()
    m = measure(json.load(open(a.game)))
    ref = measure(json.load(open(a.ref))) if a.ref else None
    report(m, ref)
    print()


if __name__ == "__main__":
    main()
