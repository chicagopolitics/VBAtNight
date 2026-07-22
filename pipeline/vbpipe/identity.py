"""OSNet embeddings per tracklet + temporally-constrained agglomerative clustering.
Approach validated in M1 spike (tracklet means + cannot-link on temporal overlap)."""
import numpy as np, os

def embed_tracklets(tracklets, out_dir, cfg, device="cuda"):
    import torch, torchreid, cv2
    import torchvision.transforms as T
    m = torchreid.models.build_model(cfg.reid_model, num_classes=1,
                                     pretrained=True).to(device).eval()
    tf = T.Compose([T.ToPILImage(), T.Resize((256,128)), T.ToTensor(),
                    T.Normalize([0.485,0.456,0.406],[0.229,0.224,0.225])])
    for tr in tracklets:
        ims = []
        for fn in tr["crops"]:
            im = cv2.imread(os.path.join(out_dir, fn))
            if im is not None:
                ims.append(tf(cv2.cvtColor(im, cv2.COLOR_BGR2RGB)))
        if not ims:
            tr["emb"] = None; continue
        with torch.no_grad():
            e = m(torch.stack(ims).to(device)).cpu().numpy()
        e = e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-9)
        v = e.mean(0)
        tr["emb"] = (v / (np.linalg.norm(v) + 1e-9)).tolist()
    return tracklets

def cluster(tracklets, cfg):
    """Greedy agglomerative w/ cannot-link between temporally overlapping tracklets.
    Sets tr['cluster']; returns clusters [{id, tracklets, n_boxes, rep_crops}]."""
    ts = [tr for tr in tracklets if tr.get("emb")]
    V = np.array([tr["emb"] for tr in ts])
    iv = [(tr["t0"], tr["t1"]) for tr in ts]
    def overlap(a, b):
        return not (iv[a][1] < iv[b][0] - 0.2 or iv[b][1] < iv[a][0] - 0.2)
    groups = [{i} for i in range(len(ts))]
    vecs = [V[i].copy() for i in range(len(ts))]
    while True:
        best, bd = None, cfg.cluster_thresh
        for a in range(len(groups)):
            if groups[a] is None: continue
            for b in range(a+1, len(groups)):
                if groups[b] is None: continue
                if any(overlap(x, y) for x in groups[a] for y in groups[b]): continue
                d = 1 - float(np.dot(vecs[a], vecs[b]) /
                    (np.linalg.norm(vecs[a])*np.linalg.norm(vecs[b]) + 1e-9))
                if d < bd: best, bd = (a, b), d
        if best is None: break
        a, b = best
        groups[a] |= groups[b]
        vecs[a] = np.mean([V[i] for i in groups[a]], axis=0)
        groups[b] = None
    out = []
    for g in [g for g in groups if g]:
        members = sorted(g, key=lambda i: -(len(ts[i]["boxes"])))
        cid = len(out)
        for i in g: ts[i]["cluster"] = cid
        out.append({"id": cid,
                    "n_boxes": sum(len(ts[i]["boxes"]) for i in g),
                    "rep_crops": [c for i in members[:3] for c in ts[i]["crops"][:2]]})
    out.sort(key=lambda c: -c["n_boxes"])
    return out
