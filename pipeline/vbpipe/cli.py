"""vbpipe CLI.
  vbpipe rally VIDEO -o OUT   # CPU: rally segments
  vbpipe full  VIDEO -o OUT   # GPU: + track, embed, cluster
  vbpipe plays VIDEO -o OUT   # GPU: + ball, contacts, play types (needs full's game.json)
"""
import argparse, datetime, inspect, json, os, subprocess, sys
from . import __version__
from .config import Config
from . import rally as R


def _rule_defaults(fn):
    """The tunables a rule function actually ran with. Several thresholds live
    as function defaults rather than Config fields (find_contacts' cos_thr,
    attribute's gate/drop), so without this they would go unrecorded."""
    return {k: v.default for k, v in inspect.signature(fn).parameters.items()
            if v.default is not inspect.Parameter.empty
            and isinstance(v.default, (int, float, bool, str, type(None)))}


def _stamp(game, stage, cfg, params):
    """Record which pipeline produced this stage's output.

    Without this a game.json is untraceable, and so are the review corrections
    derived from it: those reference cluster ids, tracklet ids and ball
    positions that only mean anything relative to the exact models and
    thresholds that ran. Mixing labels across pipeline generations is how a
    training set silently learns the PREVIOUS generation's failure modes — the
    deleted-phantom set is the clearest case, since it is by definition the
    false positives of one specific detector. See ML-PLAN.md.

    Stamped per stage because rally/full/plays run independently and are often
    re-run apart from each other; a game.json can legitimately carry output
    from three different pipeline states, and that has to be visible.
    """
    from dataclasses import asdict
    p = game.setdefault("pipeline", {})
    p["vbpipe_version"] = __version__
    p.setdefault("stages", {})[stage] = {
        "at": datetime.datetime.now(datetime.timezone.utc)
                 .isoformat(timespec="seconds").replace("+00:00", "Z"),
        "vbpipe_version": __version__,
        "config": asdict(cfg),
        "params": params,
    }


def _save(game, gj):
    """Atomic write: dump to a temp file then rename, so a crash mid-write
    (e.g. a non-serializable value) can never corrupt an existing game.json —
    the previous good file survives and the fast stage can be resumed."""
    tmp = gj + ".tmp"
    with open(tmp, "w") as f:
        json.dump(game, f, indent=1)
    os.replace(tmp, gj)

def _resolve_ball_fps(arg, video):
    """'auto' -> source fps capped at 60 (so 60fps footage is fully used and
    high-speed clips don't explode runtime); a number -> that number."""
    if arg != "auto":
        return float(arg)
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video],
            capture_output=True, text=True).stdout.strip()
        num, den = out.split("/")
        src = float(num) / float(den)
    except Exception:
        print("[ball] WARNING: could not probe source fps, using legacy 20")
        return 20.0
    fps = min(src, 60.0)
    print(f"[ball] source {src:.2f} fps -> sampling at {fps:g} fps")
    return fps

def _probe_provenance(video):
    """When was this actually filmed, and how long is it?

    Must run against the ORIGINAL camera file, before any stage re-encodes:
    ffmpeg rewrites container `creation_time` to the encode time unless told
    otherwise, so a probe of a processed mp4 reports when the pipeline ran,
    not when the game was played. (Measured on cca-one.mp4: creation_time
    2026-07-23, encoder Lavf62.3.100 — the re-encode, not the match.)

    Returns {recorded_at, source_file, duration_s}. `recorded_at` is None
    rather than a guess when the container carries no timestamp — the app
    prompts for a missing date, but silently accepts a wrong one, and a wrong
    date poisons the derived game ordering for that whole night.
    """
    prov = {"source_file": os.path.basename(video), "recorded_at": None,
            "duration_s": None}
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:format_tags:stream_tags", "-of", "json", video],
            capture_output=True, text=True).stdout
        probe = json.loads(out)
        fmt = probe.get("format", {})
        if fmt.get("duration"):
            prov["duration_s"] = round(float(fmt["duration"]), 3)

        tags = dict(fmt.get("tags") or {})
        # Stream tags survive some re-encodes that drop the container-level
        # ones, so fold them in as a second source (without letting them
        # override a container tag).
        for s in probe.get("streams", []):
            for k, v in (s.get("tags") or {}).items():
                tags.setdefault(k, v)

        # Apple's own tag first: it carries the LOCAL time with a UTC offset
        # ("2026-07-23T22:07:36-0400"), where `creation_time` is bare UTC.
        # For an evening sport that difference decides the calendar date —
        # a 22:07 game on the 23rd is 02:07 on the 24th in UTC.
        for key in ("com.apple.quicktime.creationdate", "creation_time"):
            if tags.get(key):
                prov["recorded_at"] = tags[key]
                prov["recorded_at_tag"] = key
                break
    except Exception as e:
        print(f"[meta] WARNING: could not probe {video}: {e}")

    if not prov["recorded_at"]:
        # Filesystem mtime is a weaker signal (a Drive round-trip or a copy
        # can reset it) but it is still anchored to the file rather than to
        # whatever the operator typed, so it beats nothing.
        try:
            import datetime as _dt
            mt = _dt.datetime.fromtimestamp(os.path.getmtime(video),
                                            _dt.timezone.utc)
            prov["recorded_at"] = mt.isoformat().replace("+00:00", "Z")
            prov["recorded_at_source"] = "mtime"
            print(f"[meta] no creation_time; falling back to mtime "
                  f"{prov['recorded_at']}")
        except Exception:
            print("[meta] WARNING: no recorded_at — the app will ask for a date")
    else:
        prov["recorded_at_source"] = "creation_time"
        print(f"[meta] recorded_at {prov['recorded_at']} (container)")
    return prov


def main():
    ap = argparse.ArgumentParser(prog="vbpipe")
    ap.add_argument("stage", choices=["rally", "full", "plays", "overlay"])
    ap.add_argument("video")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--eval-clips", type=int, default=3)
    ap.add_argument("--game-start", type=float, default=0.0,
                    help="seconds; rallies before this are marked warmup")
    ap.add_argument("--ball-model", default=None,
                    help="path to trained ball detector .pt (else motion-based CV)")
    ap.add_argument("--ball-hires", dest="ball_hires", action="store_true", default=True,
                    help="detect the ball at native 1080p/imgsz1920 (default; the "
                         "promoted model is trained for this — matches gen-3)")
    ap.add_argument("--no-ball-hires", dest="ball_hires", action="store_false",
                    help="detect the ball at legacy 720p/imgsz1088 (old models)")
    ap.add_argument("--ball-conf", type=float, default=0.25,
                    help="ball detection confidence (0.25 tuned for the hi-res model)")
    ap.add_argument("--ball-fps", default="auto",
                    help="ball-stage sampling fps: 'auto' = source fps capped at 60 "
                         "(the density lever — 60fps footage triples the detection "
                         "budget vs the legacy 20); or a number, e.g. 20 for the "
                         "exact historical behavior")
    ap.add_argument("--no-suppress-static", dest="suppress_static",
                    action="store_false", default=True,
                    help="keep stationary ball detections (default: drop them; "
                         "a spare ball on the sideline was starving the game "
                         "ball on cca-two)")
    ap.add_argument("--pose-model", default=None,
                    help="path/name of an ultralytics pose model (e.g. "
                         "yolo11m-pose.pt). If set, contacts are ENRICHED with "
                         "wrist keypoints (Phase B); default attribution is "
                         "unchanged. Adds ~1 pose inference per contact.")
    ap.add_argument("--wrist-max", type=float, default=180.0,
                    help="max px from ball to nearest wrist for a contact to be "
                         "kept (needs --pose-model). Lower = fewer phantom "
                         "touches, slightly lower recall. 180 ~= 1.0x touch "
                         "count on the cca games.")
    ap.add_argument("--court", default=None,
                    help="court_config.json from the app's Camera setup page")
    ap.add_argument("--overlay", default=None, metavar="PATH",
                    help="after the plays stage, render a full model-view mp4 "
                         "here (ball + players + contacts drawn on the video). "
                         "Also usable as its own stage: `vbpipe overlay VIDEO`.")
    ap.add_argument("--overlay-game-only", action="store_true",
                    help="model-view: skip warmup/dead time (default shows all, "
                         "so warmup false-positives stay visible)")
    a = ap.parse_args()
    cfg = Config.from_court_file(a.court) if a.court else Config()
    if a.court:
        from . import plays as _plays
        _plays.set_net(cfg.net_line)
        print(f"[court] using calibration from {a.court}")
    os.makedirs(a.out, exist_ok=True)
    gj = os.path.join(a.out, "game.json")
    game = json.load(open(gj)) if os.path.exists(gj) else {"video": a.video}

    # Provenance: captured once, on the first stage to see this video, and
    # never recomputed — later stages run against re-encodes and would
    # overwrite the true date with an encode timestamp. See NAMING-PLAN.md.
    if "recorded_at" not in game:
        game.update(_probe_provenance(a.video))
        _save(game, gj)

    if a.stage == "overlay":
        from .overlay import render_overlay
        dst = a.overlay or os.path.join(a.out, "model_view.mp4")
        assert "rallies" in game, "overlay needs a processed game.json (run plays first)"
        print(f"[overlay] rendering model-view -> {dst}")
        render_overlay(a.video, game, dst, game_only=a.overlay_game_only)
        print("done")
        return

    if "rallies" not in game:
        print("[rally] segmentation (CPU)...")
        game["rallies"] = R.segment(R.motion_signal(a.video, cfg.court_poly),
                                    R.audio_signal(a.video), cfg)
        _stamp(game, "rally", cfg, {"court_file": a.court})
        _save(game, gj)
        print(f"  {len(game['rallies'])} rallies")
    if a.stage == "rally": return

    if a.stage == "full":
        from .track import track_rallies
        from .identity import embed_tracklets, cluster
        print("[track] detect + track (GPU)...")
        tracklets = track_rallies(a.video, game["rallies"], cfg, a.out)
        print(f"  {len(tracklets)} tracklets")
        print("[embed] re-ID embeddings...")
        tracklets = embed_tracklets(tracklets, a.out, cfg, a.device)
        print("[cluster] identities...")
        clusters = cluster(tracklets, cfg)
        print(f"  {len(clusters)} identities")
        for tr in tracklets:
            if tr.get("emb"):
                tr["emb"] = [round(float(v), 4) for v in tr["emb"]]
        game["tracklets"], game["clusters"] = tracklets, clusters
        _stamp(game, "full", cfg, {"court_file": a.court, "device": a.device})
        _save(game, gj)
        print(f"wrote {gj}")
        return

    # plays stage — requires tracklets from a previous 'full' run
    assert "tracklets" in game, "run 'full' first (game.json lacks tracklets)"
    # phase gating: manual game start only. The old 8-player formation gate
    # silently dropped real rallies whenever tracking found <8 players (e.g.
    # 9 of 35 rallies surviving); junk segments are instead dismissed with one
    # click in the app. Pre-set phases (from the notebook) are respected.
    for r in game["rallies"]:
        if "phase" not in r or r["start"] < a.game_start:
            r["phase"] = "warmup" if r["start"] < a.game_start else "game"
    ng = sum(r["phase"] == "game" for r in game["rallies"])
    print(f"[phase] {ng} game rallies, {len(game['rallies'])-ng} warmup/skipped")
    from .plays import find_contacts, attribute, classify
    from .annotate import render_rally
    ball_fps = _resolve_ball_fps(a.ball_fps, a.video)
    if a.ball_model:
        from .balltrain import detect_all
        from ultralytics import YOLO
        print(f"[ball] trained detector: {a.ball_model} "
              f"({'1080p/imgsz1920' if a.ball_hires else '720p/imgsz1088'}, "
              f"conf={a.ball_conf}, fps={ball_fps:g})")
        ball = detect_all(YOLO(a.ball_model), a.video, game["rallies"],
                          fps=ball_fps, hi_res=a.ball_hires, conf=a.ball_conf,
                          suppress_static=a.suppress_static)
    else:
        from .ballcv import detect_rally
        print(f"[ball] motion-based ball detection (CPU, fps={ball_fps:g})...")
        ball = []
        for ri, r in enumerate(game["rallies"]):
            if r.get("phase") == "warmup":
                ball.append([]); continue
            pts = detect_rally(a.video, r, game["tracklets"], ri, fps=ball_fps)
            print(f"  rally {ri}: {len(pts)} ball pts")
            ball.append(pts)
    print("[plays] contacts + attribution + typing...")
    contacts_per_rally = []
    for ri, (r, pts) in enumerate(zip(game["rallies"], ball)):
        if r.get("phase") == "warmup":
            contacts_per_rally.append([]); continue
        contacts_per_rally.append(find_contacts(pts))
    # Phase B (optional, non-invasive): enrich contacts with wrist keypoints
    # BEFORE attribution/typing. Default attribution below is unchanged.
    if a.pose_model:
        from .pose_attrib import enrich_contacts, reject_wristless_contacts
        from ultralytics import YOLO
        print(f"[pose] wrist enrichment at contact times: {a.pose_model}")
        enrich_contacts(a.video, game["rallies"], contacts_per_rally,
                        game["tracklets"], YOLO(a.pose_model))
        # PRECISION lever: drop contacts with no wrist near the ball (no hand
        # = not a real touch). Cuts touch-count inflation ~1.2x -> ~1.0x.
        before = sum(len(cs) for cs in contacts_per_rally)
        contacts_per_rally = [reject_wristless_contacts(cs, a.wrist_max)
                              for cs in contacts_per_rally]
        after = sum(len(cs) for cs in contacts_per_rally)
        print(f"[pose] wristless-contact rejection: {before-after} contacts dropped")
    all_plays = []
    for ri, (r, cs) in enumerate(zip(game["rallies"], contacts_per_rally)):
        if r.get("phase") == "warmup":
            r["contacts"] = []; continue
        cs = classify(attribute(cs, game["tracklets"], ri))
        r["contacts"] = cs
        all_plays += [c.get("play") for c in cs]
    game["ball"] = [[list(map(lambda v: round(float(v),2), p)) for p in pts]
                    for pts in ball]
    _stamp(game, "plays", cfg, {
        "court_file": a.court,
        "ball_source": a.ball_model or "ballcv (motion CV)",
        "ball_hires": a.ball_hires if a.ball_model else None,
        "ball_conf": a.ball_conf if a.ball_model else None,
        "ball_fps": ball_fps,
        "suppress_static": a.suppress_static,
        "pose_model": a.pose_model,
        "wrist_max": a.wrist_max if a.pose_model else None,
        "game_start": a.game_start,
        "find_contacts": _rule_defaults(find_contacts),
        "attribute": _rule_defaults(attribute),
        "classify": _rule_defaults(classify),
    })
    _save(game, gj)
    from collections import Counter
    print("  play counts:", dict(Counter(all_plays)))
    # eval clips: rallies with most contacts
    order = sorted([i for i in range(len(game["rallies"]))
                    if game["rallies"][i].get("phase") == "game"],
                   key=lambda i: -len(game["rallies"][i].get("contacts", [])))
    os.makedirs(f"{a.out}/eval", exist_ok=True)
    for i in order[:a.eval_clips]:
        fp = f"{a.out}/eval/rally_{i:02d}.mp4"
        print(f"  rendering {fp}")
        render_rally(a.video, game["rallies"][i], ball[i],
                     game["rallies"][i]["contacts"], fp)
    if a.overlay is not None:
        from .overlay import render_overlay
        dst = a.overlay if a.overlay else f"{a.out}/model_view.mp4"
        print(f"[overlay] rendering full model-view -> {dst}")
        render_overlay(a.video, game, dst, game_only=a.overlay_game_only)
    print("done")

if __name__ == "__main__":
    sys.exit(main())
