output "file_system_id" {
  description = "The ID of the EFS file system"
  value       = aws_efs_file_system.validator_fs.id
}

output "access_point_id" {
  description = "The ID of the EFS access point"
  value       = aws_efs_access_point.validator_ap.id
}

output "mount_target_id" {
  description = "The ID of the EFS mount target"
  value       = aws_efs_mount_target.validator_mt.id
}

output "access_point_arn" {
  description = "The ARN of the EFS access point"
  value       = aws_efs_access_point.validator_ap.arn
}
