"""Per-venue configuration."""
from dataclasses import dataclass, field

# Court polygon in normalized coords (x/W, y/H), from M1 spike gym (corner camera).
DEFAULT_COURT = [(0.297,0.500),(0.664,0.493),(0.805,0.653),(0.781,0.944),
                 (0.078,0.993),(0.074,0.917)]

DEFAULT_NET = [(0.34, 0.667), (0.70, 0.796)]   # net post bases, normalized

@dataclass
class Config:
    court_poly: list = field(default_factory=lambda: list(DEFAULT_COURT))
    net_line: list = field(default_factory=lambda: list(DEFAULT_NET))

    # Future-use geometry captured by calibration (unused by current stages):
    court_corners: list = None   # 4 corners of painted court (homography)
    net_top: list = None         # net top at posts (height reference)
    attack_lines: list = None    # 3m line x sideline intersections (4 pts)

    @classmethod
    def from_court_file(cls, path):
        """Load geometry from the app's Camera setup page (v1 or v2 keys)."""
        import json
        cfg = cls()
        d = json.load(open(path))
        poly = d.get("playing_area") or d.get("court_poly")
        net = d.get("net_base") or d.get("net")
        if poly: cfg.court_poly = [tuple(p) for p in poly]
        if net: cfg.net_line = [tuple(p) for p in net]
        if d.get("court_corners"): cfg.court_corners = [tuple(p) for p in d["court_corners"]]
        if d.get("net_top"): cfg.net_top = [tuple(p) for p in d["net_top"]]
        if d.get("attack_lines"): cfg.attack_lines = [tuple(p) for p in d["attack_lines"]]
        return cfg
    # rally segmentation
    motion_thresh_frac: float = 0.35   # fraction between p20 and p90 of smoothed motion
    min_rally_s: float = 4.0
    max_gap_s: float = 4.0
    # detection / tracking
    det_model: str = "yolo11n.pt"
    det_conf: float = 0.35
    det_fps: float = 10.0
    min_box_h_px: int = 45             # at 720p
    # embedding / clustering
    reid_model: str = "osnet_x1_0"
    min_tracklet_len: int = 3
    cluster_thresh: float = 0.12  # lowered: over-split beats under-split (merges are 1 click, splits are surgery)       # cosine distance on tracklet means
