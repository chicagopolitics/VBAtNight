#!/bin/bash
# Zip the pipeline for Colab upload (zip to /tmp first: OneDrive dislikes in-place zip)
cd "$(dirname "$0")"
rm -f /tmp/vbpipe.zip vbpipe.zip
zip -q -r /tmp/vbpipe.zip pyproject.toml README.md vbpipe ball_v3.json
cp /tmp/vbpipe.zip vbpipe.zip
echo "wrote vbpipe.zip -> upload in colab_run.ipynb Cell 2"
