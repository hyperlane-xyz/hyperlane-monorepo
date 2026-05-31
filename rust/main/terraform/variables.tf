variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "validator_name" {
  description = "Name used for validator AWS resources"
  type        = string
}

variable "origin_chain_name" {
  description = "Origin chain name for the validator to sign checkpoints for"
  type        = string
}
