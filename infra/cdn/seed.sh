#!/usr/bin/env bash
# Build dist/inapp.js and push it to the CDN (S3 origin behind CloudFront) by hand.
#
# Use this to (a) seed the bucket so cdn.onchainsuite.com serves a file BEFORE the
# release workflow has run, and (b) re-seed / hotfix without cutting a release.
# Normal releases upload automatically via .github/workflows/release.yml.
#
# Needs the AWS CLI configured (env or `aws configure`) with s3:PutObject on the
# bucket and cloudfront:CreateInvalidation on the distribution.
#   export CDN_S3_BUCKET=onchainsuite-cdn
#   export CDN_CF_DISTRIBUTION_ID=E123ABC...   # optional; enables alias invalidation
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

BUCKET="${1:-${CDN_S3_BUCKET:?set CDN_S3_BUCKET (the S3 origin bucket)}}"
DISTRIBUTION_ID="${CDN_CF_DISTRIBUTION_ID:-}"
VERSION="$(node -p "require('./package.json').version")"
CT="text/javascript; charset=utf-8"

npm run build
test -f dist/inapp.js || { echo "dist/inapp.js missing after build" >&2; exit 1; }

# Immutable versioned object — the URL changes every release, so cache it forever.
aws s3 cp dist/inapp.js "s3://${BUCKET}/inapp-${VERSION}.js" \
  --content-type "$CT" \
  --cache-control "public, max-age=31536000, immutable"

# Stable alias — short TTL. Never point it at a prerelease: a beta must stay
# pinned-only so cdn.onchainsuite.com/inapp.js never serves one to production.
case "$VERSION" in
  *-beta*|*-rc*|*-alpha*)
    echo "prerelease ${VERSION} — versioned only, stable alias left unchanged" ;;
  *)
    aws s3 cp dist/inapp.js "s3://${BUCKET}/inapp.js" \
      --content-type "$CT" \
      --cache-control "public, max-age=300"
    # Invalidate the alias so the move is immediate (the versioned URL never needs it).
    if [ -n "$DISTRIBUTION_ID" ]; then
      aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/inapp.js" >/dev/null
      echo "invalidated /inapp.js on ${DISTRIBUTION_ID}"
    else
      echo "note: set CDN_CF_DISTRIBUTION_ID to auto-invalidate /inapp.js (else wait out its 300s TTL)"
    fi ;;
esac

echo "seeded inapp-${VERSION}.js to ${BUCKET} (https://cdn.onchainsuite.com/inapp-${VERSION}.js)"
