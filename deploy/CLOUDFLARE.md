# Cloudflare setup for readr

Readr uses Cloudflare for two different things:

1. **Cloudflare Tunnel** — exposes the docker-compose stack on your
   Olares box (api, web, MinIO S3) to the public internet without
   opening any ports on the host.
2. **Cloudflare Pages** — hosts a static build of the web dashboard
   (`apps/web`) so readers can visit it from any browser without the
   Olares box having to serve HTML.

You can do either one on its own. The tunnel is only needed so that
the api/books subdomains are reachable; Pages is purely the UI and
talks to those subdomains from the client side.

---

## 1. Cloudflare Tunnel (Olares)

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

Three subdomains in your DNS, all pointing at the tunnel via
`CNAME ... <uuid>.cfargotunnel.com`:

| Subdomain                       | Service              |
| ------------------------------- | -------------------- |
| `reader.example.com`            | `http://localhost:8080` (web dashboard, only needed if you *also* don't use Cloudflare Pages) |
| `api.reader.example.com`        | `http://localhost:3000` (Hono API) |
| `books.reader.example.com`      | `http://localhost:9000` (MinIO S3 for presigned downloads) |

Save this as `~/.cloudflared/config.yml` on the Olares box:

```yaml
tunnel: <your-tunnel-uuid>
credentials-file: /home/ebook-deploy/.cloudflared/<your-tunnel-uuid>.json

ingress:
  - hostname: api.reader.example.com
    service: http://localhost:3000
  - hostname: books.reader.example.com
    service: http://localhost:9000
  - hostname: reader.example.com
    service: http://localhost:8080
  - service: http_status:404
```

### Route DNS + run

```bash
ssh olares-ebook "cloudflared tunnel route dns readr api.reader.example.com"
ssh olares-ebook "cloudflared tunnel route dns readr books.reader.example.com"
ssh olares-ebook "cloudflared tunnel route dns readr reader.example.com"

# Install as a service so it starts on boot.
ssh olares-ebook "sudo cloudflared service install"
ssh olares-ebook "sudo systemctl enable --now cloudflared"
```

### Wire the tunnel hostnames into the stack

Edit `~/readr/.env` on the Olares box:

```bash
S3_PUBLIC_ENDPOINT=https://books.reader.example.com
PUBLIC_URL=https://api.reader.example.com
BETTER_AUTH_TRUSTED_ORIGINS=https://reader.example.com  # (no longer used, safe to leave)
```

Restart the api container so new presigned URLs come back with the
public origin:

```bash
ssh olares-ebook "cd ~/readr && docker compose -f deploy/docker-compose.yml restart api"
```

Verify from anywhere on the internet:

```bash
curl https://api.reader.example.com/health
# → {"status":"ok", ...}
```

---

## 2. Cloudflare Pages (web dashboard)

Deploy `apps/web` as a static site. This gets you a real `*.pages.dev`
URL and (if you add a custom domain in the Cloudflare dashboard) your
own hostname, completely free and unlimited.

### One-time setup

1. In the Cloudflare dashboard, go to **Workers & Pages → Create
   application → Pages → Direct upload**. Create a project named
   `readr`. You don't need to upload anything yet; the GitHub Action
   will handle it.
2. Create a token at **My Profile → API Tokens → Create Token →
   "Edit Cloudflare Workers" template**. Save the value.
3. Grab your Account ID from the Workers & Pages sidebar.

### GitHub secrets

In your readr repo on GitHub: **Settings → Secrets and variables →
Actions**. Add:

| Name                          | Value                                 |
| ----------------------------- | ------------------------------------- |
| `CLOUDFLARE_API_TOKEN`        | the token from step 2 above           |
| `CLOUDFLARE_ACCOUNT_ID`       | your account ID                       |
| `READR_DEFAULT_SERVER_URL`    | *(optional)* `https://api.reader.example.com` — pre-fills the login screen |

### Deploy

The workflow at `.github/workflows/deploy-web.yml` builds and deploys
on every push to `main` that touches `apps/web/**`, `packages/shared/**`,
or the workflow itself. Trigger a first run manually from the Actions
tab or just push an unrelated change to those paths.

### Custom domain

In the Cloudflare Pages dashboard: **readr → Custom domains → Set up
a custom domain**. Point it at a subdomain like `reader.example.com`
and Cloudflare will add the DNS record for you.

**Important:** this conflicts with exposing `reader.example.com` via
the tunnel above. Pick one or the other:

- **Use Pages for the UI and the tunnel only for `api.` and `books.`
  subdomains.** This is the recommended setup — the web dashboard
  lives at the Pages edge (fast, zero CPU on your box) and only the
  API traffic tunnels through Olares.
- Or use the tunnel for everything and skip Pages. Simpler but slower
  because every page load hits your Olares box.

If you go the Pages route, drop the `reader.example.com` ingress
from `~/.cloudflared/config.yml` and `cloudflared tunnel route dns`
will fail idempotently.

### Env for the Pages build

Set `READR_DEFAULT_SERVER_URL` in your GitHub repo secrets to
`https://api.reader.example.com` so the login screen is pre-filled.
Without it, users see a blank field and have to paste the URL once
on first visit.
