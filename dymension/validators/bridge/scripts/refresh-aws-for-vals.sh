#!/usr/bin/env bash
set -euo pipefail

# Config
DYM_DIR="${HOME}/dym"
IMDS_BASE="http://169.254.169.254/latest"

# Get IMDSv2 token
TOKEN=$(curl -sS -X PUT "${IMDS_BASE}/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

# Get role name
ROLE_NAME=$(curl -sS -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  "${IMDS_BASE}/meta-data/iam/security-credentials/")

# Get credentials JSON
CREDS=$(curl -sS -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  "${IMDS_BASE}/meta-data/iam/security-credentials/${ROLE_NAME}")

AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r '.AccessKeyId')
AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r '.SecretAccessKey')
AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r '.Token')

# Export for this shell so docker compose sees them
export AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY
export AWS_SESSION_TOKEN

cd "$DYM_DIR"

# Restart stack so containers pick up new env
docker compose down
docker compose up -d
