variable "validator_name" {
  description = "The name of the validator"
  type        = string
}

variable "validator_iam_user_arn" {
  description = "The ARN of the IAM user that will write to the S3 bucket"
  type        = string
}
