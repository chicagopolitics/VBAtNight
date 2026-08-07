# 1.0.0 = the frozen training baseline (2026-08-07). Games processed at this
# version or later produce labels that may be pooled into a training set; the
# cca-one / cca-two corrections predate it and are EVALUATION-ONLY. See
# ML-PLAN.md. Bump the MINOR version whenever a change alters model output
# (models, thresholds, sampling rates) so label generations stay separable.
__version__ = "1.0.0"
