import cv2, glob, numpy as np, json, os
from sklearn.cluster import AgglomerativeClustering
OUT = "/sessions/eloquent-dazzling-hawking/mnt/outputs/spike"
files = sorted(glob.glob(f"{OUT}/crops/*.jpg"))
feats, keep = [], []
for f in files:
    im = cv2.imread(f)
    h, w = im.shape[:2]
    if h < 50: continue
    torso = im[int(h*0.18):int(h*0.55)]
    legs  = im[int(h*0.55):int(h*0.85)]
    fv = []
    for part in (torso, legs):
        hsv = cv2.cvtColor(part, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv],[0,1],None,[12,4],[0,180,0,256])
        hist = cv2.normalize(hist,None,norm_type=cv2.NORM_L1).flatten()
        v = cv2.calcHist([hsv],[2],None,[6],[0,256])
        v = cv2.normalize(v,None,norm_type=cv2.NORM_L1).flatten()
        fv.extend(hist); fv.extend(v)
    feats.append(fv); keep.append(f)
X = np.array(feats, np.float32)
X = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-8)
cl = AgglomerativeClustering(n_clusters=None, distance_threshold=0.32,
                             metric="cosine", linkage="complete").fit(X)
lab = cl.labels_
n = lab.max()+1
sizes = np.bincount(lab)
order = np.argsort(-sizes)
print(f"{len(keep)} crops -> {n} clusters; sizes: {sorted(sizes,reverse=True)}")
big = [c for c in order if sizes[c] >= 8]
print(f"clusters with >=8 crops: {len(big)} covering {sum(sizes[c] for c in big)} crops")
json.dump({os.path.basename(keep[i]): int(lab[i]) for i in range(len(keep))},
          open(f"{OUT}/cluster_labels.json","w"))
# montage: one row per big cluster, 10 samples spread across time
rows = []
for c in big[:16]:
    idx = [i for i in range(len(keep)) if lab[i]==c]
    idx = idx[::max(1,len(idx)//10)][:10]
    tiles=[]
    for i in idx:
        im = cv2.imread(keep[i]); s = 110/im.shape[0]
        tiles.append(cv2.resize(im,(max(16,int(im.shape[1]*s)),110)))
    wsum = sum(t.shape[1] for t in tiles)+len(tiles)*3+60
    canvas = np.zeros((116,wsum,3),np.uint8)
    cv2.putText(canvas,f"C{c}:{sizes[c]}",(2,60),0,0.5,(255,255,255),1)
    x=60
    for t in tiles: canvas[3:113,x:x+t.shape[1]]=t; x+=t.shape[1]+3
    rows.append(canvas)
wm = max(r.shape[1] for r in rows)
rows=[np.pad(r,((0,0),(0,wm-r.shape[1]),(0,0))) for r in rows]
cv2.imwrite(f"{OUT}/clusters.jpg", np.vstack(rows))
