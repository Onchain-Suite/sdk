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

# Trust is scoped two ways (both must hold): the immutable numeric repository_id AND
# the sub matched case-INSENSITIVELY.
#
# The casing saga: GitHub emits the OIDC `sub` claim with a DIFFERENT casing than the
# `repository`/provenance claim — so even an exact mixed-case `Onchain-Suite` StringLike
# was denied. `StringEqualsIgnoreCase` (which AWS's own error message pointed to) fixes
# that. And AWS REQUIRES a sub or job_workflow_ref condition on the GitHub provider — a
# repository_id-only policy is rejected as MalformedPolicyDocument — so sub must be here
# regardless. repository_id stays as an extra, case-free, rename-proof guard.
variable "github_repository_id" {
  default = "1287532658" # Onchain-Suite/sdk (gh api repos/OWNER/REPO --jq .id)
}

variable "github_allowed_sub" {
  # This org has OIDC SUBJECT-CLAIM CUSTOMIZATION on, so the real `sub` embeds the
  # numeric owner-id + repo-id (verified via a debug workflow):
  #   repo:Onchain-Suite@311798183/sdk@1287532658:ref:refs/heads/main
  # NOT the default `repo:OWNER/REPO:ref:...` — that's why every earlier match missed.
  # Matched case-insensitively (StringEqualsIgnoreCase) for good measure; restricts to
  # the main branch. If the org's subject-claim template changes, re-check with the
  # debug workflow. (repository_id below is the rename-proof pin regardless.)
  default = "repo:Onchain-Suite@311798183/sdk@1287532658:ref:refs/heads/main"
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

    # Branch/repo restriction via sub, matched case-insensitively (see var comment).
    # Required by AWS for the GitHub provider, and this is where casing bit us.
    condition {
      test     = "StringEqualsIgnoreCase"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [var.github_allowed_sub]
    }

    # Extra guard: pin to THIS repo by immutable numeric id (case-free, rename-proof).
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
