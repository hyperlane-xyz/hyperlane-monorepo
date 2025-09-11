# Scripts

## Scripts for ensuring consistency between relayer, validator and on-chain data

### `check_message_db_integrity_validator_onchain.sh`

Checks validator posted checkpoint message ids with on-chain message ids (merkle tree hook ism).
This script only works for EVM chains.

Example usage:

```bash
./check_message_db_integrity_validator_onchain.sh \
    --rpc-url 'https://eth.llamarpc.com' \
    --merkle-hook-address '0x48e6c30B97748d1e2e03bf3e9FbE3890ca5f8CCA' \
    --chain-name 'ethereum' \
    --start-block 12345
```

### `check_message_db_integrity_relayer_onchain.sh`

Checks relayer checkpoint message ids with on-chain message ids (merkle tree hook ism).
This script only works for EVM chains.

Example usage:

```bash
./check_message_db_integrity_relayer_onchain.sh \
    --rpc-url 'https://eth.llamarpc.com' \
    --merkle-hook-address '0x48e6c30B97748d1e2e03bf3e9FbE3890ca5f8CCA' \
    --domain-id 1 \
    --start-block 12345
```

### `check_message_db_integrity_relayer_validator.sh`

Checks relayer checkpoint message ids with validator checkpoint message id.

Example usage:

```bash
./check_message_db_integrity_relayer_validator.sh \
    --domain-id 1 \
    --chain-name ethereum \
    --leaf-index-start 1100
```

### `check_merkle_db_integrity_relayer_validator.sh`

Checks relayer checkpoint root with validator checkpoint root.

Example usage:

```bash
./check_merkle_db_integrity_relayer_validator.sh \
    --domain-id 1 \
    --chain-name ethereum \
    --leaf-index-start 1100
```
