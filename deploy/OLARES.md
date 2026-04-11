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

## Bring up the stack

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.yml up -d --build"
```

This starts:

- `deploy-api-1` — Hono server on `:3000`
- `deploy-web-1` — nginx serving the React dashboard on `:8080`
- `deploy-postgres-1` — internal only
- `deploy-redis-1` — internal only
- `deploy-minio-1` — S3 on `:9000`, console on `:9001`
- `deploy-minio-init-1` — one-shot bucket bootstrap, exits 0

Caddy is behind a `public` profile and NOT started here — the host's k8s
ingress already owns :80/:443, and we terminate TLS at Cloudflare anyway.

Push the DB schema after the very first build:

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.yml \
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
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.yml restart api"
```

On the mobile and web clients, set the server URL to
`https://api.reader.example.com` on the sign-in screen and paste or generate
a new token.

## Re-deploying after a code change

1. From the laptop: `git push`
2. Rsync again (see above)
3. `ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.yml up -d --build api web"`

Only rebuild the containers whose source changed. `docker compose` will
reuse the cached layers for everything else.
