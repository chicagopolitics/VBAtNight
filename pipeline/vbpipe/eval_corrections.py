"""Score pipeline output against human-reviewed corrections from the app.
Usage: python -m vbpipe.eval_corrections corr_gameN.json game.json [corr2 game2 ...]
(game.json = the pipeline output that was originally imported)

Headline metric — JOINT PARSE: the share of ground-truth touches the pipeline
fully parsed (contact captured AND play family correct AND right player).
This is the "ML does >=75%, reviewer fixes the rest" number. Its denominator
includes touches in rallies the detector missed entirely (idx -1), unlike the
per-stage metrics below, which only cover detector-found rallies."""
import json, sys
from collections import Counter, defaultdict

MATCH_S = 0.5   # contacts within this many seconds are considered the same touch
FAMILY = {"receive": "defense", "dig": "defense"}   # same touch family
fam = lambda t: FAMILY.get(t, t)

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

def new_tally():
    return dict(matched=0, fp=0, fn=0, attr_ok=0, attr_tot=0, attr_none=0,
                gt=0, cap=0, fam_ok=0, joint=0,
                manual_rallies=0, manual_touches=0)

def score(corr, pipe, s, conf, per_type):
    """Accumulate one game's numbers into tallies s / conf / per_type."""
    resolve = make_resolver(corr.get("identities", []))

    # rallies split in the app share one pipeline idx — regroup so each
    # pipeline rally is scored against the union of its halves' plays.
    # idx -1 = rally added manually in the app (detector missed it entirely).
    by_idx = defaultdict(list)
    for cr in corr["rallies"]:
        if cr["phase"] != "game": continue
        if cr["idx"] is None or cr["idx"] < 0:
            tp = sum(1 for p in cr["plays"] if p.get("play_type"))
            s["manual_rallies"] += 1
            s["manual_touches"] += tp
            s["gt"] += tp        # missed outright still counts against JOINT
            continue
        by_idx[cr["idx"]].append(cr)

    for idx, crs in sorted(by_idx.items()):
        pr = pipe["rallies"][idx]
        pred = pr.get("contacts", [])
        truth = sorted((p for cr in crs for p in cr["plays"]), key=lambda p: p["t"])
        pairs, up, ut = match(pred, truth)
        s["matched"] += len(pairs); s["fp"] += len(up); s["fn"] += len(ut)
        s["gt"] += sum(1 for t in truth if t.get("play_type"))
        for p, t in pairs:
            pt, tt = p.get("play"), t.get("play_type")
            if not tt: continue
            conf[(tt, pt)] += 1
            per_type[tt][1] += 1
            if pt == tt: per_type[tt][0] += 1
            attr_judged = t.get("cluster_id") is not None
            attr_right = (attr_judged and p.get("cluster") is not None
                          and resolve(p["cluster"]) == t["cluster_id"])
            if attr_judged:
                if p.get("cluster") is None: s["attr_none"] += 1
                else:
                    s["attr_tot"] += 1
                    if attr_right: s["attr_ok"] += 1
            # --- joint funnel, per ground-truth touch ---
            s["cap"] += 1
            f_ok = fam(pt or "") == fam(tt)
            a_ok = (not attr_judged) or attr_right   # unnamed GT touch: can't judge
            if f_ok: s["fam_ok"] += 1
            if f_ok and a_ok: s["joint"] += 1

def report(title, s, conf, per_type):
    print(f"=== {title} ===")
    if s["gt"]:
        cap_r = s["cap"] / s["gt"]
        fam_r = s["fam_ok"] / s["cap"] if s["cap"] else 0
        att_r = s["joint"] / s["fam_ok"] if s["fam_ok"] else 0
        print(f"JOINT PARSE: {s['joint']}/{s['gt']} = {s['joint']/s['gt']:.0%} "
              f"of true touches fully parsed (target 75%)")
        print(f"  funnel: captured {cap_r:.0%} -> family typed {fam_r:.0%} "
              f"-> right player {att_r:.0%}")
        if s["manual_touches"]:
            print(f"  (denominator includes {s['manual_touches']} touches in "
                  f"{s['manual_rallies']} detector-missed rallies)")
    n = s["matched"]
    prec = n / (n + s["fp"]) if n + s["fp"] else 0
    rec = n / (n + s["fn"]) if n + s["fn"] else 0
    print(f"contact detection: precision {prec:.0%}  recall {rec:.0%}  "
          f"(matched {n}, spurious {s['fp']}, missed {s['fn']})")
    tot_ok = sum(c for (t, p), c in conf.items() if t == p)
    tot = sum(conf.values())
    if tot:
        fam_ok = sum(c for (t, p), c in conf.items() if fam(t) == fam(p or ""))
        print(f"play type accuracy (on matched): {tot_ok/tot:.0%} exact, "
              f"{fam_ok/tot:.0%} family (dig~receive)")
        for t in sorted(per_type):
            ok, tt = per_type[t]
            wrong = Counter({p: c for (tr, p), c in conf.items() if tr == t and p != t})
            w = ", ".join(f"{p or '?'}×{c}" for p, c in wrong.most_common(3))
            print(f"  {t:14s} {ok:3d}/{tt:<3d} {'  confused with: ' + w if w else ''}")
    if s["attr_tot"]:
        print(f"player attribution (when attempted): {s['attr_ok']}/{s['attr_tot']} "
              f"({s['attr_ok']/s['attr_tot']:.0%}); declined to attribute: {s['attr_none']}")
    if s["manual_rallies"]:
        print(f"rallies the detector missed entirely (added by reviewer): {s['manual_rallies']}")

def main():
    args = sys.argv[1:]
    if len(args) < 2 or len(args) % 2:
        sys.exit(__doc__)
    games = [(args[i], args[i + 1]) for i in range(0, len(args), 2)]
    tot_s, tot_conf, tot_pt = new_tally(), Counter(), defaultdict(lambda: [0, 0])
    for corr_path, pipe_path in games:
        corr = json.load(open(corr_path))
        pipe = json.load(open(pipe_path))
        s, conf, pt = new_tally(), Counter(), defaultdict(lambda: [0, 0])
        score(corr, pipe, s, conf, pt)
        rev = corr.get("review_stats", {}).get("corrected_or_removed")
        report(f"{corr.get('name','?')}" + (f" (reviewed {rev} corrections)" if rev else ""),
               s, conf, pt)
        print()
        for k in tot_s: tot_s[k] += s[k]
        tot_conf.update(conf)
        for t, (ok, n) in pt.items():
            tot_pt[t][0] += ok; tot_pt[t][1] += n
    if len(games) > 1:
        report(f"OVERALL ({len(games)} games)", tot_s, tot_conf, tot_pt)
    print("\nNote: metrics assume the review is complete for game-phase rallies.")

if __name__ == "__main__":
    main()
