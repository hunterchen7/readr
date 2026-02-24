#!/usr/bin/env python3
"""Download TTS model weights on first run."""

import os
import sys

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "/models")


def download_chatterbox():
    """Download Chatterbox Original + Turbo weights from HuggingFace."""
    try:
        from huggingface_hub import snapshot_download

        target = os.path.join(MODEL_DIR, "chatterbox")
        if os.path.exists(os.path.join(target, "config.json")):
            print("Chatterbox models already downloaded, skipping.")
            return

        print("Downloading Chatterbox models...")
        snapshot_download(
            "ResembleAI/chatterbox",
            local_dir=target,
            ignore_patterns=["*.md", "*.txt"],
        )
        print("Chatterbox download complete.")
    except ImportError:
        print("huggingface_hub not installed. Run: pip install huggingface_hub")
        sys.exit(1)


def download_kokoro():
    """Download Kokoro weights from HuggingFace."""
    try:
        from huggingface_hub import snapshot_download

        target = os.path.join(MODEL_DIR, "kokoro")
        if os.path.exists(os.path.join(target, "config.json")):
            print("Kokoro models already downloaded, skipping.")
            return

        print("Downloading Kokoro models...")
        snapshot_download(
            "hexgrad/Kokoro-82M",
            local_dir=target,
            ignore_patterns=["*.md", "*.txt"],
        )
        print("Kokoro download complete.")
    except ImportError:
        print("huggingface_hub not installed. Run: pip install huggingface_hub")
        sys.exit(1)


if __name__ == "__main__":
    os.makedirs(MODEL_DIR, exist_ok=True)
    download_chatterbox()
    download_kokoro()
    print("All models downloaded.")
