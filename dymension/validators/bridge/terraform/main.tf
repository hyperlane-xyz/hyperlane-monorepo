# Unified Hyperlane Validator Infrastructure
# Deploys both KMS keys and EC2 VMs for multiple validator operators

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ============================================================================
# User Configuration
# ============================================================================

locals {
  # Filter enabled validators
  enabled_validators = {
    for name, config in var.dym_validators : name => config
    if config.enabled
  }

  # Filter validators with Dymension-only signing key enabled
  dym_enabled_validators = {
    for name, config in local.enabled_validators : name => config
    if config.with_dym_validator
  }
}

# ============================================================================
# Data Sources
# ============================================================================

# Get available availability zones
data "aws_availability_zones" "available" {
  state = "available"
}

# Data source for the latest Ubuntu 24.04 LTS AMI
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ============================================================================
# KMS Keys - Per User, Per Chain
# ============================================================================

# Kaspa KMS encryption keys (one per user)
# Symmetric key for encrypting secrets in Secrets Manager
resource "aws_kms_key" "kaspa_validator_signer" {
  for_each = local.enabled_validators

  description              = "KMS Key for ${each.key} Kaspa Hyperlane Validator Secrets Encryption"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  deletion_window_in_days  = 30

  tags = {
    Name        = "kaspa-validator-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Chain       = "kaspa"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Kaspa KMS key aliases
resource "aws_kms_alias" "kaspa_validator_signer" {
  for_each = local.enabled_validators

  name          = "alias/kaspa-validator-${each.key}-${var.environment}"
  target_key_id = aws_kms_key.kaspa_validator_signer[each.key].key_id
}

# Dymension KMS signing keys (one per user)
resource "aws_kms_key" "dymension_validator_signer" {
  for_each = local.enabled_validators

  description              = "KMS Key for ${each.key}'s Dymension Hyperlane Validator Signing"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_SECG_P256K1"

  tags = {
    Name        = "dym-validator-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Chain       = "dymension"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Dymension KMS key aliases
resource "aws_kms_alias" "dymension_validator_signer" {
  for_each = local.enabled_validators

  name          = "alias/kaspa-dym-validator-${each.key}-${var.environment}"
  target_key_id = aws_kms_key.dymension_validator_signer[each.key].key_id
}

# Dymension-only KMS signing keys (one per user with with_dym_validator enabled)
resource "aws_kms_key" "dymension_only_validator_signer" {
  for_each = local.dym_enabled_validators

  description              = "KMS Key for ${each.key}'s Dymension Hyperlane Validator Signing"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_SECG_P256K1"

  tags = {
    Name        = "dym-validator-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Chain       = "dymension"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Dymension-only KMS key aliases
resource "aws_kms_alias" "dymension_only_validator_signer" {
  for_each = local.dym_enabled_validators

  name          = "alias/dym-validator-${each.key}-${var.environment}"
  target_key_id = aws_kms_key.dymension_only_validator_signer[each.key].key_id
}

# ============================================================================
# S3 Buckets - Per User, Per Chain
# ============================================================================

# Kaspa validator signature buckets
resource "aws_s3_bucket" "kaspa_signatures" {
  for_each = local.enabled_validators

  bucket = "hyperlane-kaspa-signatures-${each.key}-${var.environment}"

  tags = {
    Name        = "hyperlane-kaspa-signatures-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Chain       = "kaspa"
    Environment = var.environment
    Purpose     = "hyperlane-validator-signatures"
    ManagedBy   = "terraform"
  }
}

# Kaspa bucket versioning
resource "aws_s3_bucket_versioning" "kaspa_signatures" {
  for_each = local.enabled_validators

  bucket = aws_s3_bucket.kaspa_signatures[each.key].id

  versioning_configuration {
    status = "Enabled"
  }
}

# Kaspa bucket public access settings
resource "aws_s3_bucket_public_access_block" "kaspa_signatures" {
  for_each = local.enabled_validators

  bucket = aws_s3_bucket.kaspa_signatures[each.key].id

  block_public_acls       = true
  block_public_policy     = false # Allow public bucket policy
  ignore_public_acls      = true
  restrict_public_buckets = false # Allow public read access
}

# Kaspa bucket policy (public read, owner write)
resource "aws_s3_bucket_policy" "kaspa_signatures" {
  for_each = local.enabled_validators

  bucket = aws_s3_bucket.kaspa_signatures[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PublicReadAccess"
        Effect = "Allow"
        Principal = "*"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          "${aws_s3_bucket.kaspa_signatures[each.key].arn}/*",
          aws_s3_bucket.kaspa_signatures[each.key].arn
        ]
      },
      {
        Sid    = "ValidatorWriteAccess"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.validator_instance[each.key].arn
        }
        Action = [
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.kaspa_signatures[each.key].arn}/*"
      }
    ]
  })

  depends_on = [
    aws_s3_bucket_public_access_block.kaspa_signatures
  ]
}

# Dymension validator signature buckets
resource "aws_s3_bucket" "dymension_signatures" {
  for_each = local.enabled_validators

  bucket = "hyperlane-dym-signatures-${each.key}-${var.environment}"

  tags = {
    Name        = "hyperlane-dym-signatures-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Chain       = "dymension"
    Environment = var.environment
    Purpose     = "hyperlane-validator-signatures"
    ManagedBy   = "terraform"
  }
}

# Dymension bucket versioning
resource "aws_s3_bucket_versioning" "dymension_signatures" {
  for_each = local.enabled_validators

  bucket = aws_s3_bucket.dymension_signatures[each.key].id

  versioning_configuration {
    status = "Enabled"
  }
}

# Dymension bucket public access settings
resource "aws_s3_bucket_public_access_block" "dymension_signatures" {
  for_each = local.enabled_validators

  bucket = aws_s3_bucket.dymension_signatures[each.key].id

  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

# Dymension bucket policy
resource "aws_s3_bucket_policy" "dymension_signatures" {
  for_each = local.enabled_validators

  bucket = aws_s3_bucket.dymension_signatures[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PublicReadAccess"
        Effect = "Allow"
        Principal = "*"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          "${aws_s3_bucket.dymension_signatures[each.key].arn}/*",
          aws_s3_bucket.dymension_signatures[each.key].arn
        ]
      },
      {
        Sid    = "ValidatorWriteAccess"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.validator_instance[each.key].arn
        }
        Action = [
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.dymension_signatures[each.key].arn}/*"
      }
    ]
  })

  depends_on = [
    aws_s3_bucket_public_access_block.dymension_signatures
  ]
}

# ============================================================================
# VPC & Networking - Shared
# ============================================================================

# Shared VPC for all validators
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "hyperlane-validators-vpc-${var.environment}"
  cidr = var.vpc_cidr

  azs            = [data.aws_availability_zones.available.names[0]]
  public_subnets = [var.public_subnet_cidr]

  enable_nat_gateway   = false
  enable_vpn_gateway   = false
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "hyperlane-validators-vpc-${var.environment}"
    Environment = var.environment
    ManagedBy   = "terraform"
    Purpose     = "hyperlane-validators"
  }
}

# ============================================================================
# Security Groups - Per User
# ============================================================================

resource "aws_security_group" "validator" {
  for_each = local.enabled_validators

  name_prefix = "hyperlane-validator-${each.key}-${var.environment}-"
  description = "Security group for ${each.key} Hyperlane validator"
  vpc_id      = module.vpc.vpc_id

  # SSH access
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Kaspa validator metrics
  ingress {
    description = "Kaspa Validator Metrics"
    from_port   = 9090
    to_port     = 9090
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Dymension validator metrics
  ingress {
    description = "Dymension Validator Metrics"
    from_port   = 9091
    to_port     = 9091
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow all outbound traffic
  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "hyperlane-validator-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ============================================================================
# SSH Key Pairs - Per User
# ============================================================================

resource "aws_key_pair" "validator" {
  for_each = local.enabled_validators

  key_name   = "hyperlane-validator-${each.key}-${var.environment}"
  public_key = each.value.ssh_key

  tags = {
    Name        = "hyperlane-validator-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ============================================================================
# IAM Roles - Per User (Instance Profiles with Workload Identity)
# ============================================================================

# IAM Role for EC2 instance
resource "aws_iam_role" "validator_instance" {
  for_each = local.enabled_validators

  name_prefix = "hyperlane-validator-${each.key}-${var.environment}-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "hyperlane-validator-instance-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# IAM Instance Profile
resource "aws_iam_instance_profile" "validator" {
  for_each = local.enabled_validators

  name_prefix = "hyperlane-validator-${each.key}-${var.environment}-"
  role        = aws_iam_role.validator_instance[each.key].name

  tags = {
    Name        = "hyperlane-validator-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# IAM Policy for instance profile (user-scoped access)
resource "aws_iam_role_policy" "validator_instance_access" {
  for_each = local.enabled_validators

  name_prefix = "validator-access-"
  role        = aws_iam_role.validator_instance[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      # KMS permissions for Kaspa-Dymension signing key
      {
        Sid    = "KMSSignKaspaDymensionKeyOnly"
        Effect = "Allow"
        Action = [
          "kms:Sign",
          "kms:GetPublicKey",
          "kms:DescribeKey"
        ]
        Resource = [
          aws_kms_key.dymension_validator_signer[each.key].arn
        ]
      },
      # KMS permissions for Kaspa encryption key (used with Secrets Manager)
      {
        Sid    = "KMSEncryptKaspaKeyOnly"
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:GetPublicKey",
          "kms:DescribeKey"
        ]
        Resource = [
          aws_kms_key.kaspa_validator_signer[each.key].arn
        ]
      },
      # S3 permissions - Write to own buckets only
      {
        Sid    = "S3WriteOwnBucketsOnly"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:DeleteObject"
        ]
        Resource = [
          aws_s3_bucket.kaspa_signatures[each.key].arn,
          "${aws_s3_bucket.kaspa_signatures[each.key].arn}/*",
          aws_s3_bucket.dymension_signatures[each.key].arn,
          "${aws_s3_bucket.dymension_signatures[each.key].arn}/*"
        ]
      },
      # Secrets Manager permissions - Read and Create own secrets only
      {
        Sid    = "SecretsManageOwnSecretsOnly"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource",
        ]
        Resource = [
          for path in each.value.secret_paths :
          "arn:aws:secretsmanager:${var.aws_region}:*:secret:${path}*"
        ]
      },
      # KMS Decrypt for secrets
      {
        Sid    = "KMSDecryptForSecrets"
        Effect = "Allow"
        Action = "kms:Decrypt"
        Resource = var.secrets_kms_key_arn != "" ? [var.secrets_kms_key_arn] : ["*"]
        Condition = {
          StringLike = {
            "kms:EncryptionContext:SecretARN" = [
              for path in each.value.secret_paths :
              "arn:aws:secretsmanager:${var.aws_region}:*:secret:${path}*"
            ]
          }
        }
      },
      # CloudWatch Logs permissions
      {
        Sid    = "LogsWriteOwnGroupOnly"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = [
          "arn:aws:logs:${var.aws_region}:*:log-group:/hyperlane/validators/${each.key}:*"
        ]
      },
      # SSM Parameter Store permissions
      {
        Sid    = "SSMReadConfig"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:*:parameter/hyperlane/${each.key}/*"
        ]
      }
    ],
    # Conditionally add Dymension-only KMS key permissions if enabled
    each.value.with_dym_validator ? [
      {
        Sid    = "KMSSignDymensionOnlyKey"
        Effect = "Allow"
        Action = [
          "kms:Sign",
          "kms:GetPublicKey",
          "kms:DescribeKey"
        ]
        Resource = [
          aws_kms_key.dymension_only_validator_signer[each.key].arn
        ]
      }
    ] : [])
  })
}

# ============================================================================
# CloudWatch Log Groups - Per User
# ============================================================================

resource "aws_cloudwatch_log_group" "validator" {
  for_each = local.enabled_validators

  name              = "/hyperlane/validators/${each.key}"
  retention_in_days = var.log_retention_days

  tags = {
    Name        = "hyperlane-validators-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ============================================================================
# EBS Volumes - Per User
# ============================================================================

resource "aws_ebs_volume" "validator_data" {
  for_each = local.enabled_validators

  availability_zone = data.aws_availability_zones.available.names[0]
  size              = var.data_volume_size_gb
  type              = var.data_volume_type
  encrypted         = true
  iops              = var.data_volume_type == "gp3" ? var.data_volume_iops : null
  throughput        = var.data_volume_type == "gp3" ? var.data_volume_throughput : null

  tags = {
    Name        = "hyperlane-validator-data-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Environment = var.environment
    ManagedBy   = "terraform"
    Purpose     = "validator-database"
  }
}

# ============================================================================
# EC2 Instances - Per User
# ============================================================================

resource "aws_instance" "validator" {
  for_each = local.enabled_validators

  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  key_name      = aws_key_pair.validator[each.key].key_name
  subnet_id     = module.vpc.public_subnets[0]

  availability_zone           = data.aws_availability_zones.available.names[0]
  associate_public_ip_address = true

  vpc_security_group_ids = [aws_security_group.validator[each.key].id]
  iam_instance_profile   = aws_iam_instance_profile.validator[each.key].name

  # Root volume
  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    delete_on_termination = true
    encrypted             = true
  }

  # Ensure instance doesn't terminate on shutdown
  instance_initiated_shutdown_behavior = "stop"

  # Enable detailed monitoring
  monitoring = var.enable_detailed_monitoring

  # Metadata options (IMDSv2)
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "optional"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  tags = {
    Name        = "hyperlane-validator-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Environment = var.environment
    ManagedBy   = "terraform"
    Purpose     = "hyperlane-validators"
    Validators  = "kaspa,dymension"
  }

  volume_tags = {
    Name        = "hyperlane-validator-root-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Environment = var.environment
    ManagedBy   = "terraform"
    VolumeType  = "root"
  }
}

# Attach the data EBS volume to each instance
resource "aws_volume_attachment" "validator_data" {
  for_each = local.enabled_validators

  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.validator_data[each.key].id
  instance_id = aws_instance.validator[each.key].id

  depends_on = [aws_instance.validator]
}

# ============================================================================
# Elastic IPs - Per User (Optional)
# ============================================================================

resource "aws_eip" "validator" {
  for_each = var.allocate_elastic_ip ? local.enabled_validators : {}

  domain = "vpc"

  tags = {
    Name        = "hyperlane-validator-${each.key}-${var.environment}"
    Owner       = each.value.email
    User        = each.key
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  depends_on = [module.vpc]
}

# Associate Elastic IP with instances
resource "aws_eip_association" "validator" {
  for_each = var.allocate_elastic_ip ? local.enabled_validators : {}

  instance_id   = aws_instance.validator[each.key].id
  allocation_id = aws_eip.validator[each.key].id
}
