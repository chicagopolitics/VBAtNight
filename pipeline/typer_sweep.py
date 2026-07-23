"""Sweep play-typing anchor settings against reviewed corrections.
Usage: python typer_sweep.py corrections_gameN.json game.json [corr2 game2 ...]

Re-runs vbpipe.plays.classify over the pipeline output's contacts under every
combination of (serve gate, resync_at, max_touch_gap) and scores each against
the corrections. Run this whenever the ball/contact model improves — the
anchors that lose at contacts P~51% may win at higher precision (they fire on
spurious contacts today). 2026-07-22 baseline on game2: crossed serve gate
wins (39% vs 37% exact); all resync settings lose. See plays.classify docs."""
import json, sys, itertools, copy
from collections import Counter, defaultdict
from vbpipe.plays import classify
from vbpipe.eval_corrections import new_tally, score, fam

def run(pairs, serve_gate, resync_at, gap):
    s, conf, pt = new_tally(), Counter(), defaultdict(lambda: [0, 0])
    for corr, pipe in pairs:
        g = copy.deepcopy(pipe)
        for r in g["rallies"]:
            cs = r.get("contacts", [])
            for c in cs: c.pop("play", None)
            classify(cs, resync_at, gap, serve_gate=serve_gate)
        score(corr, g, s, conf, pt)
    tot = max(sum(conf.values()), 1)
    exact = sum(c for (t, p), c in conf.items() if t == p) / tot
    family = sum(c for (t, p), c in conf.items() if fam(t) == fam(p or "")) / tot
    return exact, family, s["joint"], s["gt"]

def main():
    args = sys.argv[1:]
    if len(args) < 2 or len(args) % 2:
        sys.exit(__doc__)
    pairs = [(json.load(open(args[i])), json.load(open(args[i + 1])))
             for i in range(0, len(args), 2)]
    rows = []
    for sg, ra, gp in itertools.product([True, False], [None, 3, 4], [None, 2.2, 3.5]):
        ex, fm, j, gt = run(pairs, sg, ra, gp)
        rows.append((ex, fm, j, gt, sg, ra, gp))
    rows.sort(reverse=True)
    print(f"{'exact':>6} {'family':>7} {'joint':>9}   serve_gate resync_at gap")
    for ex, fm, j, gt, sg, ra, gp in rows:
        print(f"{ex:6.0%} {fm:7.0%} {j:4d}/{gt:<4d}   "
              f"{'crossed' if sg else 'always':10s} {str(ra):9s} {gp}")
    best = rows[0]
    print(f"\nbest: serve_gate={'crossed' if best[4] else 'always'} "
          f"resync_at={best[5]} gap={best[6]}"
          + ("  <- defaults win, no change needed"
             if best[4] and best[5] is None and best[6] is None else
             "  <- BEATS current defaults; consider updating plays.classify"))

if __name__ == "__main__":
    main()
