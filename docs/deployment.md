# Deployment

## Home page: Cloudflare (https://0dh.in)

The public home page is a static site of its own, served by Cloudflare's
network (Workers static assets: free, no server). The staff app (login,
dashboards, `/api`) is deployed separately, at `https://app.0dh.in`.

```sh
pnpm --filter @infusion/web build:landing          # -> apps/web/dist-landing
cd apps/web
npx wrangler@4 login                               # once per machine
npx wrangler@4 deploy --config wrangler.landing.jsonc
```

- `apps/web/vite.landing.config.ts` builds it and writes `_headers` (the
  same security headers as the app) and `_redirects` (staff paths such as
  `/login` → `https://app.0dh.in`).
- `apps/web/wrangler.landing.jsonc` serves it on the `0dh.in` custom domain
  only; no `*.workers.dev` or preview addresses.
- Cloudflare dashboard settings for the 0dh.in zone:
  - a Redirect Rule `www.0dh.in` → `https://0dh.in`;
  - Web Analytics' automatic script injection switched off, since the
    Content Security Policy blocks third-party scripts.

## Staff app: Raspberry Pi at home (https://app.0dh.in)

How a visitor's request travels:

```
browser ─https─► Cloudflare (0dh.in zone) ─► Cloudflare Tunnel ─► cloudflared on the Pi
        ─► Coolify's proxy (Traefik, :80) ─► web (Caddy :80: SPA + /api) ─► api ─► postgres, redis
```

- Nothing is port-forwarded on the home router. The tunnel connects outwards, so this also works behind an ISP's carrier-grade NAT.
- If the Pi, its power or the home internet is down, only `app.0dh.in` is down; the home page at `0dh.in` stays up.
- **Same origin is a hard requirement.** The SPA and its API share `app.0dh.in`, because the refresh-token cookie is `SameSite=Strict`. `web`'s Caddyfile (`infra/docker/Caddyfile`) proxies `/api/*` to the `api` container and strips the prefix, so `apps/api`'s routes stay unprefixed (`/auth/login`).
- **Only dummy data.** The server runs Vigil LIVE and treats device data as real, but a home Pi has no cover for patient data. Send only dummy readings and register only made-up patients until the portal moves to covered hosting.

How code reaches the Pi: `git push` → GitHub Actions (`.github/workflows/deploy.yml`):
1. On GitHub's ARM runners it builds the arm64 images `ghcr.io/<owner>/portal-api`, `-migrate` and `-web`, and pushes them to GHCR.
2. It calls Coolify's deploy API.
3. Coolify pulls the images and restarts `infra/docker/docker-compose.pi.yml`.

The Pi never compiles anything. On each deploy the one-shot `migrate` service applies pending migrations first; the `api` only starts if it succeeds.

### 1. The Pi (Raspberry Pi 4, SD card)

- **Storage:** use a high-endurance SD card (32–64 GB), and move to a USB 3 SSD when possible. A Pi 4 boots from USB.
- **Power and network:** the official power supply and wired Ethernet. A small UPS helps.
- **OS:** flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In its settings, set the hostname, a user and your SSH public key.

After the first boot:

```sh
sudo apt update && sudo apt full-upgrade -y
swapon --show       # if this lists a swap FILE on the SD card (e.g. /var/swap), use RAM (zram) instead:
sudo dphys-swapfile swapoff && sudo systemctl disable --now dphys-swapfile
sudo apt install -y zram-tools && printf 'ALGO=zstd\nPERCENT=50\n' | sudo tee /etc/default/zramswap && sudo systemctl restart zramswap
```

### 2. Your access: Raspberry Pi Connect

[Raspberry Pi Connect](https://connect.raspberrypi.com) gives a remote shell and screen sharing from anywhere, with nothing opened on the router. Turn it on in the Pi's settings and sign in with a Raspberry Pi ID. No VPN is used.

### 3. Coolify

```sh
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

- **Create the admin account straight away.** Open `http://<pi-hostname>.local:8000` from a PC on the home network and register; **the first visitor becomes the admin**. Use a strong password.
- **Away from home:** use Raspberry Pi Connect's screen sharing and open `http://localhost:8000` in the Pi's own browser.
- **Close registration:** in Coolify **Settings**, turn off new-user registration, and turn on two-factor login for your account.
- **Keep the dashboard off the internet.** Never give it a public hostname or a tunnel route.
  - The Pi has a **public IPv6 address**, and home routers often don't shield IPv6 the way NAT shields IPv4. So install the home-network-only firewall (`infra/pi/`). It lets new connections in only from the home network and the Pi itself:
    ```sh
    curl -fsSL https://raw.githubusercontent.com/sandeepmataridr-bot/portal/main/infra/pi/install-firewall.sh | sudo sh
    ```
  - The tunnel and Raspberry Pi Connect both connect outwards, so they keep working.
- **Check log rotation:** `/etc/docker/daemon.json` should have `"log-opts": {"max-size": "10m", ...}`, which the installer normally sets. It keeps SD card writes down for Coolify's own containers. The app's containers set their own limits in `docker-compose.pi.yml`.

### 4. Cloudflare Tunnel

1. **Create the tunnel:** in the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels → Create a tunnel**, type Cloudflared, name `pi`. Copy the token (it starts with `eyJ`).
2. **Run it on the Pi:** in Coolify, **+ New → Service → Cloudflared**. Put the token in its environment and deploy. The tunnel shows **Healthy** in Cloudflare.
3. **Add public hostnames** on the tunnel:

   | Hostname | Path | Service |
   |---|---|---|
   | `app.0dh.in` | (empty) | `http://localhost:80` |
   | `deploy.0dh.in` | `^/api/v1/(deploy|deployments)` | `http://localhost:8000` |

   - The second route makes only Coolify's token-protected deploy and deploy-status endpoints public, for GitHub Actions. Every other path on it returns 404.
   - If `localhost` fails, use `127.0.0.1`.

### 5. Images, then the app in Coolify

1. **Build the images:** push to `main` (or run the workflow by hand from the repo's **Actions** tab). Without the Coolify secrets it only builds and pushes the images.
2. **Make the images public:** go to GitHub → your profile → **Packages**. For each of `portal-api`, `portal-migrate` and `portal-web`: **Package settings → Change visibility → Public**. They hold no secrets.
3. **Create the app:** in Coolify, **+ New → Public Repository** `https://github.com/sandeepmataridr-bot/portal`, branch `main`.
   - Build pack **Docker Compose**, Docker Compose location `/infra/docker/docker-compose.pi.yml`.
   - Automatic deployment **off**, because GitHub Actions triggers deploys.
4. **Environment Variables:** see `infra/docker/.env.prod.example`.
   - `DOMAIN=app.0dh.in` and `RUN_SEED=true`.
   - `POSTGRES_PASSWORD`, generated with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
   - `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`: two **different** values, each generated with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
5. **Domains:** service `web` → `https://app.0dh.in` (port 80). Set **Redirect HTTP to HTTPS: Disabled**; the tunnel talks plain HTTP, and the redirect would loop.
6. **Deploy:** `migrate` should exit 0 and `api` become healthy.
7. **After the first deploy:**
   - Set `RUN_SEED=false`.
   - Sign in with the seeded accounts, which force a password change, and set strong passwords.
   - The quick sign-in table stays off: production in LIVE mode ignores `TEST_LOGINS`.

### 6. Deploy on every push

1. **Create a token:** in Coolify, go to **Settings → API**, enable it, then create an API token that can deploy.
2. **Find the deploy URL:** copy the app's **Deploy Webhook** URL and change its host to `https://deploy.0dh.in`, keeping the path `/api/v1/deploy?uuid=…`.
3. **Add the secrets:** in the GitHub repo, go to **Settings → Secrets and variables → Actions** and add `COOLIFY_DEPLOY_URL` and `COOLIFY_TOKEN`.

From then on every push to `main` (except docs and firmware) is built on GitHub and deployed on the Pi.

### Deploying changes (everyday)

1. **Push from VS Code:** **Source Control** → message → **Commit** → **Sync Changes**.
2. **Watch it in VS Code:** install GitHub's **GitHub Actions** extension to see each run.
   - The run goes green only when the new version is **live** on the Pi; the job summary links to `https://app.0dh.in`.
   - A failed build, migration or start turns it red, and the previous version keeps running.
3. **See the result:** refresh `https://app.0dh.in`, about 10 minutes after the push.

Nothing on the Pi is touched by hand. The home page at `https://0dh.in` is separate and unaffected: it keeps running on Cloudflare even when the Pi is off.

### 7. Backups (essential: SD cards fail without warning)

- **Nightly:** add a Coolify **Scheduled Task** on the app, container `postgres`, schedule `30 2 * * *`, command:
  `sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /backups/portal-$(date +%a).dump'`
  This keeps a rolling week of dumps in the `pgbackups` volume.
- **Weekly, off the Pi:** copy that volume to free cloud storage with `rclone` (Google Drive or Cloudflare R2).
- **Restore test:** `pg_restore -U <user> -d <db> --clean /backups/portal-<day>.dump`. Do it once to be sure it works.

### Verifying a deploy

```sh
curl -s https://app.0dh.in/api/health                       # {"status":"ok"}
curl -sI https://app.0dh.in/ | grep -i -E 'strict-transport|content-security-policy|x-frame-options|x-robots-tag'
curl -sI https://app.0dh.in/api/health | grep -i cache-control  # no-store
```

Then sign in as each role and open the central station; its live updates use the socket at `/api/socket.io`. Devices send to `https://app.0dh.in/api/vigil/ingest`. If Cloudflare answers them with 403, add a WAF skip rule for that path.

### Production-like run on a PC

```sh
cp infra/docker/.env.prod.example infra/docker/.env.prod     # fill in the secrets
docker compose -f infra/docker/docker-compose.prod.yml -f infra/docker/docker-compose.local.yml \
  --env-file infra/docker/.env.prod up -d --build              # http://localhost:8080
```

`docker-compose.prod.yml` builds the same stack from source. Use it to check a change before pushing, or on any other server with a proxy in front.

## Security headers

`infra/docker/Caddyfile` adds these to every response:
- HSTS;
- a strict Content Security Policy: this site's own scripts, styles, fonts, images and API/socket only, no third parties, no framing;
- X-Frame-Options, nosniff, Referrer-Policy and Permissions-Policy;
- cross-origin isolation of the window and resources;
- `Cache-Control: no-store` on `/api`;
- `X-Robots-Tag: noindex` (the staff app stays out of search engines);
- no `Server` header.

The home page sends the same set from its `_headers` file. If the web app ever loads something from another origin, add that origin to the CSP and check the browser console for CSP violations. This includes Cloudflare features that inject scripts, like Web Analytics.

In the browser, `apps/web/src/lib/screenLock.ts` locks every page:
- no selecting, right-click, copying or dragging;
- no save, print, view-source or developer-tool shortcuts.

Text fields and elements marked `data-allow-copy` (the one-time machine credential) stay usable. This only deters casual copying; the headers and the logins are the real protection.

## Data & backups

- `pgdata`, `pgbackups` and `redisdata` are named Docker volumes. Coolify prefixes them with the app's id.
- **`pgdata`** is the database; it must be backed up off the Pi (see step 7).
- **`redisdata`** only holds queues and caches.

## Load/soak test

This is an internal hospital-coordination dashboard — a handful of staff
terminals, not internet-scale traffic — and every route is already
rate-limited (100 req/min/IP default, tighter on auth endpoints). So the
meaningful test is sustained realistic concurrent use + stability, not
synthetic max-throughput blasting (which the throttle would just reject by
design). Ran two consecutive 2-minute soaks, 8 virtual users polling
`/machines/fleet-status`, `/patients`, `/patients/dashboard`, `/medicines`,
`/medicines/dashboard`, `/insurance/claims`, `/doctors` at randomized
1-3s intervals each (against the dev server — `nest start`, unoptimized
relative to the production `node dist/main.js` build):

| Run | Requests | Errors | p50 / p95 / p99 (ms) | Server RSS |
|---|---|---|---|---|
| baseline | — | — | — | 22.6 MB |
| 1 | 474 | 0 | 21.5 / 36.0 / 119.4 | 75.7 MB (+53.1) |
| 2 | 487 | 0 | 21.4 / 32.6 / 42.4 | 78.3 MB (+2.6) |

Zero non-2xx responses across both runs; p99 *improved* on the second run
(JIT/module warmup, not degradation). Memory grew ~53MB on the first run
(process warmup — module loading, connection pools, V8 heap sizing to a
working set) then only ~2.6MB on an equivalent second run — a real
per-request leak would show comparable growth in both runs, not a ~20x
smaller delta on the second. No leak indicated.

## Known deferred items (see also `SECURITY.md`)

- `react-router@6.30.6` (apps/web) has two low-severity moderate CVEs fixed
  only in the 7.x major. Not exploitable in this app's current usage (no SSR,
  no user-controlled navigation targets) — deferred, not silently ignored.
- No horizontal scaling story yet — `api` is a single replica. BullMQ/Redis
  and the DB would both need to support it (they already would); the compose
  file itself would need a `deploy.replicas` + load-balancing story added
  before that's safe.
