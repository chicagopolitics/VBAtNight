"""Batch-process game videos locally on a CUDA GPU.

The local replacement for notebooks/process_game.ipynb. Same pipeline, same
per-video steps, same bundle layout — what it drops is the Colab scaffolding:
no Drive mount, no vbpipe.zip round-trip, no reinstalling dependencies every
session, and no 12-hour runtime cap. Run it and go to bed.

    python process_games.py --videos C:\\vb\\videos

Each game night: drop the trimmed videos (each starting at first serve) into
the videos folder and run. Videos that already have a bundle are skipped, so
an interrupted run is resumed by just running it again.

Per video, in order:
  1. `vbpipe full`  — rallies, YOLO+ByteTrack tracking, re-ID identities (GPU)
  2. phase gate     — segments after --game-start are 'game', earlier 'warmup'
  3. ball model     — trained ONCE from physics-verified CV arcs, then reused
  4. `vbpipe plays` — ball detection, contacts, attribution, play typing
  5. game.mp4       — stream copy with +faststart so the app can scrub instantly
  6. bundle         — game.json + game.mp4 + crops/, zipped for the app import
  7. model view     — optional full-game overlay of what the model sees
"""
import argparse, glob, json, os, shutil, subprocess, sys, time, zipfile

VIDEO_EXT = (".mp4", ".mov", ".mkv")
APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app"))
UPLOAD_FAILED = []


def run(cmd, cwd=None):
    """Run a child process, streaming its output as it goes.

    UTF-8 is pinned in both directions on purpose. Piped output on Windows
    defaults to the console codepage (cp1252 here), and ultralytics prints
    non-cp1252 characters in its progress lines — which killed the parent with
    a UnicodeDecodeError mid-stage while leaving the child running. Decoding
    with errors="replace" means a stray byte can never abort a two-hour run,
    and PYTHONIOENCODING keeps the child from failing on the write side.
    """
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    p = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, bufsize=1, cwd=cwd, env=env,
                         text=True, encoding="utf-8", errors="replace")
    try:
        for line in p.stdout:
            print(line, end="")
    except BaseException:
        # Never leave an orphan holding the GPU and writing to the output dir.
        p.kill()
        p.wait()
        raise
    if p.wait():
        raise RuntimeError(f"command failed: {' '.join(str(c) for c in cmd)}")


def parse_clock(s):
    """'2:15' -> 135.0, '90' -> 90.0"""
    parts = str(s).split(":")
    return int(parts[0]) * 60 + float(parts[1]) if len(parts) > 1 else float(parts[0])


def court_args(a, name, work):
    """Resolve this recording's court calibration to a --court argument.

    Mirrors the notebook: a per-video entry in courts_config.json wins, then
    the shared _default, then a bare court_config.json.
    """
    if a.courts and os.path.exists(a.courts):
        m = json.load(open(a.courts))
        geo = (m.get("per_video") or {}).get(name) or m.get("_default")
        if geo:
            dst = os.path.join(work, f"court_{name}.json")
            json.dump(geo, open(dst, "w"))
            which = "per-video" if name in (m.get("per_video") or {}) else "default"
            print(f"  court calibration: {which}")
            return ["--court", dst]
        print("  court calibration: none for this video — using defaults")
    return []


def ensure_ball_model(a, video, out):
    """Train the ball detector once, then reuse it for every later video.

    Labels come from ballcv's physics-verified arcs, so this needs no hand
    labelling — but it is slow, which is why the result is cached to --ball-model.
    """
    if os.path.exists(a.ball_model):
        return a.ball_model
    print("  no saved ball model — bootstrap-training once (slow, first video only)")
    from vbpipe.ballcv import detect_rally
    from vbpipe.balltrain import build_dataset, train

    g = json.load(open(f"{out}/game.json"))
    arcs = {}
    for ri, r in enumerate(g["rallies"]):
        if r.get("phase") == "warmup":
            continue
        arcs[str(ri)] = [[p[0], p[1], p[2]]
                         for p in detect_rally(video, r, g["tracklets"], ri)]
    arcs_path = os.path.join(out, "arcs.json")
    json.dump(arcs, open(arcs_path, "w"))
    # cwd: ultralytics writes runs/detect/... relative to the working dir, and
    # build_dataset writes its dataset dir the same way. Keep both inside the
    # per-video work dir instead of wherever the script happened to be started.
    cwd = os.getcwd()
    try:
        os.chdir(out)
        train(build_dataset(video, "arcs.json"))
    finally:
        os.chdir(cwd)
    best = sorted(glob.glob(f"{out}/runs/detect/*/weights/best.pt"))
    if not best:
        raise RuntimeError(f"training produced no weights under {out}/runs/detect")
    os.makedirs(os.path.dirname(a.ball_model) or ".", exist_ok=True)
    shutil.copy(best[-1], a.ball_model)
    print(f"  ball model saved -> {a.ball_model}")
    return a.ball_model


def bundle(out, name, bundles):
    """game.json + game.mp4 + crops/, written .part then renamed.

    The rename is what makes the resume safe: a bundle only exists once it is
    complete, so an interrupted run never leaves a half-written zip that the
    next run would skip over.
    """
    os.makedirs(bundles, exist_ok=True)
    path = os.path.join(bundles, f"game_bundle_{name}.zip")
    with zipfile.ZipFile(path + ".part", "w") as z:
        z.write(f"{out}/game.json", "game.json")
        z.write(f"{out}/game.mp4", "game.mp4")
        for f in sorted(os.listdir(f"{out}/crops")):
            z.write(f"{out}/crops/{f}", f"crops/{f}")
    os.replace(path + ".part", path)
    return path


def upload(a, path):
    """Hand the finished bundle to app/scripts/upload-bundle.mjs.

    Shelling out to the Node script rather than reimplementing Drive auth in
    Python on purpose: credentials, folder resolution and upsert-by-name then
    have exactly one implementation, in lib/drive.js, and rotating a token
    stays a one-file job. It also means the bundle lands exactly where
    /api/drive already looks, so the droplet side needs no changes at all.

    A failed upload does not abort the batch — the bundle is on local disk and
    can be re-sent — but it is collected and reported at the end, because a
    silently un-uploaded game is one you'd discover at review time.
    """
    script = os.path.join(a.app_dir, "scripts", "upload-bundle.mjs")
    if not os.path.exists(script):
        print(f"  [upload] skipped: {script} not found")
        return False
    print("  [upload] -> Google Drive")
    try:
        run(["node", script, path], cwd=a.app_dir)
        return True
    except Exception as e:
        print(f"  [upload] FAILED: {e}")
        return False


def process(a, vname):
    name = os.path.splitext(vname)[0]
    video = os.path.join(a.videos, vname)
    out = os.path.join(a.work, f"out_{name}")
    os.makedirs(out, exist_ok=True)
    print(f"\n=== {vname} ===")
    t0 = time.time()

    court = court_args(a, name, out)
    gs = parse_clock(a.game_start)

    run([sys.executable, "-m", "vbpipe.cli", "full", video, "-o", out,
         "--device", a.device] + court)

    # Phase gate before ball training, which only looks at 'game' rallies.
    # Every segment after game start is kept; junk is dismissed in one click in
    # the app ("Not a rally") rather than guessed at here.
    g = json.load(open(f"{out}/game.json"))
    for r in g["rallies"]:
        r["phase"] = "game" if r["start"] >= gs else "warmup"
    json.dump(g, open(f"{out}/game.json", "w"))

    ball = ensure_ball_model(a, video, out)
    pose = ["--pose-model", a.pose_model] if a.pose_model else []
    run([sys.executable, "-m", "vbpipe.cli", "plays", video, "-o", out,
         "--game-start", gs, "--ball-model", ball,
         "--eval-clips", a.eval_clips] + pose + court)

    # Ship the whole video; the app plays rallies via media fragments.
    # +faststart moves the moov atom to the front so scrubbing is instant.
    subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-c", "copy",
                    "-movflags", "+faststart", f"{out}/game.mp4", "-y"], check=True)

    path = bundle(out, name, a.bundles)
    print(f"  bundle -> {path} ({os.path.getsize(path) // 1_000_000} MB)")

    if a.upload and not upload(a, path):
        UPLOAD_FAILED.append(path)

    if a.model_view:
        from vbpipe.overlay import render_overlay
        os.makedirs(a.model_views, exist_ok=True)
        dst = os.path.join(a.model_views, f"model_view_{name}.mp4")
        print("  rendering model-view (what the model sees)...")
        render_overlay(video, json.load(open(f"{out}/game.json")), dst,
                       game_only=False)
        print(f"  model-view -> {dst}")

    if not a.keep:
        shutil.rmtree(out, ignore_errors=True)
    print(f"  done in {(time.time() - t0) / 60:.1f} min")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--videos", default=r"C:\vb\videos",
                    help="folder of trimmed game videos (default: %(default)s)")
    ap.add_argument("--work", default=r"C:\vb\work",
                    help="scratch dir for per-video output (default: %(default)s)")
    ap.add_argument("--bundles", default=r"C:\vb\bundles",
                    help="where finished bundles land (default: %(default)s)")
    ap.add_argument("--model-views", default=r"C:\vb\model_views")
    ap.add_argument("--ball-model", default=r"C:\vb\models\ball_model.pt",
                    help="trained once if absent, reused after (default: %(default)s)")
    ap.add_argument("--courts", default=None,
                    help="courts_config.json from the app's Camera setup page")
    ap.add_argument("--game-start", default="0:00",
                    help="first serve, m:ss — earlier segments become warmup")
    ap.add_argument("--pose-model", default="yolo11m-pose.pt",
                    help="wrist keypoints for attribution; '' to disable")
    ap.add_argument("--eval-clips", type=int, default=0)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--limit", type=int, default=99)
    ap.add_argument("--dry-run", action="store_true",
                    help="list what would be processed, then stop")
    ap.add_argument("--no-model-view", dest="model_view", action="store_false",
                    default=True, help="skip the full-game overlay render")
    ap.add_argument("--keep", action="store_true",
                    help="keep per-video work dirs (lets the app import them "
                         "directly, without unzipping the bundle)")
    ap.add_argument("--no-upload", dest="upload", action="store_false",
                    default=True,
                    help="don't send finished bundles to Google Drive")
    ap.add_argument("--app-dir", default=APP_DIR,
                    help="the Next app, for Drive credentials + upload script "
                         "(default: %(default)s)")
    a = ap.parse_args()

    import torch
    if not torch.cuda.is_available():
        sys.exit("No CUDA device. See pipeline/README.md 'Run (local GPU, Windows)'.")
    print(f"GPU: {torch.cuda.get_device_name(0)}")

    if not os.path.isdir(a.videos):
        sys.exit(f"no such videos folder: {a.videos}")
    os.makedirs(a.work, exist_ok=True)
    vids = sorted(f for f in os.listdir(a.videos) if f.lower().endswith(VIDEO_EXT))
    todo = [v for v in vids
            if not os.path.exists(os.path.join(
                a.bundles, f"game_bundle_{os.path.splitext(v)[0]}.zip"))][:a.limit]
    # NB: "already processed" means a bundle in --bundles on THIS machine.
    # Bundles that only exist in Drive (e.g. the six games Colab produced) do
    # not count, so dropping those videos in here would reprocess them.
    print(f"{len(vids)} videos in {a.videos}; {len(todo)} still to process")
    for v in vids:
        done = v not in todo
        print(f"  [{'skip' if done else ' do '}] {v}")
    if a.dry_run or not todo:
        return

    t0 = time.time()
    for v in todo:
        process(a, v)
    print(f"\nAll done in {(time.time() - t0) / 60:.1f} min.")
    if UPLOAD_FAILED:
        print(f"\n{len(UPLOAD_FAILED)} bundle(s) did NOT reach Drive. Retry with:")
        for p in UPLOAD_FAILED:
            print(f'  npm run upload-bundle -- "{p}"')
        sys.exit(1)
    if a.upload:
        print("Bundles are in Drive — import them from the app's Import page.")
    else:
        print(f"Bundles are in {a.bundles} (upload skipped).")


if __name__ == "__main__":
    main()
