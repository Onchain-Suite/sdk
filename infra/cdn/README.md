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

### 1. Add `cdn.onchainsuite.com` as a Cloudflare zone

The twist that trips people up: Cloudflare's "Add a site" flow is built for whole
domains, but we add the **subdomain** as its own zone. That changes exactly one
downstream step (the nameservers — see the gotcha). Screen by screen:

1. **Account.** Sign in at `dash.cloudflare.com` (create a free account + verify your
   email if you don't have one yet).
2. **Add a domain.** On the dashboard, click **Add a domain** (older label: *Add site*).
3. **Type the subdomain, not the apex.** Enter exactly:

   ```
   cdn.onchainsuite.com
   ```

   Not `onchainsuite.com`, no `https://`, no trailing slash. Pick the option to enter an
   existing domain (not "manually create DNS records"), then **Continue**.
4. **Plan.** Choose **Free** → Continue.
5. **DNS records.** Cloudflare runs a quick scan and shows a records table — for a fresh
   subdomain it's **empty, and that's correct**. Add nothing here; the R2 custom-domain
   step (§4) creates the record for you. Click **Continue**.
6. **Nameservers.** Cloudflare shows **two** nameservers for this zone, like
   `aria.ns.cloudflare.com` and `bob.ns.cloudflare.com` (yours differ). **Copy both.**

   > ⚠️ **The one gotcha.** This screen tells you to "replace the nameservers at your
   > registrar." For a **subdomain** zone, **do NOT do that** — changing the registrar's
   > nameservers would move the *entire* `onchainsuite.com` (api + email included) to
   > Cloudflare. Instead you delegate only `cdn` with two NS *records* at GoDaddy (§2).
   > Leave this Cloudflare tab open; the zone flips to Active on its own after §2.

### 2. Delegate only the `cdn` subtree at GoDaddy

GoDaddy → **Domain Portfolio → onchainsuite.com → DNS** (Manage DNS) →
**Add New Record**, twice — one per Cloudflare nameserver:

| Type | Name  | Value (your two Cloudflare NS from §1.6) | TTL     |
|------|-------|------------------------------------------|---------|
| NS   | `cdn` | `aria.ns.cloudflare.com`                 | default |
| NS   | `cdn` | `bob.ns.cloudflare.com`                  | default |

The mistakes people actually make here:
- **Name is `cdn`** — just the host; GoDaddy appends `.onchainsuite.com`. Both records
  share the same Name `cdn`; only the Value differs.
- **Type is `NS`** (nameserver), not A or CNAME.
- Value is the Cloudflare nameserver hostname; GoDaddy needs no trailing dot.
- **Don't touch or delete anything else.** Your `api`, `www`, and MX/email records stay
  exactly as they are — you're only *adding* two records.

That hands the `cdn.onchainsuite.com` subtree to Cloudflare and nothing else. Verify from
a terminal (propagation is usually minutes, up to a couple hours):

```bash
dig +short NS cdn.onchainsuite.com    # → your two *.ns.cloudflare.com
```

Once that resolves, the Cloudflare zone flips to **Active** (Cloudflare emails you too).
Still "Pending" after a few hours → re-check the two NS records at GoDaddy for typos.

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
