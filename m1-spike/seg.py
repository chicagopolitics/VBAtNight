import numpy as np, json, glob
OUT = "/sessions/eloquent-dazzling-hawking/mnt/outputs/spike"
MFPS, AFPS = 1.0, 4.0
m = np.concatenate([np.load(f) for f in sorted(glob.glob(f"{OUT}/motion_*.npy"))])
pk = np.load(f"{OUT}/audio_peak.npy")
ms = np.convolve(m, np.ones(3)/3, mode="same")
lo, hi = np.percentile(ms, 20), np.percentile(ms, 90)
thr = lo + 0.35*(hi-lo)
active = ms > thr
segs, start, merged = [], None, []
for i, v in enumerate(active):
    if v and start is None: start = i
    elif not v and start is not None: segs.append([start/MFPS, i/MFPS]); start = None
if start is not None: segs.append([start/MFPS, len(active)/MFPS])
for s in segs:
    if merged and s[0]-merged[-1][1] < 4: merged[-1][1] = s[1]
    else: merged.append(list(s))
merged = [s for s in merged if s[1]-s[0] >= 6]
pk_thr = np.percentile(pk, 92)
res = []
for s0, s1 in merged:
    a0, a1 = int(s0*AFPS), int(s1*AFPS)
    t = int((pk[a0:a1] > pk_thr).sum()); d = s1-s0
    res.append({"start": round(s0,1), "end": round(s1,1), "dur": round(d,1),
                "c10": round(t/d*10,1)})
tot = sum(r["dur"] for r in res)
print(f"video {len(m)}s | {len(res)} segments | active {tot:.0f}s ({tot/len(m)*100:.0f}%)")
for r in res: print(f"  {r['start']:7.1f}-{r['end']:7.1f} ({r['dur']:5.1f}s) contacts/10s={r['c10']:5.1f}")
json.dump(res, open(f"{OUT}/segments.json","w"), indent=1)
