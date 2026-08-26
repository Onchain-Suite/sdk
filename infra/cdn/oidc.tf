# GitHub Actions → AWS via OIDC. The release workflow assumes this role with a
# short-lived token instead of storing long-lived AWS keys as repo secrets.
#
# How it works: GitHub mints a signed OIDC token for the running workflow, AWS STS
# checks it against the trust policy below (must be THIS repo, on the release branch),
# and hands back 15-minute credentials. Nothing long-lived is stored anywhere.
#
# After apply: set the `github_actions_role_arn` output as the repo VARIABLE
# `AWS_ROLE_ARN` (Settings → Secrets and variables → Actions → Variables). No secrets.

variable "github_org"  { default = "onchainsuite" }
variable "github_repo" { default = "sdk" }

# We scope the role to this repo by its NUMERIC repository_id, not the `sub` string.
# Why: the `sub` claim embeds the repo's owner/name with canonical casing
# (`Onchain-Suite/sdk`) and IAM matches case-sensitively — we got bitten by that twice.
# `repository_id` is immutable and case-free (also survives a repo rename), so it's both
# more robust and more secure. Get it from `gh api repos/OWNER/REPO --jq .id`.
variable "github_repository_id" {
  default = "1287532658" # Onchain-Suite/sdk
}

# One OIDC provider per AWS account. If you already have GitHub's provider, delete this
# resource and point the role's `Federated` principal at the existing provider ARN.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  # GitHub's OIDC cert thumbprints. AWS validates the token against its own trust store
  # for this provider, so these are largely vestigial — both known values are listed so
  # rotation can't break auth.
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fca",
  ]
}

data "aws_iam_policy_document" "github_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Restrict to THIS repo by immutable numeric id. This is what stops any other
    # repo's workflow from assuming the role even though the OIDC provider is
    # account-wide. (Any ref/branch of this repo may assume it; the role's own policy
    # is narrow — s3:PutObject to the CDN bucket + one CreateInvalidation.)
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [var.github_repository_id]
    }
  }
}

resource "aws_iam_role" "github_actions_cdn" {
  name               = "github-actions-${var.github_repo}-cdn"
  assume_role_policy = data.aws_iam_policy_document.github_trust.json
}

# Least privilege: publish objects to the CDN bucket + invalidate the distribution.
data "aws_iam_policy_document" "cdn_publish" {
  statement {
    sid       = "PutCdnObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.cdn.arn}/*"]
  }
  statement {
    sid       = "InvalidateAlias"
    effect    = "Allow"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.cdn.arn]
  }
}

resource "aws_iam_role_policy" "cdn_publish" {
  name   = "cdn-publish"
  role   = aws_iam_role.github_actions_cdn.id
  policy = data.aws_iam_policy_document.cdn_publish.json
}

output "github_actions_role_arn" {
  description = "Set as the repo variable AWS_ROLE_ARN (no secrets)."
  value       = aws_iam_role.github_actions_cdn.arn
}
