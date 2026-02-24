#!/usr/bin/env python3
"""
TTS Worker — processes jobs from Redis queue.

Listens for 'generate-chapter' jobs, generates audio using Chatterbox or Kokoro,
uploads to S3/R2, and reports progress back to Postgres.
"""

import json
import io
import os
import time
import logging
from typing import Optional

import redis
import boto3
import psycopg2
import soundfile as sf
import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("tts-worker")

# Config from environment
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
DATABASE_URL = os.environ.get("DATABASE_URL", "")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "")
S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "")
S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY", "")
S3_REGION = os.environ.get("S3_REGION", "auto")
MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "/models")

# Lazy-loaded engines
_chatterbox_model = None
_kokoro_model = None


def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        region_name=S3_REGION,
    )


def get_db_connection():
    return psycopg2.connect(DATABASE_URL)


def load_chatterbox(variant: str = "turbo"):
    """Load Chatterbox model (lazy, cached)."""
    global _chatterbox_model
    if _chatterbox_model is not None:
        return _chatterbox_model

    try:
        import chatterbox

        model_path = os.path.join(MODEL_DIR, "chatterbox")
        logger.info(f"Loading Chatterbox ({variant}) from {model_path}...")
        _chatterbox_model = chatterbox.load_model(model_path, variant=variant)
        logger.info("Chatterbox loaded successfully.")
        return _chatterbox_model
    except Exception as e:
        logger.error(f"Failed to load Chatterbox: {e}")
        raise


def load_kokoro():
    """Load Kokoro model (lazy, cached)."""
    global _kokoro_model
    if _kokoro_model is not None:
        return _kokoro_model

    try:
        import kokoro

        model_path = os.path.join(MODEL_DIR, "kokoro")
        logger.info(f"Loading Kokoro from {model_path}...")
        _kokoro_model = kokoro.load_model(model_path)
        logger.info("Kokoro loaded successfully.")
        return _kokoro_model
    except Exception as e:
        logger.error(f"Failed to load Kokoro: {e}")
        raise


def generate_audio(text: str, engine: str, voice_config: Optional[dict] = None) -> tuple[np.ndarray, int]:
    """Generate audio from text using the specified engine.
    Returns (audio_array, sample_rate).
    """
    if engine in ("chatterbox", "chatterbox-turbo"):
        variant = "turbo" if "turbo" in engine else "original"
        model = load_chatterbox(variant)
        exaggeration = (voice_config or {}).get("exaggeration", 0.5)
        speed = (voice_config or {}).get("speed", 1.0)
        audio = model.generate(text, exaggeration=exaggeration, speed=speed)
        return audio, 24000
    elif engine == "kokoro":
        model = load_kokoro()
        audio = model.generate(text)
        return audio, 24000
    else:
        raise ValueError(f"Unknown engine: {engine}")


def encode_opus(audio: np.ndarray, sample_rate: int) -> bytes:
    """Encode audio array to Opus format in an OGG container."""
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="OGG", subtype="OPUS")
    buf.seek(0)
    return buf.read()


def upload_audio(s3_client, user_id: str, book_id: str, chapter_index: int, audio_bytes: bytes) -> str:
    """Upload audio to S3/R2 and return the key."""
    key = f"{user_id}/tts/{book_id}/{chapter_index}.opus"
    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=audio_bytes,
        ContentType="audio/ogg",
    )
    return key


def update_progress(conn, job_id: str, chapter_index: int, audio_key: str, duration_ms: int):
    """Update job progress and insert audio chunk record."""
    with conn.cursor() as cur:
        # Insert audio chunk
        cur.execute(
            """INSERT INTO tts_audio_chunks (id, job_id, chapter_index, audio_key, duration_ms, format)
               VALUES (gen_random_uuid(), %s, %s, %s, %s, 'opus')""",
            (job_id, chapter_index, audio_key, duration_ms),
        )

        # Increment chapters_done
        cur.execute(
            """UPDATE tts_jobs SET chapters_done = chapters_done + 1 WHERE id = %s""",
            (job_id,),
        )

        # Check if all chapters are done
        cur.execute(
            """SELECT chapters_done, chapters_total FROM tts_jobs WHERE id = %s""",
            (job_id,),
        )
        row = cur.fetchone()
        if row and row[0] >= row[1]:
            cur.execute(
                """UPDATE tts_jobs SET status = 'done', completed_at = NOW() WHERE id = %s""",
                (job_id,),
            )

    conn.commit()


def mark_failed(conn, job_id: str, error: str):
    """Mark a TTS job as failed."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE tts_jobs SET status = 'failed', error = %s WHERE id = %s""",
            (error, job_id),
        )
    conn.commit()


def process_job(job_data: dict):
    """Process a single TTS chapter generation job."""
    job_id = job_data["jobId"]
    book_id = job_data["bookId"]
    user_id = job_data["userId"]
    chapter_index = job_data["chapterIndex"]
    text = job_data["text"]
    engine = job_data.get("engine", "chatterbox-turbo")
    voice_config = job_data.get("voiceConfig")

    logger.info(f"Processing job {job_id}, chapter {chapter_index}, engine={engine}")

    conn = get_db_connection()
    s3_client = get_s3_client()

    try:
        # Mark job as processing
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE tts_jobs SET status = 'processing' WHERE id = %s AND status = 'queued'""",
                (job_id,),
            )
        conn.commit()

        # Generate audio
        start = time.time()
        audio, sample_rate = generate_audio(text, engine, voice_config)
        gen_time = time.time() - start
        logger.info(f"Generated {len(audio) / sample_rate:.1f}s audio in {gen_time:.1f}s")

        # Encode to Opus
        audio_bytes = encode_opus(audio, sample_rate)
        duration_ms = int(len(audio) / sample_rate * 1000)

        # Upload to S3
        audio_key = upload_audio(s3_client, user_id, book_id, chapter_index, audio_bytes)

        # Update progress
        update_progress(conn, job_id, chapter_index, audio_key, duration_ms)

        logger.info(f"Chapter {chapter_index} complete: {audio_key}")

    except Exception as e:
        logger.error(f"Failed to process chapter {chapter_index}: {e}")
        mark_failed(conn, job_id, str(e))
    finally:
        conn.close()


def main():
    """Main loop — listen for jobs from Redis queue."""
    logger.info("TTS Worker starting...")
    logger.info(f"Redis: {REDIS_URL}")
    logger.info(f"Model dir: {MODEL_DIR}")

    r = redis.from_url(REDIS_URL)

    # BullMQ stores jobs in Redis lists with specific key patterns
    queue_key = "bull:tts:wait"

    logger.info(f"Listening for jobs on {queue_key}...")

    while True:
        try:
            # BRPOP blocks until a job is available
            result = r.brpop(queue_key, timeout=5)
            if result is None:
                continue

            _, raw_job_id = result
            job_id = raw_job_id.decode() if isinstance(raw_job_id, bytes) else raw_job_id

            # Get job data from BullMQ's hash
            job_data_raw = r.hget(f"bull:tts:{job_id}", "data")
            if not job_data_raw:
                logger.warning(f"No data found for job {job_id}")
                continue

            job_data = json.loads(job_data_raw)
            process_job(job_data)

            # Mark as completed in BullMQ
            r.hset(f"bull:tts:{job_id}", "finishedOn", str(int(time.time() * 1000)))

        except KeyboardInterrupt:
            logger.info("Shutting down...")
            break
        except Exception as e:
            logger.error(f"Worker error: {e}")
            time.sleep(1)


if __name__ == "__main__":
    main()
