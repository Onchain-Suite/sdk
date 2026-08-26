# `cdn.onchainsuite.com` — SDK browser-loader CDN (AWS CloudFront + S3)

The no-build `<script>` loader (`dist/inapp.js`, the tag the dashboard hands out) is
served from **our own** host, not unpkg — our uptime, our CSP origin, our cache rules,
hotfixable without npm/unpkg propagation. This dir is the config + runbook for that host.
The release workflow (`.github/workflows/release.yml`) uploads the built file here on
every release.

## Why AWS and not Cloudflare R2

`onchainsuite.com`'s DNS is served by **GoDaddy**, not Cloudflare. Cloudflare R2 custom
domains require the **whole domain** to be a Cloudflare zone (subdomain-only zones are
Enterprise-only — the free dashboard rejects `cdn.onchainsuite.com` with *"provide the
root domain, not a subdomain"*). Moving the apex to Cloudflare means a **nameserver
cutover** that drags `api` and — the real risk — **SES email (SPF/DKIM/MX)** with it.

CloudFront needs only a **CNAME** at GoDaddy, so nameservers never move and email is
untouched. It also fits the AWS footprint we already run SES from.

```
customer <script src="https://cdn.onchainsuite.com/inapp-0.3.0.js">
   │
   ▼
CloudFront (TLS via ACM, CORS + cache headers, edge cache)
   │  OAC (signed), bucket stays private
   ▼
S3 bucket  onchainsuite-cdn   ← release.yml / seed.sh upload dist/inapp.js here
```

Two object shapes (the workflow produces both):

| Object | `Cache-Control` | When it moves |
|---|---|---|
| `inapp-<version>.js` | `public, max-age=31536000, immutable` | every release — customers pin this |
| `inapp.js` (stable alias) | `public, max-age=300` | **stable releases only** (never beta); its CloudFront path is invalidated so the move is prompt |

## Provision — Terraform (recommended)

`main.tf` provisions everything except the two GoDaddy DNS records (DNS isn't on Route
53, so ACM validation + the `cdn` CNAME are added by hand). Because validation DNS lives
at GoDaddy, apply in two passes:

```bash
cd infra/cdn
terraform init

# 1) create the ACM cert and print its validation CNAME
terraform apply -target=aws_acm_certificate.cdn
terraform output acm_validation_record          # add this CNAME at GoDaddy (next section)

# 2) once the validation CNAME resolves, finish: cert issues, S3 + CloudFront build
terraform apply
terraform output cdn_cname_target               # CNAME  cdn -> this  (add at GoDaddy)
terraform output cloudfront_distribution_id     # -> repo variable CDN_CF_DISTRIBUTION_ID
```

What it creates: a private S3 bucket, an ACM cert (us-east-1 — required for CloudFront),
a CloudFront distribution with **Origin Access Control** (bucket stays private), a
**response-headers policy** (CORS `*` so `integrity=`/`crossorigin` works, plus
`nosniff` + `Cross-Origin-Resource-Policy`), and a bucket policy that lets only this
distribution read.

<details><summary>Console equivalent (if you'd rather click)</summary>

1. **S3** → create bucket `onchainsuite-cdn`, **Block all public access ON** (it stays
   private; CloudFront reaches it via OAC).
2. **ACM (us-east-1!)** → request a public cert for `cdn.onchainsuite.com`, DNS
   validation → note the validation CNAME.
3. **CloudFront** → create distribution, origin = the bucket with **Origin access
   control** (create one), viewer protocol **redirect-to-HTTPS**, alternate domain
   `cdn.onchainsuite.com`, the ACM cert, cache policy **CachingOptimized**, and a
   response-headers policy with CORS `*` + `nosniff`. Copy the suggested bucket policy
   onto the bucket.
</details>

## Add the two DNS records at GoDaddy

GoDaddy → **onchainsuite.com → DNS → Add New Record**. Nameservers do **not** change;
you only add CNAMEs. Don't touch `api`, `www`, or email records.

| Purpose | Type | Name (host) | Value |
|---|---|---|---|
| ACM validation | CNAME | *(from `acm_validation_record`, e.g. `_a1b2….cdn`)* | *(its `…acm-validations.aws` value)* |
| The CDN hostname | CNAME | `cdn` | *(from `cdn_cname_target`, e.g. `d111abc.cloudfront.net`)* |

GoDaddy's Name field takes the host only; strip the trailing `.onchainsuite.com` the ACM
value shows. Validation usually completes minutes after the record resolves; CloudFront
then serves `https://cdn.onchainsuite.com/…`.

## Give CI write access

Create an IAM user (or role) for the release workflow, with least-privilege on exactly
this bucket + distribution:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::onchainsuite-cdn/*" },
    { "Effect": "Allow", "Action": "cloudfront:CreateInvalidation", "Resource": "arn:aws:cloudfront::<ACCOUNT_ID>:distribution/<DISTRIBUTION_ID>" }
  ]
}
```

Then in this repo → Settings → Secrets and variables → Actions:

| Kind     | Name                      | Value                              |
|----------|---------------------------|------------------------------------|
| secret   | `AWS_ACCESS_KEY_ID`       | the IAM user's key                 |
| secret   | `AWS_SECRET_ACCESS_KEY`   | the IAM user's secret              |
| variable | `AWS_REGION`              | the bucket's region (e.g. `us-east-1`) |
| variable | `CDN_S3_BUCKET`           | `onchainsuite-cdn`                 |
| variable | `CDN_CF_DISTRIBUTION_ID`  | the distribution id                |

(Plus `NPM_TOKEN` for the npm half.) Until these exist the workflow's CDN step skips with
a warning instead of failing. *Upgrade path:* swap the static keys for GitHub OIDC → an
IAM role (`aws-actions/configure-aws-credentials`) when you want no long-lived keys.

## Seed it now, and test in prod immediately

Don't wait for a release — push the current build by hand (needs the AWS CLI configured
with the same permissions):

```bash
export CDN_S3_BUCKET=onchainsuite-cdn
export CDN_CF_DISTRIBUTION_ID=<distribution-id>   # optional, enables alias invalidation
./infra/cdn/seed.sh
```

## Verify in prod

```bash
curl -sSI https://cdn.onchainsuite.com/inapp.js | grep -iE 'HTTP|content-type|cache-control|access-control-allow-origin|x-cache'
#   HTTP/2 200
#   content-type: text/javascript; charset=utf-8
#   cache-control: public, max-age=300
#   access-control-allow-origin: *
#   x-cache: Hit from cloudfront        (after a warm-up request)

curl -sSI https://cdn.onchainsuite.com/inapp-0.3.0.js | grep -i cache-control
#   cache-control: public, max-age=31536000, immutable

# SRI hash (paste into integrity= if you want it on the snippet):
curl -s https://cdn.onchainsuite.com/inapp-0.3.0.js | openssl dgst -sha384 -binary | openssl base64 -A

curl -sS -o /dev/null -w '%{http_code}\n' https://cdn.onchainsuite.com/nope.js   # 403/404
```

## After it's live: point the dashboard at it

Once verification passes for the stable `inapp.js`, flip `SDK_INAPP_URL` in the dashboard
(`onchain-suite` → `.../integrations/integrations.tsx`) from the pinned unpkg URL to
`https://cdn.onchainsuite.com/inapp-<version>.js` (keep the version pin). Do it in that
order — flipping before the file is live reintroduces the 404.
