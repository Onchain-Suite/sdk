# `cdn.onchainsuite.com` — SDK browser-loader CDN (Cloudflare R2)

The no-build `<script>` loader (`dist/inapp.js`, the tag the dashboard hands out) is
served from **our own** host, not unpkg — our uptime, our CSP origin, our cache rules,
hotfixable without npm/unpkg propagation. This dir is the config + runbook for that host.
The release workflow (`.github/workflows/release.yml`) uploads the built file here on
every release.

## DNS model — why "subdomain delegation" (read this first)

`onchainsuite.com` is registered at **GoDaddy and its DNS is served by GoDaddy**
(nameservers `ns53/ns54.domaincontrol.com`). It is **not** a Cloudflare zone — the
Cloudflare headers on `api.onchainsuite.com` are Render's edge, not ours.

R2 custom domains require the hostname to be on Cloudflare. Rather than move the whole
domain's nameservers to Cloudflare (which would drag `api` and — the real risk — email
SPF/DKIM/MX along with it), we delegate **only `cdn.onchainsuite.com`**:

```
onchainsuite.com            → GoDaddy DNS   (apex, api, MX/email — UNTOUCHED)
└─ cdn.onchainsuite.com     → delegated to Cloudflare via NS records at GoDaddy
   └─ R2 custom domain      → bucket `onchainsuite-cdn`
```

Nothing about the apex, `api`, or email changes. If any of those ever break during this,
the CDN work is not the cause — the delegation only affects the `cdn` subtree.

## One-time setup

### 1. Create the Cloudflare zone for the subdomain
Cloudflare dashboard → **Add a site** → enter `cdn.onchainsuite.com` (the subdomain,
not the apex) → Free plan. Cloudflare assigns **two nameservers**, e.g.
`aria.ns.cloudflare.com` / `bob.ns.cloudflare.com` (yours will differ — copy them).

### 2. Delegate the subdomain at GoDaddy
GoDaddy → `onchainsuite.com` → **DNS → Manage Zone → Add**, add **two NS records**:

| Type | Name  | Value (use YOUR two Cloudflare NS) |
|------|-------|------------------------------------|
| NS   | `cdn` | `aria.ns.cloudflare.com`           |
| NS   | `cdn` | `bob.ns.cloudflare.com`            |

That hands the `cdn.onchainsuite.com` subtree to Cloudflare and nothing else. Verify:

```bash
dig +short NS cdn.onchainsuite.com    # → your two *.ns.cloudflare.com (after propagation)
```

Back in Cloudflare the zone flips to **Active** once it sees the delegation.

### 3. Create the R2 bucket
```bash
npx wrangler r2 bucket create onchainsuite-cdn
```
Leave the bucket's `r2.dev` public URL **off** — we expose it only through the custom
domain.

### 4. Attach the custom domain
R2 → **onchainsuite-cdn → Settings → Custom Domains → Connect Domain** →
`cdn.onchainsuite.com`. Because the subdomain is now a Cloudflare zone on this account,
the cert + proxied record provision automatically. Wait for **Active** (~1–2 min).

### 5. CORS (so `integrity=` + `crossorigin` work)
A `<script>` with an SRI hash loads `crossorigin`, which needs CORS. It's a public asset,
so `*` is correct (unpkg/jsDelivr do the same). Dashboard: **R2 → bucket → Settings →
CORS Policy** → paste [`cors.json`](./cors.json)'s rule, or via S3 API:

```bash
export ACCOUNT_ID=<cloudflare-account-id>
aws s3api put-bucket-cors --bucket onchainsuite-cdn \
  --endpoint-url "https://${ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --cors-configuration file://infra/cdn/cors.json
```

### 6. Seed it now, and test in prod immediately
Don't wait for a release — push the current build by hand:

```bash
npx wrangler login           # account that owns the bucket
R2_BUCKET=onchainsuite-cdn ./infra/cdn/seed.sh
```

Then verify (§8). From here, releases upload automatically.

### 7. Give CI write access
R2 → **Manage R2 API Tokens → Create** → **Object Read & Write**, scoped to
`onchainsuite-cdn`. In this repo → Settings → Secrets and variables → Actions:

| Kind     | Name                   | Value                    |
|----------|------------------------|--------------------------|
| secret   | `R2_ACCESS_KEY_ID`     | token Access Key ID      |
| secret   | `R2_SECRET_ACCESS_KEY` | token Secret             |
| secret   | `R2_ACCOUNT_ID`        | Cloudflare account id    |
| variable | `R2_BUCKET`            | `onchainsuite-cdn`       |

(Plus `NPM_TOKEN` for the npm half of the release.) Until these exist the workflow's R2
step skips with a warning instead of failing.

## 8. Verify in prod
```bash
curl -sSI https://cdn.onchainsuite.com/inapp.js | grep -iE 'HTTP|content-type|cache-control|access-control-allow-origin|cf-cache-status'
#   HTTP/2 200
#   content-type: text/javascript; charset=utf-8
#   cache-control: public, max-age=300
#   access-control-allow-origin: *
#   cf-cache-status: HIT           (after a warm-up request)

# immutable versioned copy caches forever:
curl -sSI https://cdn.onchainsuite.com/inapp-0.3.0.js | grep -i cache-control
#   cache-control: public, max-age=31536000, immutable

# SRI hash (paste into integrity= if you want it on the snippet):
curl -s https://cdn.onchainsuite.com/inapp-0.3.0.js | openssl dgst -sha384 -binary | openssl base64 -A

curl -sS -o /dev/null -w '%{http_code}\n' https://cdn.onchainsuite.com/nope.js   # 404
```

## Caching
`Cache-Control` is stamped on each object (by `seed.sh` and by the release workflow), and
the R2 custom domain honours it at the Cloudflare edge — no rule required. Optional
hardening on the `cdn.onchainsuite.com` zone: a **Cache Rule** (*Edge TTL → respect
origin*) and a **Response-header Transform** adding `Cross-Origin-Resource-Policy:
cross-origin` + `X-Content-Type-Options: nosniff`.

## After it's live: point the dashboard at it
Once §8 passes for the stable `inapp.js`, flip `SDK_INAPP_URL` in the dashboard
(`onchain-suite` → `.../integrations/integrations.tsx`) from the pinned unpkg URL to
`https://cdn.onchainsuite.com/inapp-<version>.js` (keep the version pin). Do it in that
order — flipping before the file is live reintroduces the 404.

Deeper rationale + Terraform/Worker alternatives: `onchain-backend/notes/infra/sdk-cdn-r2-setup.md`.
