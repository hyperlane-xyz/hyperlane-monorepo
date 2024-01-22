variable "validator_name" {
  description = "The name of the validator"
  type        = string
}

variable "validator_execution_user_name" {
  description = "The execution user that will write to the S3 bucket"
  type        = string
}

variable "validator_execution_role_arn" {
  description = "The execution role arn that will write to the S3 bucket"
  type        = string
}
