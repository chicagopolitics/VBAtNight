"""vbpipe CLI.
  vbpipe rally VIDEO -o OUT   # CPU: rally segments
  vbpipe full  VIDEO -o OUT   # GPU: + track, embed, cluster
  vbpipe plays VIDEO -o OUT   # GPU: + ball, contacts, play types (needs full's game.json)
"""
import argparse, json, os, subprocess, sys
from .config import Config
from . import rally as R

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

def main():
    ap = argparse.ArgumentParser(prog="vbpipe")
    ap.add_argument("stage", choices=["rally", "full", "plays"])
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
    ap.add_argument("--court", default=None,
                    help="court_config.json from the app's Camera setup page")
    a = ap.parse_args()
    cfg = Config.from_court_file(a.court) if a.court else Config()
    if a.court:
        from . import plays as _plays
        _plays.set_net(cfg.net_line)
        print(f"[court] using calibration from {a.court}")
    os.makedirs(a.out, exist_ok=True)
    gj = os.path.join(a.out, "game.json")
    game = json.load(open(gj)) if os.path.exists(gj) else {"video": a.video}

    if "rallies" not in game:
        print("[rally] segmentation (CPU)...")
        game["rallies"] = R.segment(R.motion_signal(a.video, cfg.court_poly),
                                    R.audio_signal(a.video), cfg)
        json.dump(game, open(gj, "w"), indent=1)
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
        json.dump(game, open(gj, "w"), indent=1)
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
                          fps=ball_fps, hi_res=a.ball_hires, conf=a.ball_conf)
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
    all_plays = []
    for ri, (r, pts) in enumerate(zip(game["rallies"], ball)):
        if r.get("phase") == "warmup":
            r["contacts"] = []; continue
        cs = classify(attribute(find_contacts(pts), game["tracklets"], ri))
        r["contacts"] = cs
        all_plays += [c.get("play") for c in cs]
    game["ball"] = [[list(map(lambda v: round(float(v),2), p)) for p in pts]
                    for pts in ball]
    json.dump(game, open(gj, "w"), indent=1)
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
    print("done")

if __name__ == "__main__":
    sys.exit(main())
