---
name: validator-health
description: Checks Hyperlane validator health and checkpoint status. Use when validators are behind, messages are stuck due to ISM issues, or checking checkpoint lag.
---

# Validator Health Check

## Check Merkle Tree Index

```bash
# Get on-chain merkle tree count (= next index)
cast call $(addr <chain> mailbox) "count()(uint32)" --rpc-url $(meta <chain> rpc)
```

## Check Validator Announce

```bash
# Get announced validators
cast call $(addr <chain> validatorAnnounce) "getAnnouncedValidators()(address[])" \
  --rpc-url $(meta <chain> rpc)
```

## Check Validator Balance

```bash
cast balance <validator_address> --rpc-url $(meta <chain> rpc) --ether
```

## GCP Logs (Internal)

```bash
# Validator errors
gcloud logging read 'resource.labels.container_name="validator" severity>=ERROR' \
  --project=abacus-labs-dev --limit=20

# Checkpoint activity
gcloud logging read 'resource.labels.container_name="validator" jsonPayload.message=~"checkpoint"' \
  --project=abacus-labs-dev --limit=20
```

## Health Metrics

- **Checkpoint lag**: Compare validator index vs on-chain count
- **Signing status**: Check logs for recent checkpoint submissions
- **Balance**: Ensure signing key has gas for announcements
