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
    # Phase-A coverage pass (2026-07-24): the true toucher was tracked at only
    # ~55% of touches with nano@conf0.35@10fps, which capped attribution ~25%
    # regardless of downstream tuning. Bigger model sees far-court players,
    # lower conf keeps faint/occluded ones, higher fps gives ByteTrack denser
    # frames = fewer ID switches = less cluster fragmentation. Costs ~4-6x
    # track-stage time on a T4. Revert any of these if a reprocess shows no
    # coverage gain (measure: concurrent tracked players, target ~11-12/12).
    det_model: str = "yolo11m.pt"      # was yolo11n; m is the T4 sweet spot
    det_conf: float = 0.20             # was 0.35
    det_fps: float = 15.0              # was 10
    det_imgsz: int = 1280              # inference size for person tracking;
                                       # ultralytics' 640 default halves 720p
    min_box_h_px: int = 45             # at 720p
    court_margin_px: int = 90          # feet may be this far OUTSIDE playing_area
                                       # (serve zones / back-row range; at 720p)
    crop_hires: bool = True            # save player crops from native 1080p for
                                       # the re-ID embed stage (identity probe);
                                       # detection still runs on the 720p view
    # attribution geometry (plays.attribute) — PER CAMERA, not universal.
    # Retuned 2026-08-07 for the elevated LNV camera, measured on g1:
    # the old side camera put the ball a median 129px from the nearest player
    # with dy/dx ~= 1.0; the elevated view compresses horizontal separation
    # (dx 22px) while vertical offset stays (dy 75px), so dy/dx jumped to 3.4.
    # Vertical offset at contact is mostly "ball above the player" — expected,
    # not a discriminator — so it gets discounted harder, and the gate comes
    # down to match the much tighter distance distribution.
    #   at y-weight 0.6: p95 contact distance 131px vs 135px half-spacing -> no margin
    #   at y-weight 0.25: p95 87px vs 134px                               -> usable margin
    # The gate MUST stay well under half the median inter-player spacing
    # (~268px here), or nearest-player attribution is guessing between two
    # candidates. pipeline/camera_check.py reports all three numbers.
    attr_y_weight: float = 0.25   # was 0.6 (old side camera)
    attr_gate_px: float = 90      # was 220; ~p95 of observed contact distances
    attr_drop_px: float = 150     # was 340; beyond this, nobody plausible -> spurious
    # embedding / clustering
    reid_model: str = "osnet_x1_0"
    # Checkpoint for reid_model. None = the ImageNet-pretrained OSNet weights
    # that torchreid's pretrained=True fetched, cached under ~/.cache/torch.
    # Set to a path to use a fine-tuned checkpoint (ML-PLAN Phase 2); the value
    # lands in the pipeline stamp, so which weights produced a game.json is
    # always recoverable.
    reid_weights: str = None
    min_tracklet_len: int = 3
    # Lowered 0.12 -> 0.10 (2026-08-07): over-split beats under-split (merges
    # are 1 click, splits are surgery), and on the elevated camera the OSNet
    # distances between provably-different tracklets shrank ~0.85x (median
    # 0.164 -> 0.139), pushing the false-merge risk from 24% to 35% of pairs
    # at the old threshold. 0.10 restores roughly the previous risk level.
    cluster_thresh: float = 0.10  # cosine distance on tracklet means
