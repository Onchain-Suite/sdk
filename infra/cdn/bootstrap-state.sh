#!/usr/bin/env bash
# Create the S3 bucket that holds Terraform remote state (see backend.tf).
# Run ONCE, before `terraform init -migrate-state`. Idempotent-ish: re-running
# after the bucket exists just re-applies the settings.
#
# Needs the AWS CLI configured with rights to create/configure an S3 bucket.
set -euo pipefail

BUCKET="${1:-onchainsuite-tf-state}"
REGION="${AWS_REGION:-us-east-1}"

# create-bucket: us-east-1 must NOT get a LocationConstraint; every other region must.
if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null \
    || echo "bucket $BUCKET already exists (or you own it) — continuing"
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" 2>/dev/null \
    || echo "bucket $BUCKET already exists (or you own it) — continuing"
fi

# Versioning: keep state history so a bad apply can be recovered.
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# Encrypt at rest.
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# State can contain secrets — never public.
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "state bucket ready: s3://${BUCKET} (versioned, encrypted, private)"
echo "next: terraform init -migrate-state"
