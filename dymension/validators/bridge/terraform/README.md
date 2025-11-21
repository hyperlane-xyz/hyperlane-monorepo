# Hyperlane Validator Infrastructure - Unified Deployment

This directory contains a unified Terraform configuration that deploys complete validator infrastructure for multiple operators in a single deployment.

## Overview

This configuration manages:
- **1 KMS encryption key** per user for Kaspa (encrypts secrets in Secrets Manager)
- **1 KMS signing key** per user for Dymension (signs validator attestations)
- **2 S3 buckets** per user (one for each chain's signatures)
- **1 EC2 instance** per user (runs both validators)
- **Shared VPC** for all validators
- **Per-user IAM roles** with workload identity

### Architecture Differences: Kaspa vs Dymension

| Feature | Kaspa Validator | Dymension Validator |
|---------|----------------|---------------------|
| **Key Storage** | Private key in Secrets Manager | KMS signing key (no private key stored) |
| **KMS Key Type** | Symmetric (`ENCRYPT_DECRYPT`) | Asymmetric (`SIGN_VERIFY`, `ECC_SECG_P256K1`) |
| **KMS Usage** | Encrypt/decrypt the private key | Sign attestations directly |
| **Signing Method** | Validator reads decrypted key from Secrets Manager | Validator calls KMS Sign API |
| **Security Model** | Key stored encrypted at rest | Key never leaves KMS |

## User Management

Users are defined as a variable in `terraform.tfvars`:

### Adding a New Validator

1. Edit `terraform.tfvars` and add a new entry to `dym_validators`:

```hcl
newuser = {
  email   = "newuser@dymension.xyz"
  ssh_key = "ssh-ed25519 AAAAC3... newuser@dymension.xyz"
  enabled = true
  secret_paths = [
    "validators/newuser/hyperlane/tn/kaspa-key",
    "validators/newuser/hyperlane/tn/dymension-key"
  ]
}
```

2. Apply the changes:

```bash
terraform apply
```

This will create:
- `kaspa-validator-newuser-{env}` KMS key
- `dym-validator-newuser-{env}` KMS key
- `hyperlane-kaspa-signatures-newuser-{env}` S3 bucket
- `hyperlane-dym-signatures-newuser-{env}` S3 bucket
- `hyperlane-validator-newuser-{env}` EC2 instance
- IAM instance profile with scoped permissions

### Disabling a Validator ( Deleting the infrastructure associated with the validator )

Set `enabled = false` for the user in `terraform.tfvars`:

Then apply:

```bash
terraform apply
```

This will destroy all resources for that user.

## Resource Naming Convention

All resources follow a consistent naming pattern:

| Resource Type | Pattern | Example |
|---------------|---------|---------|
| KMS Key (Kaspa Encryption) | `kaspa-validator-{user}-{env}` | `kaspa-validator-omri-tn` |
| KMS Key (Dymension Signing) | `dym-validator-{user}-{env}` | `dym-validator-omri-tn` |
| S3 Bucket (Kaspa) | `hyperlane-kaspa-signatures-{user}-{env}` | `hyperlane-kaspa-signatures-omri-tn` |
| S3 Bucket (Dymension) | `hyperlane-dym-signatures-{user}-{env}` | `hyperlane-dym-signatures-omri-tn` |
| EC2 Instance | `hyperlane-validator-{user}-{env}` | `hyperlane-validator-omri-tn` |
| Log Group | `/hyperlane/validators/{user}` | `/hyperlane/validators/omri` |
| Secrets Path | `validators/{user}/hyperlane/{env}/*` | `validators/omri/hyperlane/tn/kaspa-key` |

## Deployment Guide

### Prerequisites

- AWS CLI configured with appropriate credentials
- Terraform >= 1.0
- SSH public keys for each user

### Step 1: Configure Users

Create a `terraform.tfvars` file (copy from `terraform.tfvars.example`) and configure the `dym_validators` variable with:
- User email addresses
- SSH public keys
- Enable/disable flags
- Secret paths for Secrets Manager

### Step 2: Configure Variables

Edit `terraform.tfvars` with your environment settings:

```hcl
# Environment Configuration
environment = "tn"  # pg, tn, or mn
aws_region  = "eu-central-1"

# EC2 Configuration
instance_type       = "t3.xlarge"
allocate_elastic_ip = true

# User Configuration
dym_validators = {
  yourname = {
    email   = "yourname@example.com"
    ssh_key = "ssh-ed25519 AAAAC3... yourname@example.com"
    enabled = true
    secret_paths = [
      "validators/yourname/hyperlane/tn/kaspa-key",
      "validators/yourname/hyperlane/tn/dymension-key"
    ]
  }
}

# Optional: KMS key for encrypting secrets in Secrets Manager
# secrets_kms_key_arn = "arn:aws:kms:..."
```

### Step 3: Initialize Terraform

```bash
terraform init
```

### Step 4: Review Plan

```bash
terraform plan
```

Review the resources that will be created:
- For 3 enabled users, you should see:
  - 6 KMS keys (2 per user)
  - 6 S3 buckets (2 per user)
  - 3 EC2 instances (1 per user)
  - 3 IAM roles + instance profiles
  - 3 security groups
  - 3 EBS data volumes
  - 1 shared VPC

### Step 5: Apply Configuration

```bash
terraform apply
```

Type `yes` to confirm.

### Step 6: Retrieve Outputs

```bash
# Get all validator details
terraform output
```

## Per-User Resources

Each enabled user automatically gets:

### KMS Keys
- **Kaspa Encryption Key**: `SYMMETRIC_DEFAULT` for encrypting secrets
  - Alias: `alias/kaspa-validator-{user}-{env}`
  - Usage: Encrypt/decrypt Kaspa validator private keys stored in Secrets Manager
  - Key Usage: `ENCRYPT_DECRYPT`

- **Dymension Signing Key**: `ECC_SECG_P256K1` for validator message signing
  - Alias: `alias/dym-validator-{user}-{env}`
  - Usage: Sign Dymension validator attestations directly via KMS
  - Key Usage: `SIGN_VERIFY`

### S3 Buckets
- **Kaspa Signatures Bucket**
  - Public read access (for relayers)
  - Write access: user's instance profile only
  - Versioning enabled
  - Name pattern: `hyperlane-kaspa-signatures-{user}-{env}`

- **Dymension Signatures Bucket**
  - Public read access (for relayers)
  - Write access: user's instance profile only
  - Versioning enabled
  - Name pattern: `hyperlane-dym-signatures-{user}-{env}`

### Secrets Manager Integration
- **Kaspa Private Key Storage**: Stored encrypted in AWS Secrets Manager
  - Path configured via `secret_paths[0]` in user config
  - Encrypted using the user's Kaspa KMS encryption key
  - Example: `validators/yourname/hyperlane/tn/kaspa-key`
- **Dymension**: Uses KMS signing directly (no secret storage needed)

### EC2 Instance
- **Instance Type**: Configurable (default: t3.xlarge)
- **AMI**: Ubuntu 24.04 LTS
- **Volumes**:
  - Root: 50GB encrypted gp3
  - Data: 200GB encrypted gp3
- **Networking**:
  - Elastic IP (optional, recommended)
  - Security group with ports: 22, 9090, 9091
- **IAM**: Instance profile with scoped permissions

### IAM Permissions

The instance profile allows the VM to:
- ✅ **Dymension**: Sign with own KMS signing key
- ✅ **Kaspa**: Encrypt/decrypt with own KMS encryption key (for Secrets Manager)
- ✅ **S3**: Write to own signature buckets only (both Kaspa and Dymension)
- ✅ **Secrets Manager**: Create and read own secrets only (using configured `secret_paths`)
- ✅ **CloudWatch Logs**: Write to own log group only
- ✅ **SSM Parameter Store**: Read own parameters only
- ❌ **Cannot** access other users' resources

## Accessing Resources

### SSH to Your VM

```bash
# Get SSH command from outputs
terraform output ssh_commands

# SSH as specific user
ssh -i /path/to/ssh/key ubuntu@{public-ip}
```

## Outputs Reference

### Main Outputs

```bash
terraform output validators
```

Returns a map with each user's resource details:

```json
{
  "yourname": {
    "kaspa_kms_key_arn": "arn:aws:kms:eu-central-1:...:key/...",
    "dymension_kms_key_arn": "arn:aws:kms:eu-central-1:...:key/...",

    "kaspa_s3_bucket_arn": "arn:aws:s3:::hyperlane-kaspa-signatures-yourname-tn",
    "dymension_s3_bucket_arn": "arn:aws:s3:::hyperlane-dym-signatures-yourname-tn",

    "kaspa_metrics_url": "http://3.66.186.144:9090/metrics",
    "dymension_metrics_url": "http://3.66.186.144:9091/metrics",

    "kaspa_secret_path": "validators/yourname/hyperlane/tn/kaspa-key",
    "kaspa_secret_arn": "arn:aws:secretsmanager:eu-central-1:...:secret:validators/yourname/hyperlane/tn/kaspa-key*"
  }
}
```

## Environment Management

This configuration supports multiple environments:

| Environment | Code | Purpose |
|-------------|------|---------|
| Playground  | `pg` | Development & testing |
| Testnet     | `tn` | Public testnet validation |
| Mainnet     | `mn` | Production mainnet validation |

### Deploying Multiple Environments

Use Terraform workspaces or separate state files:

#### Option 1: Workspaces (Recommended)

```bash
# Playground environment
# Testnet environment
terraform workspace new testnet
terraform apply -var="environment=tn" -var-file="terraform.tn.tfvars"

# Mainnet environment
terraform workspace new mainnet
terraform apply -var="environment=mn" -var-file="terraform.mn.tfvars"
```

## Security Features

### Workload Identity
- EC2 instances use IAM instance profiles (no static credentials)
- Temporary credentials rotated automatically
- All AWS API calls logged to CloudTrail

### User Isolation
- Tag-based access control via IAM policies
- Users can only access resources tagged with their email
- Instance profiles scoped to owner's resources

### Data Protection
- All EBS volumes encrypted at rest
- S3 versioning enabled for audit trail
- KMS keys for signing with CloudTrail logging
- Secrets encrypted in Secrets Manager

### Network Security
- IMDSv2 enabled (optional mode for compatibility)
- Instance metadata tags enabled
- Security groups limit access to required ports (SSH: 22, Metrics: 9090, 9091)
- Public metrics endpoints (read-only)

## Support

For issues or questions:
1. Check CloudWatch Logs: `/hyperlane/validators/{user}`
2. Review Terraform state: `terraform show`
3. Validate IAM permissions using AWS IAM Policy Simulator
4. Check validator container logs: `docker logs hyperlane-validator-kaspa`