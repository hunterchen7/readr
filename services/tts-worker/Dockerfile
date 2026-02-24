FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04

# Python setup
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .

# Model directory mounted as volume
ENV TTS_MODEL_DIR=/models

# Run both worker and API
# Worker processes queue jobs, API serves streaming + health
CMD ["sh", "-c", "python3 worker.py & uvicorn api:app --host 0.0.0.0 --port 8000"]
