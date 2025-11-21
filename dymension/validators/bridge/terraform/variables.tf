# Variables for Unified Hyperlane Validator Infrastructure

variable "aws_region" {
  description = "AWS region where resources will be deployed"
  type        = string
  default     = "eu-central-1"
}

variable "environment" {
  description = "Environment name (pg, tn, mn)"
  type        = string
  default     = "pg"

  validation {
    condition     = contains(["pg", "tn", "mn"], var.environment)
    error_message = "Environment must be one of: pg (playground), tn (testnet), mn (mainnet)."
  }
}

# ============================================================================
# VPC Configuration
# ============================================================================

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "192.168.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR block for the public subnet"
  type        = string
  default     = "192.168.1.0/24"
}

# ============================================================================
# EC2 Instance Configuration
# ============================================================================

variable "instance_type" {
  description = "EC2 instance type for running validators"
  type        = string
  default     = "t3.xlarge" # 4 vCPU, 16GB RAM
}

variable "allocate_elastic_ip" {
  description = "Whether to allocate and associate Elastic IPs with instances"
  type        = bool
  default     = true
}

# ============================================================================
# Storage Configuration
# ============================================================================

variable "root_volume_size_gb" {
  description = "Size of the root volume in GB"
  type        = number
  default     = 50
}

variable "data_volume_size_gb" {
  description = "Size of the data volume for validator databases in GB"
  type        = number
  default     = 200
}

variable "data_volume_type" {
  description = "EBS volume type for data volume (gp3, gp2, io1, io2)"
  type        = string
  default     = "gp3"
}

variable "data_volume_iops" {
  description = "IOPS for data volume (only for gp3, io1, io2)"
  type        = number
  default     = 3000
}

variable "data_volume_throughput" {
  description = "Throughput in MB/s for data volume (only for gp3)"
  type        = number
  default     = 125
}

# ============================================================================
# Secrets Management
# ============================================================================

variable "secrets_kms_key_arn" {
  description = "ARN of the KMS key used to encrypt secrets in Secrets Manager (shared across users)"
  type        = string
  default     = ""
}

# ============================================================================
# Monitoring Configuration
# ============================================================================

variable "enable_detailed_monitoring" {
  description = "Enable detailed CloudWatch monitoring for instances"
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Number of days to retain CloudWatch logs"
  type        = number
  default     = 30
}

# ============================================================================
# Validator Configuration
# ============================================================================

variable "dym_validators" {
  description = "Map of validator operators and their metadata"
  type = map(object({
    email             = string
    ssh_key           = string
    enabled           = bool
    secret_paths      = list(string)
    with_dym_validator = bool
  }))
}
