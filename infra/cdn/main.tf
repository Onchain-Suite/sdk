# cdn.onchainsuite.com — S3 origin + CloudFront, for the SDK browser loader.
#
# Why AWS and not Cloudflare R2: onchainsuite.com's DNS is on GoDaddy, and Cloudflare
# R2 custom domains require the whole domain on Cloudflare (subdomain-only zones are
# Enterprise-only) — a nameserver move we avoid to keep SES email untouched. CloudFront
# takes a plain CNAME at GoDaddy, so nameservers never move.
#
# Two DNS records are added MANUALLY at GoDaddy (DNS is not on Route 53); the outputs
# print exactly what to add:
#   1. the ACM validation CNAME  (so the cert issues)
#   2. CNAME  cdn  ->  <cloudfront_domain>   (so the hostname resolves)
#
# Apply flow (because validation DNS lives at GoDaddy):
#   terraform apply -target=aws_acm_certificate.cdn   # creates cert, prints validation
#   # add the printed validation CNAME at GoDaddy, wait for it to resolve
#   terraform apply                                   # issues cert, builds CloudFront
#   # add the printed  cdn -> cloudfront_domain  CNAME at GoDaddy

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}

variable "aws_region"  { default = "us-east-1" }
variable "domain"      { default = "cdn.onchainsuite.com" }
variable "bucket_name" { default = "onchainsuite-cdn" }

provider "aws" {
  region = var.aws_region
}

# CloudFront viewer certs MUST live in us-east-1, regardless of the bucket's region.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# ---------------------------------------------------------------------------
# S3: private origin bucket. Nothing is public; only CloudFront (via OAC) reads it.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "cdn" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "cdn" {
  bucket                  = aws_s3_bucket.cdn.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# ACM certificate (us-east-1) for the CDN hostname. DNS-validated at GoDaddy.
# ---------------------------------------------------------------------------
resource "aws_acm_certificate" "cdn" {
  provider          = aws.us_east_1
  domain_name       = var.domain
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

# Waits until the cert is ISSUED (i.e. until you've added the validation CNAME at
# GoDaddy and it resolves). No validation_record_fqdns because the record isn't in
# Route 53 — it's added by hand at GoDaddy.
resource "aws_acm_certificate_validation" "cdn" {
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.cdn.arn
  timeouts { create = "60m" }
}

# ---------------------------------------------------------------------------
# CloudFront: OAC to the private bucket, CORS + security headers, TLS.
# ---------------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "cdn" {
  name                              = "onchainsuite-cdn-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Public JS asset → permissive CORS so integrity=/crossorigin loads work anywhere,
# plus a couple of hardening headers. CloudFront emits these on every response.
resource "aws_cloudfront_response_headers_policy" "cdn" {
  name = "onchainsuite-cdn-headers"

  cors_config {
    access_control_allow_credentials = false
    access_control_allow_headers { items = ["*"] }
    access_control_allow_methods { items = ["GET", "HEAD"] }
    access_control_allow_origins { items = ["*"] }
    origin_override = true
  }

  security_headers_config {
    content_type_options { override = true } # X-Content-Type-Options: nosniff
  }

  custom_headers_config {
    items {
      header   = "Cross-Origin-Resource-Policy"
      value    = "cross-origin"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "cdn" {
  enabled     = true
  aliases     = [var.domain]
  price_class = "PriceClass_100" # NA + EU (cheapest). Bump to _All for global edge.
  comment     = "cdn.onchainsuite.com — SDK browser loader"

  origin {
    domain_name              = aws_s3_bucket.cdn.bucket_regional_domain_name
    origin_id                = "s3-cdn"
    origin_access_control_id = aws_cloudfront_origin_access_control.cdn.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-cdn"
    viewer_protocol_policy  = "redirect-to-https"
    allowed_methods         = ["GET", "HEAD"]
    cached_methods          = ["GET", "HEAD"]
    compress                = true

    # Managed "CachingOptimized" — honours the object's Cache-Control (our immutable
    # vs 300s alias) within min/max TTLs, forwards no cookies/query, gzip+br.
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.cdn.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cdn.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# Bucket policy: only THIS distribution may read the objects (OAC + SourceArn).
resource "aws_s3_bucket_policy" "cdn" {
  bucket = aws_s3_bucket.cdn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontServicePrincipalRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.cdn.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.cdn.arn }
      }
    }]
  })
}

# ---------------------------------------------------------------------------
# Outputs — the two records to add at GoDaddy, and the distribution id for CI.
# ---------------------------------------------------------------------------
output "acm_validation_record" {
  description = "Add this CNAME at GoDaddy so the ACM cert can issue."
  value = one([
    for o in aws_acm_certificate.cdn.domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ])
}

output "cdn_cname_target" {
  description = "Add at GoDaddy:  CNAME  cdn  ->  this value."
  value       = aws_cloudfront_distribution.cdn.domain_name
}

output "cloudfront_distribution_id" {
  description = "Set as the CDN_CF_DISTRIBUTION_ID repo variable (for alias invalidation)."
  value       = aws_cloudfront_distribution.cdn.id
}
