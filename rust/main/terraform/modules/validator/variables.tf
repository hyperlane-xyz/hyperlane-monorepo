variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "validator_cluster_id" {
  description = "ID of the validator cluster"
  type        = string
}

variable "validator_subnet_id" {
  description = "ID of the validator subnet"
  type        = string
}

variable "validator_sg_id" {
  description = "ID of the validator security group"
  type        = string
}

variable "validator_nat_gateway_id" {
  description = "ID of the validator NAT gateway"
  type        = string
}

variable "validator_name" {
  description = "The name of the validator"
  type        = string
}

variable "origin_chain_name" {
  description = "The origin chain of the validator"
  type        = string
}

variable "validator_cpu" {
  description = "CPU units used by the validator. Default 1 vCPU."
  type        = string
  default     = "1024"
}

variable "validator_memory" {
  description = "Memory units used by the validator. Default 6GB."
  type        = string
  default     = "6144"
}

variable "aws_log_group" {
  description = "The name of the log group to write to"
  type        = string
  default     = "DefaultLogGroup"
}

variable "validator_image_version" {
  description = "The name of the log group to write to"
  type        = string
  default     = "f44589e-20231130-114734"
}

variable "validator_task_disabled" {
  description = "Whether to run the validator in addition to auxiliary setup"
  type = bool
  default = false
}
