# 1.0.0 = the frozen training baseline (2026-08-07). Games processed at this
# version or later produce labels that may be pooled into a training set; the
# cca-one / cca-two corrections predate it and are EVALUATION-ONLY. See
# ML-PLAN.md. Bump the MINOR version whenever a change alters model output
# (models, thresholds, sampling rates) so label generations stay separable.
#
# 1.1.0 (2026-08-07): first retune for the elevated LNV camera, from g1
# measurements — attribution geometry (y-weight 0.6->0.25, gate 220->90,
# drop 340->150) and cluster_thresh 0.12->0.10. Output-changing, so games
# processed at 1.0.0 must NOT be pooled with 1.1.0 games for training.
__version__ = "1.1.0"
