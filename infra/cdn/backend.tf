# Remote Terraform state in S3, so state isn't trapped on one laptop and two
# people can't clobber each other. Uses S3-NATIVE locking (use_lockfile, Terraform
# >= 1.10) — no DynamoDB table to run.
#
# Chicken-and-egg: the state bucket must exist BEFORE `terraform init` can use it.
# Bootstrap it once with `./bootstrap-state.sh`, then migrate existing local state:
#
#   ./bootstrap-state.sh                 # creates onchainsuite-tf-state (versioned, encrypted, private)
#   terraform init -migrate-state        # answer "yes" to copy local state up to S3
#
# After migration the local terraform.tfstate is no longer authoritative (it's
# gitignored anyway). To roll back to local state, comment this block out and run
# `terraform init -migrate-state` again.

terraform {
  backend "s3" {
    bucket       = "onchainsuite-tf-state"
    key          = "cdn/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
