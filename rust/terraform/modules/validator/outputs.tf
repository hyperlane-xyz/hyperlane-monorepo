output "aws_access_key_id" {
  value = module.iam_kms.aws_access_key_id
}

output "aws_secret_access_key" {
  value = module.iam_kms.aws_secret_access_key
}

output "aws_kms_alias" {
  value = module.iam_kms.validator_signer_key_alias
}

output "aws_s3_bucket_id" {
  value = module.s3.validator_bucket_id
}

output "aws_region" {
  value = var.aws_region
}
