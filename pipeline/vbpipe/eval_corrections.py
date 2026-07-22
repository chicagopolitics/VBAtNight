"""Score pipeline output against human-reviewed corrections from the app.
Usage: python -m vbpipe.eval_corrections corrections_gameN.json game.json
(game.json = the pipeline output that was originally imported)"""
import json, sys
from collections import Counter, defaultdict

MATCH_S = 0.5   # contacts within this many seconds are considered the same touch

def match(pred, truth):
    """Greedy time matching; returns list of (p, t) pairs + unmatched lists."""
    pairs, used = [], set()
    for p in pred:
        best, bd = None, MATCH_S
        for j, t in enumerate(truth):
            if j in used: continue
            d = abs(p["t"] - t["t"])
            if d < bd: bd, best = d, j
        if best is not None:
            pairs.append((p, truth[best])); used.add(best)
    up = [p for p in pred if not any(p is a for a, _ in pairs)]
    ut = [t for j, t in enumerate(truth) if j not in used]
    return pairs, up, ut

def make_resolver(identities):
    """Follow app-side merge chains: original cluster -> surviving cluster.
    (merged_into holds identity ROW ids, hence the double lookup.)"""
    by_row = {i["id"]: i for i in identities if "id" in i}
    by_cluster = {i["cluster_id"]: i for i in identities}
    def resolve(cid):
        i, seen = by_cluster.get(cid), set()
        while i and i.get("merged_into") is not None and i["id"] not in seen:
            seen.add(i["id"])
            i = by_row.get(i["merged_into"])
        return i["cluster_id"] if i else cid
    return resolve

def main():
    corr = json.load(open(sys.argv[1]))
    pipe = json.load(open(sys.argv[2]))
    resolve = make_resolver(corr.get("identities", []))
    pairs_all, fp_all, fn_all = [], 0, 0
    conf = Counter()
    attr_ok = attr_tot = attr_none = 0
    per_type = defaultdict(lambda: [0, 0])   # type -> [correct, total]

    # rallies split in the app share one pipeline idx — regroup so each
    # pipeline rally is scored against the union of its halves' plays.
    # idx -1 = rally added manually in the app (detector missed it entirely).
    by_idx = defaultdict(list)
    manual = 0
    for cr in corr["rallies"]:
        if cr["phase"] != "game": continue
        if cr["idx"] is None or cr["idx"] < 0: manual += 1; continue
        by_idx[cr["idx"]].append(cr)
    for idx, crs in sorted(by_idx.items()):
        pr = pipe["rallies"][idx]
        pred = pr.get("contacts", [])
        truth = sorted((p for cr in crs for p in cr["plays"]), key=lambda p: p["t"])
        pairs, up, ut = match(pred, truth)
        pairs_all += pairs; fp_all += len(up); fn_all += len(ut)
        for p, t in pairs:
            pt, tt = p.get("play"), t.get("play_type")
            if tt:
                conf[(tt, pt)] += 1
                per_type[tt][1] += 1
                if pt == tt: per_type[tt][0] += 1
            if t.get("cluster_id") is not None:
                if p.get("cluster") is None:
                    attr_none += 1
                else:
                    attr_tot += 1
                    if resolve(p["cluster"]) == t["cluster_id"]: attr_ok += 1

    n = len(pairs_all)
    prec = n / (n + fp_all) if n + fp_all else 0
    rec = n / (n + fn_all) if n + fn_all else 0
    print(f"=== {corr.get('name','?')} (reviewed {corr['review_stats']['corrected_or_removed']} corrections) ===")
    print(f"contact detection: precision {prec:.0%}  recall {rec:.0%}  "
          f"(matched {n}, spurious {fp_all}, missed {fn_all})")
    tot_ok = sum(c for (t, p), c in conf.items() if t == p)
    tot = sum(conf.values())
    if tot:
        print(f"play type accuracy (on matched): {tot_ok/tot:.0%}")
        for t in sorted(per_type):
            ok, tt = per_type[t]
            wrong = Counter({p: c for (tr, p), c in conf.items() if tr == t and p != t})
            w = ", ".join(f"{p or '?'}×{c}" for p, c in wrong.most_common(3))
            print(f"  {t:14s} {ok:3d}/{tt:<3d} {'  confused with: ' + w if w else ''}")
    if attr_tot:
        print(f"player attribution (when attempted): {attr_ok}/{attr_tot} "
              f"({attr_ok/attr_tot:.0%}); declined to attribute: {attr_none}")
    if manual:
        print(f"rallies the detector missed entirely (added by reviewer): {manual}")
    print("\nNote: metrics assume the review is complete for game-phase rallies.")

if __name__ == "__main__":
    main()
