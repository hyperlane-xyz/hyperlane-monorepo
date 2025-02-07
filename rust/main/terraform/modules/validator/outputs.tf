output "validator_info" {
  value = {
    aws_access_key_id     = module.iam_kms.aws_access_key_id,
    aws_secret_access_key = module.iam_kms.aws_secret_access_key,
    aws_kms_alias         = module.iam_kms.validator_signer_key_alias,
    aws_s3_bucket_id      = module.s3.validator_bucket_id,
    aws_region            = var.aws_region,
  }
}
