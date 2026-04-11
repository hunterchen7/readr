# Cloudflare setup for readr

Readr uses Cloudflare Tunnel to expose the docker-compose stack on
your Olares box (the Hono api, and in Mode A also MinIO S3) to the
public internet without opening any ports on the host.

> **Note:** this doc assumes the **Mode A — Bundled MinIO** deploy
> from `deploy/OLARES.md`, where the stack runs its own MinIO and
> proxies it out through the tunnel as `books.reader.example.com`.
> If you're running **Mode B — External S3** (R2, AWS S3, B2, DO
> Spaces, …), your bucket is already reachable directly from the
> internet and you don't need a `books.*` tunnel ingress entry at
> all — only the `api.*` hostname below still applies. See the
> "S3 backend modes" section in `deploy/OLARES.md` for details.

---

## Cloudflare Tunnel (Olares)

You need a Cloudflare account with a domain on it (any plan works,
including the free one) and SSH access to the Olares box as
`ebook-deploy`.

### Install cloudflared on the Olares box

```bash
ssh olares-ebook <<'SH'
sudo apt install -y cloudflared || {
  # If the package isn't in the default repos:
  curl -L --output cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i cloudflared.deb
  rm cloudflared.deb
}
SH
```

### Create a tunnel

```bash
ssh olares-ebook "cloudflared tunnel login"
# Opens a browser on your Mac via forwarded URL; pick the zone.

ssh olares-ebook "cloudflared tunnel create readr"
# Prints a tunnel UUID. Note it.
```

### Configure ingress

Up to two subdomains in your DNS, both pointing at the tunnel via
`CNAME ... <uuid>.cfargotunnel.com`:

| Subdomain                       | Mode  | Service              |
| ------------------------------- | ----- | -------------------- |
| `api.reader.example.com`        | A + B | `http://localhost:3000` (Hono API) |
| `books.reader.example.com`      | A only | `http://localhost:9000` (MinIO S3 for presigned downloads) |

In Mode B (external S3) you skip the `books.*` row entirely — your
S3 provider serves the bucket directly from its own host.

Save this as `~/.cloudflared/config.yml` on the Olares box:

```yaml
tunnel: <your-tunnel-uuid>
credentials-file: /home/ebook-deploy/.cloudflared/<your-tunnel-uuid>.json

ingress:
  - hostname: api.reader.example.com
    service: http://localhost:3000
  # Mode A only — drop this row in Mode B (external S3):
  - hostname: books.reader.example.com
    service: http://localhost:9000
  - service: http_status:404
```

### Route DNS + run

```bash
ssh olares-ebook "cloudflared tunnel route dns readr api.reader.example.com"
# Mode A only:
ssh olares-ebook "cloudflared tunnel route dns readr books.reader.example.com"

# Install as a service so it starts on boot.
ssh olares-ebook "sudo cloudflared service install"
ssh olares-ebook "sudo systemctl enable --now cloudflared"
```

### Wire the tunnel hostnames into the stack

Edit `~/readr/.env` on the Olares box. The exact set of values depends
on which S3 mode you're running (see `deploy/OLARES.md` and
`deploy/.env.example`); the tunnel-relevant ones are:

```bash
PUBLIC_URL=https://api.reader.example.com
# Mode A only (bundled MinIO behind the tunnel):
S3_PUBLIC_ENDPOINT=https://books.reader.example.com
```

Restart the api container so new presigned URLs come back with the
public origin:

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.app.yml up -d api"
```

Verify from anywhere on the internet:

```bash
curl https://api.reader.example.com/health
# → {"status":"ok", ...}
```
