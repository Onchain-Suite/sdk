#!/usr/bin/env bash
# Build dist/inapp.js and push it to the R2 CDN bucket by hand.
#
# Use this to (a) seed the bucket so cdn.onchainsuite.com serves a file BEFORE the
# release workflow has run, and (b) re-seed / hotfix without cutting a release.
# Normal releases upload automatically via .github/workflows/release.yml.
#
# Needs: wrangler logged in (`npx wrangler login`) to the account that owns the bucket.
#   export R2_BUCKET=onchainsuite-cdn   # or pass as $1
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

BUCKET="${1:-${R2_BUCKET:-onchainsuite-cdn}}"
VERSION="$(node -p "require('./package.json').version")"
CT="text/javascript; charset=utf-8"

npm run build
test -f dist/inapp.js || { echo "dist/inapp.js missing after build" >&2; exit 1; }

# Immutable versioned object — the URL changes every release, so cache it forever.
npx wrangler r2 object put "${BUCKET}/inapp-${VERSION}.js" \
  --file dist/inapp.js \
  --content-type "$CT" \
  --cache-control "public, max-age=31536000, immutable"

# Stable alias — short TTL. Never point it at a prerelease: a beta must stay
# pinned-only so cdn.onchainsuite.com/inapp.js never serves one to production.
case "$VERSION" in
  *-beta*|*-rc*|*-alpha*)
    echo "prerelease ${VERSION} — versioned only, stable alias left unchanged" ;;
  *)
    npx wrangler r2 object put "${BUCKET}/inapp.js" \
      --file dist/inapp.js \
      --content-type "$CT" \
      --cache-control "public, max-age=300" ;;
esac

echo "seeded inapp-${VERSION}.js to ${BUCKET} (https://cdn.onchainsuite.com/inapp-${VERSION}.js)"
