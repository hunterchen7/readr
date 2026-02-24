#!/usr/bin/env python3
"""
TTS Streaming API — FastAPI server for real-time TTS and health checks.
"""

import io
import os
import logging

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("tts-api")

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "/models")

app = FastAPI(title="Readr TTS API")

# Track loaded engines
_loaded_engines: list[str] = []


@app.on_event("startup")
async def startup():
    """Detect available engines on startup."""
    global _loaded_engines

    # Check which engines are available based on model files
    if os.path.exists(os.path.join(MODEL_DIR, "chatterbox")):
        _loaded_engines.append("chatterbox")
        _loaded_engines.append("chatterbox-turbo")

    if os.path.exists(os.path.join(MODEL_DIR, "kokoro")):
        _loaded_engines.append("kokoro")

    logger.info(f"Available engines: {_loaded_engines}")


@app.get("/health")
async def health():
    """Health check endpoint — called by API server to determine TTS availability."""
    import torch

    return {
        "status": "ok",
        "engines": _loaded_engines,
        "gpu": torch.cuda.is_available(),
    }


class StreamRequest(BaseModel):
    text: str
    voice_config: Optional[dict] = None


@app.post("/tts/stream")
async def stream_tts(request: StreamRequest):
    """Real-time TTS using Kokoro for lowest latency.
    Returns chunked audio/opus stream.
    """
    if "kokoro" not in _loaded_engines:
        return {"error": "Kokoro engine not available"}, 503

    try:
        from worker import load_kokoro, encode_opus

        model = load_kokoro()
        audio = model.generate(request.text)
        audio_bytes = encode_opus(audio, 24000)

        return StreamingResponse(
            io.BytesIO(audio_bytes),
            media_type="audio/ogg",
            headers={"Content-Disposition": "inline"},
        )
    except Exception as e:
        logger.error(f"Streaming TTS error: {e}")
        return {"error": str(e)}, 500


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TTS_API_PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
