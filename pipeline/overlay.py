"""Standalone model-view renderer (thin wrapper over vbpipe.overlay).

For pipeline runs, prefer the CLI stage:
  python -m vbpipe.cli overlay VIDEO -o OUT        # full game -> OUT/model_view.mp4
or add --overlay to a plays run. This script is for ad-hoc local rendering:

  python overlay.py VIDEO game.json --rally 5 -o out.mp4
  python overlay.py VIDEO game.json --t0 120 --t1 150 -o out.mp4
  python overlay.py VIDEO game.json                       # whole game
"""
import argparse, json
from vbpipe.overlay import render_overlay


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("game_json")
    ap.add_argument("--rally", type=int, default=None)
    ap.add_argument("--t0", type=float, default=None)
    ap.add_argument("--t1", type=float, default=None)
    ap.add_argument("-o", "--out", default="model_view.mp4")
    ap.add_argument("--fps", type=float, default=15.0)
    ap.add_argument("--no-players", action="store_true")
    ap.add_argument("--game-only", action="store_true")
    a = ap.parse_args()
    g = json.load(open(a.game_json))
    t0, t1 = a.t0, a.t1
    if a.rally is not None:
        t0, t1 = g["rallies"][a.rally]["start"], g["rallies"][a.rally]["end"]
    render_overlay(a.video, g, a.out, t0=t0 or 0.0, t1=t1, fps=a.fps,
                   players=not a.no_players, game_only=a.game_only)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
