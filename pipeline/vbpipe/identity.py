"""OSNet embeddings per tracklet + temporally-constrained agglomerative clustering.
Approach validated in M1 spike (tracklet means + cannot-link on temporal overlap)."""
import numpy as np, os

# Same file name and directory torchreid cached to, so a machine that already
# ran the old code path reuses its download instead of fetching again.
_WEIGHTS_URL = ("https://drive.google.com/uc?export=download&"
                "id=1LaG1EJpHrxdAxKnSCJ_i0u-nbxSAeiFY")

def default_reid_weights():
    return os.path.join(os.path.expanduser("~/.cache/torch/checkpoints"),
                        "osnet_x1_0_imagenet.pth")

# sha256 of osnet_x1_0_imagenet.pth (10,910,553 bytes) as served 2026-08-10.
# Checked because the source is a Google Drive link: when Drive rate-limits it
# serves an HTML interstitial with a 200, which would otherwise land on disk as
# a "checkpoint" and fail much later inside torch.load with nothing pointing at
# the real cause.
_WEIGHTS_SHA256 = "fe2d63f9157c28a4a8d8ca29bec12d5b2988ac0346d712025789ea9174968e79"

def _sha256(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def _ensure_weights(path, expect=_WEIGHTS_SHA256):
    if os.path.exists(path):
        return path
    import urllib.request
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print(f"[embed] downloading OSNet weights -> {path}")
    tmp = path + ".part"
    urllib.request.urlretrieve(_WEIGHTS_URL, tmp)
    got = _sha256(tmp)
    if expect and got != expect:
        os.remove(tmp)
        raise RuntimeError(
            f"OSNet weight download failed checksum (got {got[:16]}..., "
            f"expected {expect[:16]}...). Google Drive most likely served an "
            f"error page instead of the file; retry, or fetch it by hand to "
            f"{path}")
    os.replace(tmp, path)
    return path

def build_reid(cfg, device="cuda"):
    """OSNet in eval mode, with weights loaded from an explicit checkpoint.

    Replaces `torchreid.models.build_model(..., pretrained=True)`. Same
    architecture (vendored verbatim in `osnet.py`) and same weights, so
    embeddings are unchanged — verified against the stored `emb` vectors of a
    game processed on Colab under the old path.

    Two things worth stating plainly, because the old one-liner hid both:

    * `pretrained=True` loaded `osnet_x1_0_IMAGENET.pth` — an ImageNet
      classification backbone, never trained on a person re-ID objective.
      That is what the 0.57 embedding AUC was measured on.
    * Mismatched keys are skipped, not errors. The checkpoint carries a
      1000-class `classifier`, the model is built with `num_classes=1`, and
      eval-mode forward returns the pooled feature before the classifier — so
      those two tensors are irrelevant. torchreid silently dropped them; we do
      the same, deliberately.

    Point `cfg.reid_weights` at a fine-tuned checkpoint to override (ML-PLAN
    Phase 2). It is recorded in the pipeline stamp either way.
    """
    import torch
    from . import osnet as _osnet
    m = getattr(_osnet, cfg.reid_model)(num_classes=1, pretrained=False)
    path = _ensure_weights(cfg.reid_weights or default_reid_weights())
    # Resolve back onto the config so the stamp records WHICH checkpoint ran
    # rather than "None" — cli.py stamps the config after this call, and
    # "which weights produced this game.json" is exactly the question the
    # stamping discipline exists to answer.
    cfg.reid_weights = path
    sd = torch.load(path, map_location="cpu", weights_only=True)
    # Model-zoo checkpoints are raw state dicts, but torchreid's TRAINER saves
    # {'state_dict': ..., 'epoch': ...} — which is the shape a Phase 2
    # fine-tune will produce. Accept both rather than fail on our own output.
    if isinstance(sd, dict) and "state_dict" in sd:
        sd = sd["state_dict"]
    md = m.state_dict()
    keep = {k[7:] if k.startswith("module.") else k: v for k, v in sd.items()}
    keep = {k: v for k, v in keep.items()
            if k in md and md[k].size() == v.size()}
    if not keep:
        raise RuntimeError(f"no weights in {path} matched {cfg.reid_model}")
    md.update(keep)
    m.load_state_dict(md)
    print(f"[embed] {cfg.reid_model}: loaded {len(keep)}/{len(md)} tensors "
          f"from {os.path.basename(path)}")
    return m.to(device).eval()

def embed_tracklets(tracklets, out_dir, cfg, device="cuda"):
    import torch, cv2
    import torchvision.transforms as T
    m = build_reid(cfg, device)
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
