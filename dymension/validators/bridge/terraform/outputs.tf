# Outputs for Unified Hyperlane Validator Infrastructure

output "validators" {
  description = "Essential information for each validator operator"
  value = {
    for name, config in local.enabled_validators : name => {
      # KMS Key ARNs
      kaspa_kms_key_arn     = aws_kms_key.kaspa_validator_signer[name].arn
      kaspa_dym_kms_key_arn = aws_kms_key.dymension_validator_signer[name].arn
      dymension_kms_key_arn = lookup(aws_kms_key.dymension_only_validator_signer, name, null) != null ? aws_kms_key.dymension_only_validator_signer[name].arn : null

      # S3 Bucket ARNs
      kaspa_s3_bucket_arn     = aws_s3_bucket.kaspa_signatures[name].arn
      dymension_s3_bucket_arn = aws_s3_bucket.dymension_signatures[name].arn

      # Metrics URLs
      kaspa_metrics_url     = "http://${var.allocate_elastic_ip ? aws_eip.validator[name].public_ip : aws_instance.validator[name].public_ip}:9090/metrics"
      dymension_metrics_url = "http://${var.allocate_elastic_ip ? aws_eip.validator[name].public_ip : aws_instance.validator[name].public_ip}:9091/metrics"

      # Secrets Manager (for Kaspa keypair)
      kaspa_secret_path = config.secret_paths[0] # validators/<user>/hyperlane/kaspa-key
      kaspa_secret_arn  = "arn:aws:secretsmanager:${var.aws_region}:*:secret:${config.secret_paths[0]}*"
    }
  }
}
