variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "validator_name" {
  description = "The name of the validator"
  type        = string
}

variable "aws_log_group" {
  description = "The name of the log group to write to"
  type        = string
}

variable "efs_access_point_arn" {
  description = "The ARN of the EFS access point"
  type        = string
}
