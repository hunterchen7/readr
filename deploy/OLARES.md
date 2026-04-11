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

Both compose stacks read a single `.env` from the repo root on the Olares
side (i.e. `~/readr/.env`). This file is the **single source of truth**
for every secret and endpoint — there are no `${VAR:-default}` fallbacks
in the compose files anymore, so a missing var means the container
refuses to boot loudly instead of silently running on a default
password. (Compose's interpolation reads `.env` from the compose-file
directory, not from `../.env`, so any interpolation against the
operator's `.env` is a footgun. We removed it.)

The fastest way to seed `~/readr/.env` is to copy the in-repo template:

```bash
scp deploy/.env.example olares-ebook:~/readr/.env
ssh olares-ebook "$EDITOR ~/readr/.env"
```

Required keys (every one of these must be set):

| Var                    | Notes                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `POSTGRES_USER`        | Read by the postgres image at first-boot init (e.g. `reader`)         |
| `POSTGRES_PASSWORD`    | Pick a strong secret. Used by both postgres init and `DATABASE_URL`   |
| `POSTGRES_DB`          | Database name (e.g. `reader`)                                         |
| `DATABASE_URL`         | `postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<POSTGRES_DB>` — host **must** be `postgres` (in-network DNS) |
| `REDIS_URL`            | `redis://redis:6379` — host **must** be `redis`                       |
| `S3_BUCKET`            | Bucket name                                                           |
| `S3_ACCESS_KEY`        | S3 access key                                                         |
| `S3_SECRET_KEY`        | S3 secret                                                             |
| `S3_REGION`            | `auto` for R2/MinIO, real region (e.g. `us-east-1`) for AWS           |
| `S3_FORCE_PATH_STYLE`  | `true` for MinIO/B2/some Linode, `false` for AWS S3 and R2            |
| `S3_PUBLIC_ENDPOINT`   | Externally-reachable URL the api concatenates `/<bucket>/<key>` onto. **Must be path-style** (no bucket in the hostname) |
| `PUBLIC_URL`           | The public origin of the api, e.g. `https://api.reader.example.com`   |
| `PORT`                 | `3000`                                                                |
| `NODE_ENV`             | `production`                                                          |
| `LOG_LEVEL`            | `info`                                                                |
| `MAX_UPLOAD_SIZE_MB`   | e.g. `500`                                                            |
| `DEFAULT_STORAGE_QUOTA_MB` | e.g. `4096`                                                       |
| `TTS_ENABLED`          | `false` unless you've started the GPU overlay                         |

Mode A (bundled MinIO) additionally requires:

| Var                    | Notes                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `MINIO_ROOT_USER`      | Read by both `minio` and `minio-init` containers                      |
| `MINIO_ROOT_PASSWORD`  | Pick a strong secret. Must equal `S3_SECRET_KEY` (same credential)    |
| `S3_ENDPOINT`          | `http://minio:9000` — in-network DNS name of the bundled MinIO        |
| `S3_FORCE_PATH_STYLE`  | `true` (MinIO requires path-style)                                    |

Mode B (external S3) is described under
[S3 backend modes](#s3-backend-modes) below — copy the matching block
out of `deploy/.env.example` and delete the Mode A block.

Optional keys (`RESEND_API_KEY`, `RESEND_FROM`, `TTS_*`, etc.) live in
the same file — see `deploy/.env.example` for the full annotated list.

## Two-stack layout

The deploy is split into two compose files so we can redeploy the app
without disturbing MinIO:

- `deploy/docker-compose.infra.yml` — Postgres, Redis, and (under the
  `local-s3` profile) MinIO plus the one-shot `minio-init` bucket
  bootstrap. Long-lived; only touched when you intentionally bump
  infra.
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

## S3 backend modes

readr stores uploaded books in an S3-compatible bucket. You have two
ways to provide that bucket, and you pick between them by whether or
not you include the `local-s3` compose profile when bringing up infra.

### Mode A — Bundled MinIO (default for self-hosted)

The infra stack includes MinIO and a bucket-bootstrap init container,
gated behind the `local-s3` profile. Run infra with the profile:

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.infra.yml --profile local-s3 up -d"
```

This brings up postgres, redis, minio, and minio-init. No additional
S3-related env vars are required beyond the `.env` example above —
`S3_ENDPOINT` defaults to `http://minio:9000` (the in-network service
name) and the app container talks to it via the shared `readr`
network. You still need to set `S3_PUBLIC_ENDPOINT` to whatever
hostname the external tunnel/LB terminates books. traffic on.

### Mode B — External S3 (R2, AWS S3, B2, DO Spaces, …)

Skip the `local-s3` profile. Infra becomes just postgres + redis:

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.infra.yml up -d"
```

In this mode you're responsible for creating the bucket and its
credentials in your external provider's console **before** starting
the app stack — the bundled `minio-init` is gated behind `local-s3`
and will not run. Set the following in `~/readr/.env`:

| Var                    | R2 example                                            | AWS S3 example        | MinIO-compat example (B2/Linode) |
| ---------------------- | ----------------------------------------------------- | --------------------- | -------------------------------- |
| `S3_ENDPOINT`          | `https://<account-id>.r2.cloudflarestorage.com`       | *(leave unset)*       | `https://s3.us-west-004.backblazeb2.com` |
| `S3_REGION`            | `auto`                                                | `us-east-1`           | `us-west-004`                    |
| `S3_BUCKET`            | `my-readr-books`                                      | `my-readr-books`      | `my-readr-books`                 |
| `S3_ACCESS_KEY`        | R2 access key ID                                      | IAM access key ID     | B2 application key ID            |
| `S3_SECRET_KEY`        | R2 secret                                             | IAM secret            | B2 application key               |
| `S3_PUBLIC_ENDPOINT`   | `https://books.example.com` (R2 custom domain or dev.r2.dev) | `https://my-readr-books.s3.amazonaws.com` | `https://books.example.com` |
| `S3_FORCE_PATH_STYLE`  | `false`                                               | `false`               | `true`                           |

Notes:

- `S3_ENDPOINT` in `.env` flows through the app compose file via
  `${S3_ENDPOINT:-http://minio:9000}`, so setting it in `.env`
  overrides the default and points the api container at your external
  provider.
- AWS S3 itself doesn't need `S3_ENDPOINT` set at all — leave it unset
  in `.env` and the AWS SDK will resolve the regional endpoint from
  `S3_REGION`. (The compose override will then fall back to
  `http://minio:9000`, which is harmless as long as MinIO isn't
  running — the api container will never connect to it because the
  server-side env precedence is driven by what the SDK actually uses.
  If that fallback makes you uneasy, set `S3_ENDPOINT` to the explicit
  regional host.)
- `S3_PUBLIC_ENDPOINT` is the origin your clients (mobile/web) will
  hit directly for presigned downloads — it's signed into the URL.
  For R2 this is typically your R2 custom domain or public `r2.dev`
  URL. For AWS S3 it's the virtual-hosted bucket URL.
- Cloudflared ingress for `books.example.com` is not needed in Mode
  B — the public S3 host is reachable directly from the internet.
  Drop the `books.reader.example.com` entry from
  `~/.cloudflared/config.yml`.

## Bring up the stack

### One-time: create the shared network

```bash
ssh olares-ebook "docker network create readr"
```

(Idempotent — re-running just prints `network with name readr already exists` and exits non-zero, which is fine.)

### One-time (or when infra changes): start the infra stack

Pick the command for the S3 backend mode you chose above.

**Mode A — Bundled MinIO:**

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.infra.yml --profile local-s3 up -d"
```

This starts:

- `readr-postgres-1` — internal only, owns `pgdata` volume
- `readr-redis-1` — internal only, owns `redisdata` volume
- `readr-minio-1` — S3 on `:9000`, console on `:9001`, owns `miniodata` volume
- `readr-minio-init-1` — one-shot bucket bootstrap, exits 0

**Mode B — External S3:**

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.infra.yml up -d"
```

This starts only:

- `readr-postgres-1` — internal only, owns `pgdata` volume
- `readr-redis-1` — internal only, owns `redisdata` volume

Leave whichever you chose running. Only re-run `up -d` against the
infra file when you deliberately want to bump a version (e.g.
`postgres:16` → `postgres:17`) or change a healthcheck. **Never
bounce it during a normal app redeploy.**

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

To deliberately bump infra (e.g. a Postgres minor upgrade), re-run
the infra stack with the same profile flag you originally used:

```bash
# Mode A (bundled MinIO):
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.infra.yml --profile local-s3 up -d"

# Mode B (external S3):
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.infra.yml up -d"
```

In Mode A this *will* briefly bounce MinIO and may cause
`books.hunterchen.ca` to flap, so schedule it like any other infra
maintenance (and consider purging the Cloudflare cache for that
hostname after). Mode B only touches postgres/redis, so the books
origin is unaffected.
