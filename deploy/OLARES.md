# Deploying readr to the Olares box

This is the current production-ish setup: docker compose on a single Olares
host, fronted by a Cloudflare Tunnel so the stack is reachable without
touching Olares's own port 80/443 (which the host k8s ingress owns).

Everything here is rsync-from-laptop. There's no CI deploy yet.

## One-time host setup

The Olares box is assumed to have:

- Ubuntu 24.04+, x86_64
- Docker 28+ with `docker compose` (confirmed: 28.2.2 / 2.37.1)
- A non-root user `ebook-deploy` in the `docker` group, with SSH key access
  from your laptop (our SSH config alias is `olares-ebook`)
- No process bound to 3000, 8080, 9000, 9001 (postgres on host port 5432 is
  fine — the compose stack only talks to its internal postgres)

Confirm SSH + docker work:

```bash
ssh olares-ebook "docker ps && docker compose version"
```

## Rsync the source

From the laptop repo root:

```bash
rsync -avz --delete \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='apps/mobile' \
  --exclude='apps/*/dist' \
  --exclude='apps/*/build' \
  --exclude='packages/*/dist' \
  --exclude='.turbo' \
  --exclude='coverage' \
  ./ olares-ebook:~/readr/
```

`.env` is excluded so the box keeps its own production secrets — rsync
will never clobber `~/readr/.env` after the initial setup. Edit
`~/readr/.env` directly on the box (and restart the api container) when
you need to rotate a key or add a new var.

`apps/mobile` is excluded — the server deploy doesn't need the RN app.

## Set up `.env` on the box

The compose file reads `.env` from the repo root on the Olares side. Put
values suitable for the box in there. Replace the placeholder hostnames /
tokens below with real ones.

```bash
ssh olares-ebook "cat > ~/readr/.env <<'ENV'
DATABASE_URL=postgresql://reader:password@localhost:5432/reader
REDIS_URL=redis://localhost:6379

S3_ENDPOINT=http://localhost:9000
# Update this once your cloudflared tunnel hostname is live. It's the
# origin clients (mobile app, web dashboard) will hit for presigned book
# downloads, so it MUST match the hostname the tunnel terminates at.
# For LAN-only testing: http://<olares-lan-ip>:9000
S3_PUBLIC_ENDPOINT=https://books.example.com
S3_BUCKET=reader-dev
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_REGION=auto
S3_FORCE_PATH_STYLE=true

PUBLIC_URL=https://reader.example.com
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
MAX_UPLOAD_SIZE_MB=500
DEFAULT_STORAGE_QUOTA_MB=4096

TTS_ENABLED=false
ENV"
```

## Two-stack layout

The deploy is split into two compose files so we can redeploy the app
without disturbing MinIO:

- `deploy/docker-compose.infra.yml` — Postgres, Redis, MinIO, and the
  one-shot `minio-init` bucket bootstrap. Long-lived; only touched
  when you intentionally bump infra.
- `deploy/docker-compose.app.yml` — the Hono `api` (and optional
  `caddy` profile). This is what gets rebuilt and `up -d`'d on every
  push.

Both stacks attach to a shared external Docker network named `readr`,
so the `api` container can still resolve `postgres`, `redis`, and
`minio` by their service names across stacks.

**Why split?** App redeploys no longer bounce MinIO, which means
`books.hunterchen.ca` never goes 5xx during a deploy, which means
Cloudflare never caches a poisoned 403/502 at the edge. That whole
class of cache-poisoning bug is gone.

## Bring up the stack

### One-time: create the shared network

```bash
ssh olares-ebook "docker network create readr"
```

(Idempotent — re-running just prints `network with name readr already exists` and exits non-zero, which is fine.)

### One-time (or when infra changes): start the infra stack

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.infra.yml up -d"
```

This starts:

- `readr-postgres-1` — internal only, owns `pgdata` volume
- `readr-redis-1` — internal only, owns `redisdata` volume
- `readr-minio-1` — S3 on `:9000`, console on `:9001`, owns `miniodata` volume
- `readr-minio-init-1` — one-shot bucket bootstrap, exits 0

Leave this running. Only re-run `up -d` against the infra file when
you deliberately want to bump a version (e.g. `postgres:16` →
`postgres:17`) or change a healthcheck. **Never bounce it during a
normal app redeploy.**

### Every deploy: start / restart the app stack

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.app.yml up -d --build"
```

This starts (or rebuilds + restarts):

- `readr-api-1` — Hono server on `:3000`

Caddy is behind a `public` profile and NOT started here — the host's k8s
ingress already owns :80/:443, and we terminate TLS at Cloudflare anyway.

Cross-stack `depends_on` is not enforceable, so on first start the api
container may take an extra healthcheck cycle or two while it waits
for `postgres:5432` and `minio:9000` to be reachable on the `readr`
network. The container's healthcheck and the server's connect-retry
handle this — no manual ordering required as long as infra is up.

Push the DB schema after the very first build:

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.app.yml \
  exec -T api sh -c 'cd /app/apps/server && pnpm exec drizzle-kit push --force'"
```

Health check from the laptop (LAN):

```bash
curl http://<olares-lan-ip>:3000/health
# → {"status":"ok", ...}
```

## Cloudflared tunnel

We expose the stack to the internet via a Cloudflare Tunnel rather than
opening ports on the Olares host. You'll need:

- A domain on Cloudflare
- `cloudflared` installed on the Olares box (`apt install cloudflared` or
  from the Cloudflare package repo)
- A tunnel created in the Zero Trust dashboard (or via
  `cloudflared tunnel create readr`)

### Ingress rules

The stack has three distinct HTTP origins that the client talks to directly.
Pick subdomains for each in your Cloudflare zone and point them at the
matching container port via `~/.cloudflared/config.yml` (or the dashboard):

```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/ebook-deploy/.cloudflared/<your-tunnel-id>.json

ingress:
  # React web dashboard
  - hostname: reader.example.com
    service: http://localhost:8080

  # Hono API — the mobile app + web dashboard both hit this
  - hostname: api.reader.example.com
    service: http://localhost:3000

  # MinIO S3 endpoint used by presigned book/cover downloads
  - hostname: books.reader.example.com
    service: http://localhost:9000

  - service: http_status:404
```

Then:

```bash
sudo systemctl enable --now cloudflared
```

### Wire the app to the tunnel

Update `.env` on the Olares side:

```bash
S3_PUBLIC_ENDPOINT=https://books.reader.example.com
PUBLIC_URL=https://api.reader.example.com
```

And restart the api container so presigned URLs come back with the right
origin:

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.app.yml up -d api"
```

(Use `up -d` rather than `restart` so the container picks up the new
`.env` values — `restart` reuses the existing env baked into the
container at create time.)

On the mobile and web clients, set the server URL to
`https://api.reader.example.com` on the sign-in screen and paste or generate
a new token.

## Re-deploying after a code change

1. From the laptop: `git push`
2. Rsync again (see above)
3. `ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.app.yml up -d --build api"`

This only touches the app stack — `docker-compose.infra.yml` and the
MinIO/Postgres/Redis containers it owns are left completely alone, so
`books.hunterchen.ca` keeps serving uninterrupted through the deploy
and Cloudflare's edge cache stays clean. `docker compose` will reuse
cached image layers for everything that didn't change.

To deliberately bump infra (e.g. a Postgres minor upgrade):

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.infra.yml up -d"
```

Same flag set, just pointed at the other file. Be aware this *will*
briefly bounce MinIO and may cause `books.hunterchen.ca` to flap, so
schedule it like any other infra maintenance (and consider purging
the Cloudflare cache for that hostname after).
