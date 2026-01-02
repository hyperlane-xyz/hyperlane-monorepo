# Kaspa-Dymension Validator Monitoring Guide

Quick reference for monitoring validator logs and diagnosing issues.

## Critical Errors

### 1. AWS Secrets Manager & KMS Errors

**Log Messages:**

```
get secret value from AWS Secrets Manager
decrypt key material using AWS KMS
```

**Root Causes:**

- Wrong `secretId` or `kmsKeyId` in config
- Missing IAM permissions (`secretsmanager:GetSecretValue`, `kms:Decrypt`)
- Docker can't reach EC2 metadata (169.254.169.254) - need `network_mode: host`

### 2. Hub gRPC Errors

**Log Messages:**

```
Hub is not bootstrapped
Hub query error
```

**Root Causes:**

- Wrong `grpcUrls` in config
- Hub not synced
- Firewall blocking gRPC port

### 3. Kaspa REST API Errors

**Log Messages:**

```
External API error
ValidationError::ExternalApiError
```

**Root Causes:**

- Wrong `kaspaUrlsRest` in config
- REST API down or rate limited
- API behind chain state

### 4. Kaspa Node (WRPC) Errors

**Log Messages:**

```
Kaspa node error
Failed to create easy wallet
```

**Root Causes:**

- Wrong `kaspaUrlsWrpc` format (should be `host:port` not `ws://host:port`)
- Node not synced or unreachable

### 5. Wrong Deposit Address

**Log Messages:**

```
WrongDepositAddress { expected: "...", actual: "..." }
```

**Root Causes:**

- Wrong `kaspaValidators` escrowPub keys or order
- Wrong `kaspaMultisigThresholdEscrow`
- Network prefix mismatch

### 6. Reorg Protection

**Log Messages:**

```
not safe against reorg
confirmations=<N> required=<M>
```

**Root Causes:**

- Normal - needs more confirmations (retryable)
- REST API stale data
