"""Render a rally as a YouTube Short: 1080x1920 vertical, ball-following crop.

WHY THIS EXISTS
The footage is a wide 16:9 side angle. Shorts want 9:16. The two usual
answers are both bad: a blurred letterbox shrinks the players to specks on a
phone, and a fixed centre crop throws away half the court.

The third answer needs to know where the action is — and we already do.
`game.json` carries a per-frame ball track (`ball[rally] = [[t,x,y,conf],...]`)
that the scoring pipeline computed anyway. So the crop window just follows the
ball. Generic auto-crop tools guess where to look; we know.

THE CAMERA MODEL (the part that makes it not look like a bug)
Pointing the crop straight at the ball's detected x looks awful — the
detection jitters a few px per frame, the ball snaps across the net at 60
km/h, and the result induces motion sickness. A human camera operator does
three things instead, and so does this:

  1. IGNORES small movements   — a deadband: no pan until the ball drifts
                                 meaningfully off centre.
  2. ACCELERATES SMOOTHLY      — a critically-damped spring, not a jump cut.
  3. LAGS THE ACTION SLIGHTLY  — a consequence of (2), and it reads as
                                 natural rather than psychic.

The result is a slow pan that settles during a rally exchange and swings
across on a big transition, which is what a real operator does.

Coordinates in game.json are the 1280x720 reference space (see overlay.py).
"""
import json
import os
import subprocess

import numpy as np

REF_W, REF_H = 1280, 720
OUT_W, OUT_H = 1080, 1920          # the Shorts spec: 9:16 at 1080p


def _probe(video, entry, stream="v:0"):
    return subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", stream,
         "-show_entries", f"stream={entry}", "-of", "csv=p=0", video],
        capture_output=True, text=True).stdout.strip()


def static_spots(game, cell=40, frac=0.06, std_max=4.0, radius=30.0, _cache={}):
    """Grid cells that hold a FIXED OBJECT the ball detector fires on.

    STATUS.md documents this at length: the trained ball model false-positives
    on round bright things — a ceiling light, a wall sign, a corner
    scoreboard. In the cca-one game.json shipped in this repo, 49% of all ball
    detections are one such impostor parked at the frame's left edge.

    The renderer cannot assume it will only ever be handed clean tracks —
    those files exist on disk today and the fix landed later — and one
    impostor is enough to whip the camera to the sideline and hold it there.

    Detection copies the pipeline's own gate (balltrain.global_static_cells):
    a cell that is busy AND has near-zero positional variance is furniture,
    not a ball. The variance test is the load-bearing half — busy alone would
    flag centre court, where the ball genuinely spends its time but scatters
    across the cell instead of sitting at one point.

    Computed once per game (the whole track, not one rally) and cached: a
    single rally may be too short to tell "parked" from "briefly still".

    The grid is only a way to FIND candidates, never the answer: an object
    sitting on a cell boundary splits across two cells and hides from a
    plain grid test (it did, on this repo's cca-one — the light at x=43 fell
    either side of the 40px line). So each busy cell is reduced to a
    centroid, the test is re-run on everything within `radius` of it, and
    what's returned is a list of (x, y) centroids to suppress around.

    Returns (spots, radius) where spots is an (n,2) array — possibly empty.
    """
    key = id(game)
    if key in _cache:
        return _cache[key]
    pts = np.array([p for ps in game.get("ball", []) for p in ps], float) \
        if game.get("ball") else np.zeros((0, 4))
    spots = []
    if len(pts) >= 50:
        need = max(12, frac * len(pts))
        seen = []
        # two half-offset grids, so a blob straddling one grid's line is
        # comfortably interior to the other
        for off in (0.0, cell / 2.0):
            keys = (((pts[:, 1] + off) // cell).astype(np.int64) * 10_000
                    + ((pts[:, 2] + off) // cell).astype(np.int64))
            for k in np.unique(keys):
                m = keys == k
                if m.sum() < need:
                    continue
                cx, cy = pts[m, 1].mean(), pts[m, 2].mean()
                if any(abs(cx - sx) < radius and abs(cy - sy) < radius
                       for sx, sy in seen):
                    continue                    # already covered by a spot
                near = ((np.abs(pts[:, 1] - cx) < radius)
                        & (np.abs(pts[:, 2] - cy) < radius))
                if near.sum() < need:
                    continue
                # THE load-bearing test: busy AND motionless = furniture.
                # Busy alone would flag centre court, where the ball really
                # does spend its time — but scattered, not parked.
                if pts[near, 1].std() < std_max and pts[near, 2].std() < std_max:
                    seen.append((cx, cy))
                    spots.append((cx, cy))
    _cache[key] = (np.array(spots, float).reshape(-1, 2), radius)
    return _cache[key]


def ball_path(game, t0, t1, fps, min_conf=0.25, smooth_s=0.75, drop_static=True,
              axis=1, default=None):
    """Ball position on one axis (axis=1 x, axis=2 y), in REF coordinates,
    resampled onto the output frame grid.

    Returns (n_frames,) array. Never NaN — gaps are filled, because the
    camera has to point somewhere on every single frame.

    The four cleanup steps, in order and each for a different failure:
      static cells drops fixed objects the detector mistakes for the ball
                   (see static_cells) — sustained, so nothing downstream
                   would catch them
      conf gate    drops the detector's low-confidence guesses
      median-5     kills single-frame teleports — one stray sample would
                   otherwise whip the camera across the court
      moving mean  turns a valid but twitchy track into a pannable target
    """
    spots, radius = static_spots(game) if drop_static else (np.zeros((0, 2)), 0)

    def ok(p):
        if p[3] < min_conf:
            return False
        return not len(spots) or not np.any(
            (np.abs(spots[:, 0] - p[1]) < radius) & (np.abs(spots[:, 1] - p[2]) < radius))

    pts = [p for pts in game.get("ball", []) for p in pts
           if t0 <= p[0] <= t1 and ok(p)]
    n = max(1, int(round((t1 - t0) * fps)))
    grid = t0 + np.arange(n) / fps
    if len(pts) < 2:                            # no track: hold a sane default
        return np.full(n, default if default is not None else REF_W / 2.0)

    a = np.array(pts, float)
    a = a[np.argsort(a[:, 0])]
    t, x = a[:, 0], a[:, axis]

    # median-5 spike rejection (odd window, so it's a true median)
    if len(x) >= 5:
        k = 5
        pad = np.pad(x, (k // 2, k // 2), mode="edge")
        x = np.median(np.stack([pad[i:i + len(x)] for i in range(k)]), axis=0)

    # resample onto the frame grid; np.interp holds the endpoints across gaps,
    # which is exactly the "keep pointing where the ball was" behaviour we want
    xs = np.interp(grid, t, x)

    # moving average — window in frames, forced odd so it doesn't shift phase
    w = max(1, int(round(smooth_s * fps)) | 1)
    if w > 1 and n > w:
        pad = np.pad(xs, (w // 2, w // 2), mode="edge")
        xs = np.convolve(pad, np.ones(w) / w, mode="valid")[:n]
    return xs


def player_envelope(game, t0, t1, fps, pad=90.0):
    """Per-frame x-range the tracked players occupy, in REF_W units.

    THE GUARD RAIL. Following the ball is right when the ball track is right,
    and catastrophic when it isn't: a ceiling light detected as the ball drags
    the frame off to a blank wall and holds it there for seconds. static_spots
    catches the perfectly motionless impostors, but a light that flickers
    across a few pixels evades a variance gate — and on this footage that is
    41% of some rallies' detections.

    Rather than chase every way a ball detection can lie, assert the thing
    that's actually true of a highlight: THE PLAYERS ARE IN IT. Volleyball
    happens where the people are. So the camera may follow the ball anywhere
    inside the region the players occupy (plus a margin for the ball genuinely
    travelling ahead of them) and no further.

    Returns (xlo, xhi, ytop, ybot), each length n. Where nothing is tracked
    the frame is left unconstrained — better a loose frame than one clamped
    by data we don't have.
    """
    n = max(1, int(round((t1 - t0) * fps)))
    xlo, xhi = np.zeros(n), np.full(n, float(REF_W))
    ytop, ybot = np.zeros(n), np.full(n, float(REF_H))
    seen = np.zeros(n, bool)
    for tr in game.get("tracklets", []):
        if tr.get("t1", 0) < t0 or tr.get("t0", 1e9) > t1:
            continue
        for b in tr.get("boxes", []):
            if not (t0 <= b[0] <= t1):
                continue
            i = min(n - 1, max(0, int(round((b[0] - t0) * fps))))
            cx = b[1] + b[3] / 2.0
            if seen[i]:
                xlo[i], xhi[i] = min(xlo[i], cx), max(xhi[i], cx)
                ytop[i], ybot[i] = min(ytop[i], b[2]), max(ybot[i], b[2] + b[4])
            else:
                xlo[i] = xhi[i] = cx
                ytop[i], ybot[i] = b[2], b[2] + b[4]
                seen[i] = True
    if not seen.any():
        return xlo, xhi, ytop, ybot
    # carry the last known envelope across frames with no boxes, so a
    # one-frame tracking dropout doesn't briefly unclamp the camera
    idx = np.where(seen, np.arange(n), 0)
    np.maximum.accumulate(idx, out=idx)
    xlo, xhi, ytop, ybot = xlo[idx], xhi[idx], ytop[idx], ybot[idx]
    first = int(np.argmax(seen))
    for a in (xlo, xhi, ytop, ybot):
        a[:first] = a[first]
    return xlo - pad, xhi + pad, ytop, ybot


def action_band(game, t0, t1, fallback=(400.0, 470.0)):
    """Where the players are, vertically, in REF_H units: (centre, spread).

    A gym filmed from the side is mostly ceiling. On this repo's cca-one the
    numbers are stark: player box centres sit at y 390-510 of 720, and the
    ball's median y is 287 — so the top third of every frame is roof and the
    bottom sixth is empty floor. Cropping full-height for a 9:16 Short spends
    more than half the vertical budget on architecture.

    The tracked player boxes say where to look instead. Median rather than
    mean: one tracklet stuck on a spectator in the bleachers shouldn't drag
    the camera into the stands.
    """
    ys = [b[2] + b[4] / 2.0
          for tr in game.get("tracklets", [])
          if tr.get("t1", 0) >= t0 and tr.get("t0", 1e9) <= t1
          for b in tr.get("boxes", []) if t0 <= b[0] <= t1]
    if len(ys) < 20:
        return fallback
    ys = np.array(ys)
    return float(np.median(ys)), float(np.percentile(ys, 90))


def lookahead(path, fps, seconds=0.15):
    """Shift a target path forward in time so the camera ANTICIPATES.

    A spring-follow camera is reactive: it can only chase an error that has
    already happened, so it permanently trails the ball and loses it exactly
    when the ball is fastest — the attack, which is the shot the clip exists
    for. Raising the speed limit shortens the lag but can't remove it.

    But this is an offline render of a file we've already got. The ball's
    future position is sitting right there in the array. A human operator
    can't see the future; we can, so the camera can be aiming where the ball
    is ABOUT to be. This buys more than any amount of extra speed, and
    without the twitchiness that cranking the gain would bring.
    """
    k = int(round(seconds * fps))
    if k <= 0 or k >= len(path):
        return path
    return np.concatenate([path[k:], np.full(k, path[-1])])


def camera_path(target_x, fps, crop_w_ref, deadband_frac=0.07,
                max_speed_ref=1600.0, stiffness=6.0):
    """Turn a ball track into a camera track (see "the camera model" above).

    target_x     where the ball is, per frame, in REF_W units
    crop_w_ref   the crop's width in REF_W units (sets the deadband scale)
    deadband     fraction of the crop half-width the ball may wander inside
                 before the camera reacts at all
    max_speed    REF_W units/second — a whip-pan ceiling, so a detector
                 glitch that survived cleanup still can't fling the frame
    stiffness    spring constant; higher = tighter follow, lower = lazier

    Defaults come from measuring this footage: the ball's horizontal speed
    runs p50 148, p90 615, p95 876, p99 1299 ref units/s. The first cap of
    420 was beaten 19% of the time; 1000 still lost the ball on attacks. 1600
    clears p99, so the limit now only catches genuine detector glitches
    rather than routinely clipping real play — which is what a safety limit
    should do. Paired with lookahead(), which removes the lag itself.
    """
    dead = deadband_frac * crop_w_ref / 2.0
    dt = 1.0 / fps
    cam = np.empty_like(target_x)
    # start already on target: no opening lurch from frame centre
    pos = float(target_x[0])
    for i, tgt in enumerate(target_x):
        err = tgt - pos
        if abs(err) <= dead:
            err = 0.0                       # inside the deadband: hold still
        else:
            err -= np.sign(err) * dead      # move relative to the deadband edge
        step = np.clip(err * stiffness * dt, -max_speed_ref * dt, max_speed_ref * dt)
        pos += step
        cam[i] = pos
    return cam


def moment_window(rally_obj, anchor_t, lead_touches=4, tail_s=2.5,
                  head_s=1.0, pad=(1.5, 1.5), contacts=None, bounds=None):
    """The clip window around a MOMENT — a kill, a dig, a block — rather than
    around a whole rally.

    Rationale (Ken's, and it's the right call): the unit people share is "my
    kill", not "a rally". A 30-second rally buries the moment it's supposedly
    about, and nobody sends a teammate a clip saying "you're at 0:24".

    Lead-in is counted in TOUCHES, not seconds, because touch density varies
    enormously — 4 touches can be 3 seconds of frantic scramble or 10 of
    loopy free balls, and it's the touches that make the play legible. Four
    is the natural unit for a kill: dig -> set -> attack, plus the opposing
    attack that forced the dig. That's the whole exchange.

    `contacts` / `bounds` override what's in game.json, and the caller should
    almost always supply them. game.json is RAW PIPELINE OUTPUT: on this
    footage 45% of its contacts are phantoms the reviewer later deleted, and
    some rallies were added by hand afterwards and aren't in it at all.
    Counting "4 touches back" through a list that's nearly half junk lands
    somewhere arbitrary. The reviewed database is the truth about touches;
    game.json remains the truth only about ball and player tracking, which
    has no corrected counterpart.

    Returns (t0, t1), clamped to the rally plus its usual pad.
    """
    cs = sorted(contacts) if contacts else sorted(
        c["t"] for c in rally_obj.get("contacts", []) if c.get("t") is not None)
    r0, r1 = bounds if bounds else (rally_obj["start"], rally_obj["end"])
    lo_bound = r0 - pad[0]
    hi_bound = r1 + pad[1]

    before = [t for t in cs if t < anchor_t - 0.05]
    # the Nth touch back, or the earliest we have if the rally is shorter
    start_touch = before[-lead_touches] if len(before) >= lead_touches else (
        before[0] if before else anchor_t)
    t0 = max(lo_bound, start_touch - head_s)

    # End on the moment's consequence: the ball landing, the celebration. If
    # the rally continues past the anchor, stop shortly after rather than
    # running on into play this clip isn't about.
    after = [t for t in cs if t > anchor_t + 0.05]
    t1 = min(hi_bound, (min(after[0] + 1.5, anchor_t + tail_s) if after
                        else anchor_t + tail_s))
    if t1 - t0 < 3.0:                      # never emit a clip too short to read
        t1 = min(hi_bound, t0 + 3.0)
    return t0, t1


def reaction_target(anchor_x, ball_after=None):
    """Where to point once the play is over: the side that just scored.

    Ken spotted this in a clip where it happened by accident — after the kill
    the crop swung back to the scoring team and caught them celebrating, and
    it was the best moment in the clip. The accident isn't repeatable (the
    camera was following the ball being retrieved, which only happened to go
    that way), but the intent is, because we already know which side scored:
    the attacker's own contact position.

    Broadcast does exactly this. The point isn't over when the ball lands,
    it's over when you've seen someone react to it.
    """
    return anchor_x


def render_short(video, game, out, rally=None, t0=None, t1=None, fps=30,
                 zoom=1.0, vfill=0.70, caption=None, subcaption=None,
                 pad=(1.5, 1.5), tight=True, anchor_t=None, lead_touches=4,
                 contacts=None, bounds=None, look_s=0.15,
                 reaction_x=None, reaction_after=1.8, reaction_tail=4.6,
                 follow=1.0, min_conf=0.25, crf=20, preset="medium",
                 debug=False, dry_run=False):
    """Render one rally of `video` as a 1080x1920 Short.

    rally      index into game['rallies']; or pass t0/t1 directly
    vfill      fraction of the source HEIGHT the crop uses. Not 1.0, and
               that's the single most important setting here: a full-height
               crop of a side-angle gym shot is ~55% ceiling and bare wall
               (see action_band). 0.70 trims the roof and the empty floor,
               costing some upscale softness and buying a frame that's
               actually about volleyball.
    zoom       1.0 = the crop is exactly 9:16, action edge to edge. <1.0
               crops WIDER and letterboxes it over a blurred backdrop — less
               punch, more court context. 0.7 shows a play developing.
    caption    burned-in headline, e.g. "KILL - Ken"
    pad        (before, after) seconds around the rally — the outer bound
    tight      trim to the first/last CONTACT rather than the rally bounds,
               so the clip opens on the serve instead of on people walking.
               The single biggest difference between a Short someone watches
               and one they swipe past. False keeps the full rally window.
    dry_run    compute and return the camera paths without encoding

    Returns the output path (or the path data when dry_run).
    """
    if rally is not None and anchor_t is not None:
        # MOMENT mode: the clip is about one play, with a few touches of
        # run-up. See moment_window.
        # a reaction beat needs room to breathe, so the tail runs longer
        w = moment_window(game["rallies"][rally], anchor_t,
                          lead_touches=lead_touches, pad=pad,
                          tail_s=reaction_tail if reaction_x is not None else 2.5,
                          contacts=contacts, bounds=bounds)
        t0 = w[0] if t0 is None else t0
        t1 = w[1] if t1 is None else t1
    elif rally is not None:
        r = game["rallies"][rally]
        # Trim to the ACTION, not the rally.
        #
        # Rally detection brackets generously — it has to, or it would clip
        # serves. Fine for review (you want the run-up) and fatal for a Short,
        # where four seconds of players ambling to position loses the viewer
        # before anything happens. The contacts say when the ball was actually
        # in play, so use those and keep the rally bounds only as a backstop.
        cs = list(contacts) if contacts else [
            c["t"] for c in r.get("contacts", []) if c.get("t") is not None]
        rs, re_ = bounds if bounds else (r["start"], r["end"])
        if tight and cs:
            lo = max(rs - pad[0], min(cs) - 1.5)
            # a beat after the last touch for the ball landing and the reaction
            hi = min(re_ + pad[1], max(cs) + 2.5)
            if hi - lo >= 3.0:                 # don't trim into uselessness
                t0 = lo if t0 is None else t0
                t1 = hi if t1 is None else t1
        t0 = rs - pad[0] if t0 is None else t0
        t1 = re_ + pad[1] if t1 is None else t1
    if t0 is None or t1 is None:
        raise ValueError("pass rally= or both t0=/t1=")
    t0 = max(0.0, float(t0))
    t1 = float(t1)

    src_w = int(_probe(video, "width") or 1920)
    src_h = int(_probe(video, "height") or 1080)
    sx, sy = src_w / REF_W, src_h / REF_H     # ref space -> source pixels

    # Crop geometry: height first (vfill trims roof and floor), then width
    # from the 9:16 target, widened by 1/zoom when context is wanted.
    crop_h = int(round(src_h * min(max(vfill, 0.3), 1.0))) // 2 * 2
    crop_w = int(round(min(src_w, crop_h * (OUT_W / OUT_H) / max(zoom, 0.2))))
    crop_w -= crop_w % 2                      # H.264 wants even dimensions
    crop_w_ref, crop_h_ref = crop_w / sx, crop_h / sy

    n = max(1, int(round((t1 - t0) * fps)))
    tgt = ball_path(game, t0, t1, fps, min_conf=min_conf)
    # Constrain the ball target to the region the players occupy BEFORE the
    # camera smoothing, not after: clamping the camera afterwards would still
    # let it accelerate toward a phantom and slam into the limit. Clamping the
    # target means the camera never starts the journey.
    plo, phi, ptop, pbot = player_envelope(game, t0, t1, fps)
    tgt = np.clip(tgt, np.minimum(plo, phi), np.maximum(plo, phi))

    # THE REACTION BEAT. Once the ball is down, stop tracking it — it's just
    # being retrieved — and swing back to the side that scored. Retargeting
    # rather than cutting means the existing spring does the move, so it
    # reads as a camera operator turning to catch the celebration.
    if reaction_x is not None and anchor_t is not None:
        i0 = int(round((anchor_t + reaction_after - t0) * fps))
        if 0 <= i0 < n:
            tgt[i0:] = float(reaction_x)
    # `follow` is the one dial for "chase the ball harder / lazier" — it
    # scales both how fast the camera may move and how hard it accelerates,
    # so feedback like "more aggressive" is a single number.
    cam = camera_path(lookahead(tgt, fps, look_s), fps, crop_w_ref,
                      max_speed_ref=1600.0 * follow, stiffness=6.0 * follow)

    # Vertical. The ball goes high and the players don't, so pointing at the
    # ball alone would stare at the roof on every set. Anchor on the players
    # and let the ball pull the frame up a little — a real operator tilts up
    # for the spike but keeps the court in shot. The deadband is much wider
    # than the horizontal one because vertical camera movement reads as
    # nervous far sooner than a horizontal pan does.
    anchor, _ = action_band(game, t0, t1)
    ball_y = ball_path(game, t0, t1, fps, min_conf=min_conf, smooth_s=1.4,
                       axis=2, default=anchor)
    # Weighted toward the players, but enough ball in the mix that the
    # resting frame sits ABOVE the feet — the ball spends its life over the
    # court, so a frame centred on the players wastes its bottom third on
    # varnish. Empirically on cca-one this puts the rest position ~370 of
    # 720, holding both the player band and the top of a normal set.
    tgt_y = 0.55 * anchor + 0.45 * ball_y
    # Same guard rail vertically, and it matters more here: a phantom ball up
    # among the ceiling lights tilts the frame into bare roof, which looks far
    # worse than a horizontal miss because there is nothing up there at all.
    # The crop (≈504 ref units tall) comfortably exceeds the players' own
    # extent (≈200), so requiring it to contain them still leaves plenty of
    # slack to follow a genuinely high ball.
    keep_lo = pbot - crop_h_ref / 2      # low enough to keep feet in frame
    keep_hi = ptop + crop_h_ref / 2      # high enough to keep heads in frame
    tgt_y = np.clip(tgt_y, np.minimum(keep_lo, keep_hi),
                    np.maximum(keep_lo, keep_hi))
    cam_y = camera_path(tgt_y, fps, crop_h_ref, deadband_frac=0.15,
                        max_speed_ref=160.0, stiffness=1.6)

    # Clamp so the crop never runs off the source frame. Clamping the CENTRE
    # (not the raw ball) is what keeps the pan smooth at the edges: the
    # camera glides to the limit and stops, instead of the crop being
    # silently truncated mid-pan.
    cam = np.clip(cam, crop_w_ref / 2, REF_W - crop_w_ref / 2)
    cam_y = np.clip(cam_y, crop_h_ref / 2, REF_H - crop_h_ref / 2)
    left = np.clip((cam * sx - crop_w / 2).astype(int), 0, src_w - crop_w)
    top = np.clip((cam_y * sy - crop_h / 2).astype(int), 0, src_h - crop_h)
    if dry_run:
        return {"n_frames": n, "crop_w": crop_w, "crop_h": crop_h,
                "left_px": left, "top_px": top, "anchor_y": anchor,
                "target_ref": tgt, "cam_ref": cam, "cam_y_ref": cam_y}

    import cv2

    # Contacts overlapping this window, for the debug overlay. Pulled from
    # every rally, not just the anchor's, so a touch the pipeline assigned to
    # a neighbouring rally still shows up — that misassignment is exactly the
    # kind of thing this overlay exists to expose.
    if not debug:
        dbg_contacts = []
    elif contacts:
        # reviewed touches — what the window was actually computed from
        dbg_contacts = [(t, "touch", None) for t in sorted(contacts)
                        if t0 - 0.5 <= t <= t1 + 0.5]
    else:
        dbg_contacts = sorted(
            ((c["t"], c.get("play") or "?", c.get("cluster"))
             for rr in game.get("rallies", []) for c in rr.get("contacts", [])
             if c.get("t") is not None and t0 - 0.5 <= c["t"] <= t1 + 0.5),
            key=lambda c: c[0])

    # scale the cropped strip to fill the 1080-wide output. When zoom<1 the
    # strip is wider than 9:16, so it lands as a letterboxed band and the rest
    # of the frame gets a blurred, scaled copy of the same footage — dark
    # bars read as a mistake, a blurred backdrop reads as a design choice.
    band_h = int(round(OUT_W * crop_h / crop_w)) // 2 * 2
    band_y = max(0, (OUT_H - band_h) // 2)

    # Reader stderr goes to a TEMP FILE, never a pipe.
    #
    # A pipe here deadlocks: nothing drains it during the render loop, so once
    # ffmpeg's decode warnings exceed the 64 KB pipe buffer it blocks writing
    # to stderr, stops producing frames, and we block forever waiting for
    # them. Seeking into some points of a long H.264 file emits plenty of
    # those warnings, so it renders fine from one timestamp and hangs from
    # another — which is exactly as fun to debug as it sounds.
    #
    # A file has no such limit, and we still get the message text for the
    # error path. (We can't simply inherit stderr: ffmpeg always logs a broken
    # pipe when we stop reading early, and that noise would drown real errors.)
    import tempfile
    rd_log = tempfile.TemporaryFile()
    rd = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-ss", f"{t0:.3f}", "-t", f"{t1 - t0:.3f}",
         "-i", video, "-vf", f"fps={fps}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE, stderr=rd_log,
        bufsize=src_w * src_h * 3 * 2)

    tmp = out + ".silent.mp4"
    wr = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", f"{OUT_W}x{OUT_H}", "-r", str(fps), "-i", "-",
         "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp],
        stdin=subprocess.PIPE)

    nbytes = src_w * src_h * 3
    written = 0
    try:
        for i in range(n):
            buf = rd.stdout.read(nbytes)
            if len(buf) < nbytes:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(src_h, src_w, 3)
            j = min(i, len(left) - 1)
            x, y = int(left[j]), int(top[j])
            strip = frame[y:y + crop_h, x:x + crop_w]

            if band_h >= OUT_H:                       # exact 9:16, no backdrop
                canvas = cv2.resize(strip, (OUT_W, OUT_H),
                                    interpolation=cv2.INTER_LANCZOS4)
            else:
                # Backdrop: the same strip blown up to cover, then blurred and
                # darkened so it never competes with the action.
                #
                # Blur a 1/6-scale copy and upscale, rather than blurring at
                # full resolution. A sigma-24 Gaussian destroys everything
                # finer than itself anyway, so the results are visually
                # identical — but full-res costs 92 ms/frame against 3 ms, or
                # nearly a minute of pure blur on a 20-second clip. That's the
                # difference between a usable and an unusable setting on a
                # 2-vCPU droplet.
                cover = cv2.resize(strip, (int(OUT_H * crop_w / crop_h), OUT_H),
                                   interpolation=cv2.INTER_LINEAR)
                ox = max(0, (cover.shape[1] - OUT_W) // 2)
                small = cv2.resize(cover[:, ox:ox + OUT_W], (OUT_W // 6, OUT_H // 6),
                                   interpolation=cv2.INTER_AREA)
                canvas = cv2.resize(cv2.GaussianBlur(small, (0, 0), 4),
                                    (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR)
                canvas = (canvas * 0.55).astype(np.uint8)
                band = cv2.resize(strip, (OUT_W, band_h),
                                  interpolation=cv2.INTER_LANCZOS4)
                canvas[band_y:band_y + band_h] = band

            if caption:
                _draw_caption(cv2, canvas, caption, subcaption, band_y, band_h)
            if debug:
                _draw_debug(cv2, canvas, t0 + i / fps, t0, t1, dbg_contacts,
                            anchor_t)
            wr.stdin.write(canvas.tobytes())
            written += 1
    finally:
        # Stop the READER first. We asked it for a window but it may still
        # have frames in flight, and it will sit blocked writing into a pipe
        # nobody is draining. Its stderr is captured rather than inherited so
        # the inevitable shutdown "broken pipe" doesn't print on every render
        # and train everyone to ignore this tool's error output.
        rd.terminate()
        rd.stdout.close()
        rd.wait()
        rd_log.seek(0)
        rd_err = rd_log.read().decode("utf8", "replace")[-4000:]
        rd_log.close()
        try:
            wr.stdin.close()
        except BrokenPipeError:
            pass
        wr.wait()
    if not written:
        raise RuntimeError(
            f"decoded no frames from {video} at t={t0:.1f}\n{rd_err.strip()}")

    # mux the original audio for the same window (gym noise is most of the
    # atmosphere; a silent highlight feels dead). -shortest guards against the
    # audio segment running a few ms past the rendered frames.
    has_audio = bool(_probe(video, "codec_type", stream="a:0"))
    if has_audio:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", tmp,
             "-ss", f"{t0:.3f}", "-t", f"{t1 - t0:.3f}", "-i", video,
             "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
             "-c:a", "aac", "-b:a", "128k", "-shortest",
             "-movflags", "+faststart", out], check=True)
        os.remove(tmp)
    else:
        os.replace(tmp, out)
    return out


def _draw_debug(cv2, canvas, t, t0, t1, contacts, anchor_t):
    """Burn in what the clip THINKS is happening, so a human can check it.

    Shows, at the bottom of the frame:
      - a timeline of the clip window with a tick per detected contact
      - the anchor tick in red, everything else in cyan
      - a moving playhead
      - the current game time, and a big label the moment a contact fires

    The point is to separate two failure modes that look identical from the
    outside: the WINDOW being wrong (right touches, bad in/out points) versus
    the TOUCH TIMESTAMPS being wrong (window doing exactly what it was told,
    told the wrong thing). Without this you can only guess which one you're
    looking at. Same instinct as the pipeline's model-view overlay.
    """
    H, W = canvas.shape[:2]
    y = H - 130
    cv2.rectangle(canvas, (0, y - 46), (W, H), (0, 0, 0), -1)
    x0, x1 = 60, W - 60
    span = max(1e-6, t1 - t0)
    xf = lambda tt: int(x0 + (tt - t0) / span * (x1 - x0))

    cv2.line(canvas, (x0, y), (x1, y), (150, 150, 150), 2)
    for ct, play, cl in contacts:
        x = xf(ct)
        is_anchor = anchor_t is not None and abs(ct - anchor_t) < 0.06
        colour = (60, 60, 255) if is_anchor else (255, 220, 60)
        cv2.line(canvas, (x, y - (22 if is_anchor else 13)),
                 (x, y + (22 if is_anchor else 13)), colour, 3 if is_anchor else 2)
        cv2.putText(canvas, play[:3], (x - 14, y - 28),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, colour, 1, cv2.LINE_AA)

    cv2.line(canvas, (xf(t), y - 30), (xf(t), y + 30), (255, 255, 255), 2)
    cv2.putText(canvas, f"game t={t:6.2f}s   window {t0:.1f}-{t1:.1f}" +
                (f"   anchor {anchor_t:.2f}" if anchor_t is not None else ""),
                (x0, y + 58), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                (230, 230, 230), 1, cv2.LINE_AA)

    # the moment itself: a big label while a contact is firing, so you can
    # judge by eye whether the detected time matches what you're watching
    for ct, play, cl in contacts:
        if abs(ct - t) < 0.12:
            is_anchor = anchor_t is not None and abs(ct - anchor_t) < 0.06
            txt = ("ANCHOR: " if is_anchor else "") + play.upper() + \
                  (f" (p{cl})" if cl is not None else "")
            colour = (60, 60, 255) if is_anchor else (255, 220, 60)
            (tw, _), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_DUPLEX, 1.0, 2)
            org = ((W - tw) // 2, y - 80)
            cv2.putText(canvas, txt, org, cv2.FONT_HERSHEY_DUPLEX, 1.0,
                        (0, 0, 0), 6, cv2.LINE_AA)
            cv2.putText(canvas, txt, org, cv2.FONT_HERSHEY_DUPLEX, 1.0,
                        colour, 2, cv2.LINE_AA)
            break


def _draw_caption(cv2, canvas, caption, subcaption, band_y, band_h):
    """Headline above the action band (or top third when it's full-bleed).

    Deliberately not centred over the play: on a phone the thumb and the
    progress bar live at the bottom, and text over the ball is the fastest
    way to make a highlight unwatchable.
    """
    y = max(150, band_y - 40) if band_h < OUT_H else 190
    font = cv2.FONT_HERSHEY_DUPLEX
    for text, scale, thick, dy, colour in (
            (caption, 2.0, 4, 0, (255, 255, 255)),
            (subcaption, 1.1, 2, 62, (180, 200, 255))):
        if not text:
            continue
        (tw, _), _ = cv2.getTextSize(text, font, scale, thick)
        org = ((OUT_W - tw) // 2, y + dy)
        cv2.putText(canvas, text, org, font, scale, (0, 0, 0), thick + 5,
                    cv2.LINE_AA)                      # outline for legibility
        cv2.putText(canvas, text, org, font, scale, colour, thick, cv2.LINE_AA)


# --- highlight selection ---------------------------------------------------

def pick_highlights(game, names=None, limit=10, min_len=4.0):
    """Rank rallies as Shorts candidates.

    This is the actual moat. Everyone with a phone can post volleyball clips;
    almost nobody has a structured index of WHAT HAPPENED. The pipeline
    already labelled every touch and rally outcome, so "find the highlights"
    is a sort, not an afternoon of scrubbing.

    Scoring, in plain terms: points won beat points lost, a long rally beats a
    short one, and a rally with a lot of touches means an actual exchange
    rather than a serve into the net.
    """
    WEIGHT = {"kill": 10, "block": 9, "ace": 7,
              "attack_error": 2, "service_error": 0, "other_error": 1}
    out = []
    for i, r in enumerate(game.get("rallies", [])):
        if r.get("phase") != "game":
            continue
        dur = r["end"] - r["start"]
        if dur < min_len:
            continue
        touches = [c for c in r.get("contacts", []) if c.get("play")]
        score = (WEIGHT.get(r.get("outcome_type"), 3)
                 + min(dur, 25) / 5.0
                 + min(len(touches), 14) / 3.0)
        who = None
        if names and r.get("outcome_cluster") is not None:
            who = names.get(r["outcome_cluster"])
        out.append({"rally": i, "score": round(score, 2), "dur": round(dur, 1),
                    "outcome": r.get("outcome_type"), "who": who,
                    "touches": len(touches)})
    out.sort(key=lambda h: -h["score"])
    return out[:limit]


def caption_for(h):
    """Headline + subhead for a pick_highlights entry."""
    LABEL = {"kill": "KILL", "block": "STUFF BLOCK", "ace": "ACE",
             "attack_error": "ATTACK ERROR", "service_error": "SERVE ERROR"}
    head = LABEL.get(h.get("outcome"), f"{h['touches']}-TOUCH RALLY")
    if h.get("who"):
        head += f" - {h['who']}"
    return head, f"{h['dur']:.0f}s | {h['touches']} touches"


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(
        prog="vbpipe-shorts",
        description="Render ball-following 1080x1920 Shorts from a scored game.")
    ap.add_argument("video")
    ap.add_argument("-g", "--game", required=True, help="game.json")
    ap.add_argument("-o", "--out", required=True,
                    help="output .mp4, or a directory when --top is used")
    ap.add_argument("--rally", type=int, help="rally index to render")
    # explicit window, for a rally the reviewer added by hand: it has no
    # counterpart in game.json's rallies array, so --rally can't name it
    ap.add_argument("--t0", type=float, help="start seconds (instead of --rally)")
    ap.add_argument("--t1", type=float, help="end seconds (instead of --rally)")
    ap.add_argument("--anchor", type=float,
                    help="MOMENT mode: game-time of the play this clip is "
                         "about (a kill, dig, block). The clip becomes that "
                         "moment plus --lead touches of run-up, not the "
                         "whole rally. Needs --rally too.")
    ap.add_argument("--lead", type=int, default=4,
                    help="touches of run-up before the anchor (default 4: "
                         "dig-set-attack plus the swing that forced the dig)")
    ap.add_argument("--follow", type=float, default=1.0,
                    help="how hard the camera chases the ball. 1.0 = default; "
                         ">1 pans faster and tighter, <1 lazier")
    ap.add_argument("--lookahead", type=float, default=0.15,
                    help="seconds the camera aims AHEAD of the ball. Measured "
                         "sweet spot on this footage: 0.15 keeps the ball in "
                         "frame through the attack 98.8%% of the time vs 95.0%% "
                         "with none. Past ~0.30 the camera outruns the ball "
                         "and it gets worse")
    ap.add_argument("--contacts",
                    help="comma-separated touch times from the REVIEWED "
                         "database. Strongly preferred: game.json's own "
                         "contacts are raw detections (≈45% phantoms on this "
                         "footage) so counting touches through them is "
                         "meaningless")
    ap.add_argument("--bounds",
                    help="'t0,t1' reviewed rally boundaries, likewise")
    ap.add_argument("--reaction-x", type=float, dest="reaction_x",
                    help="after the play, swing back to this x (ref 1280 "
                         "space) to catch the scoring team reacting. Normally "
                         "the attacker's own contact x")
    ap.add_argument("--reaction-after", type=float, default=1.8,
                    help="seconds after the anchor before swinging back — "
                         "long enough to watch the ball land first")
    ap.add_argument("--debug", action="store_true",
                    help="burn in the contact timeline, the anchor, and the "
                         "game clock — so you can see whether a bad clip is a "
                         "bad WINDOW or a bad TOUCH TIMESTAMP")
    ap.add_argument("--caption", help="override the derived headline")
    ap.add_argument("--subcaption", help="override the derived subhead")
    ap.add_argument("--vfill", type=float, default=0.70,
                    help="fraction of source height the crop uses (0.70 trims "
                         "the gym roof and empty floor; 1.0 keeps everything)")
    ap.add_argument("--preset", default="medium", help="x264 preset")
    ap.add_argument("--no-tight", dest="tight", action="store_false", default=True,
                    help="keep the full rally window instead of trimming to "
                         "the first/last contact")
    ap.add_argument("--top", type=int,
                    help="render the N best rallies (see pick_highlights)")
    ap.add_argument("--list", action="store_true",
                    help="just print the ranked highlights, render nothing")
    ap.add_argument("--zoom", type=float, default=1.0,
                    help="1.0 = full-bleed 9:16 crop; <1 pulls back for court "
                         "context over a blurred backdrop (try 0.7)")
    ap.add_argument("--fps", type=float, default=30)
    ap.add_argument("--no-caption", action="store_true")
    args = ap.parse_args(argv)

    game = json.load(open(args.game))
    names = {c["id"]: c.get("name") for c in game.get("clusters", [])
             if c.get("name")}

    if args.list or args.top:
        picks = pick_highlights(game, names, limit=args.top or 10)
        for h in picks:
            print(f"  rally {h['rally']:>3}  score {h['score']:>5}  "
                  f"{h['dur']:>5}s  {h['touches']:>2} touches  "
                  f"{h['outcome'] or '-'}"
                  + (f"  {h['who']}" if h.get("who") else ""))
        if args.list:
            return picks
        os.makedirs(args.out, exist_ok=True)
        for h in picks:
            cap, sub = (None, None) if args.no_caption else caption_for(h)
            dst = os.path.join(args.out, f"short_rally{h['rally']:02d}.mp4")
            print(f"[shorts] -> {dst}")
            render_short(args.video, game, dst, rally=h["rally"],
                         fps=args.fps, zoom=args.zoom,
                         caption=cap, subcaption=sub)
        return picks

    if args.rally is None and (args.t0 is None or args.t1 is None):
        ap.error("pass --rally N, --t0/--t1, or --top N to render the best ones")
    cap = sub = None
    if not args.no_caption:
        cap, sub = args.caption, args.subcaption
        # fall back to a derived caption only where the caller didn't say
        if cap is None and args.rally is not None:
            picks = {h["rally"]: h for h in pick_highlights(game, names,
                                                            limit=999, min_len=0)}
            if args.rally in picks:
                cap, sub = caption_for(picks[args.rally])
    render_short(args.video, game, args.out, rally=args.rally,
                 t0=args.t0, t1=args.t1, fps=args.fps, zoom=args.zoom,
                 vfill=args.vfill, preset=args.preset, tight=args.tight,
                 anchor_t=args.anchor, lead_touches=args.lead,
                 contacts=[float(x) for x in args.contacts.split(",") if x.strip()]
                          if args.contacts else None,
                 bounds=[float(x) for x in args.bounds.split(",")]
                        if args.bounds else None,
                 follow=args.follow, look_s=args.lookahead,
                 reaction_x=args.reaction_x, reaction_after=args.reaction_after,
                 debug=args.debug,
                 caption=cap, subcaption=sub)
    print(f"[shorts] wrote {args.out}")


if __name__ == "__main__":
    main()
