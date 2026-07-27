"""Phase B smoke test — run on Colab (GPU) BEFORE a full pose reprocess.

Loads an existing game.json (already has tracklets + ball), enriches contacts
in the first N game rallies with wrist keypoints, and prints per-contact:
  ball (x,y) | nearest wrist dist | wrist's cluster | body-center cluster
plus a summary: what fraction of contacts got a wrist within 140px, and how
often the wrist cluster differs from the body-center cluster (the whole point
— if they never differ, pose adds nothing).

Usage (Colab):
  !python pose_smoketest.py VIDEO.mp4 game.json --pose yolo11m-pose.pt --n 5

If wrists look sane and often disagree with body-center, do the full run:
  python -m vbpipe.cli plays VIDEO -o OUT --ball-model ball_model.pt \\
         --pose-model yolo11m-pose.pt
Then send game.json here; wrist-vs-body attribution is scored offline against
corrections (no second reprocess needed).
"""
import argparse, json
from vbpipe.plays import find_contacts, attribute
from vbpipe.pose_attrib import enrich_contacts, attribute_by_wrist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("game_json")
    ap.add_argument("--pose", default="yolo11m-pose.pt")
    ap.add_argument("--n", type=int, default=5, help="game rallies to sample")
    a = ap.parse_args()
    from ultralytics import YOLO

    g = json.load(open(a.game_json))
    game_rallies = [i for i, r in enumerate(g["rallies"])
                    if r.get("phase") == "game"][:a.n]
    print(f"sampling {len(game_rallies)} game rallies: {game_rallies}")

    # build contacts for the sampled rallies only
    cpr = [[] for _ in g["rallies"]]
    for ri in game_rallies:
        cpr[ri] = find_contacts(g["ball"][ri])
        attribute(cpr[ri], g["tracklets"], ri)   # fills body-center `cluster`

    # restrict enrichment to sampled rallies (mark others warmup locally)
    sub = [dict(r, phase=("game" if i in game_rallies else "warmup"))
           for i, r in enumerate(g["rallies"])]
    enrich_contacts(a.video, sub, cpr, g["tracklets"], YOLO(a.pose))

    got = diff = total = 0
    for ri in game_rallies:
        print(f"\n--- rally {ri} ---")
        for c in cpr[ri]:
            total += 1
            ws = c.get("wrists") or []
            body = c.get("cluster")
            wcl = attribute_by_wrist(c)
            d = ws[0][3] if ws else None
            if d is not None and d <= 140:
                got += 1
            if wcl is not None and body is not None and wcl != body:
                diff += 1
            print(f"  t={c['t']:.2f} ball=({c['x']:.0f},{c['y']:.0f}) "
                  f"wristdist={d if d is None else round(d)} "
                  f"wrist_cluster={wcl} body_cluster={body}")
    print(f"\nsummary: {got}/{total} contacts have a wrist within 140px; "
          f"wrist≠body on {diff}/{total} (that disagreement is where pose can "
          f"fix attribution)")


if __name__ == "__main__":
    main()
