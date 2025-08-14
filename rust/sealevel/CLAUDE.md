# Hyperlane Sealevel CLI User Guide

## Overview

The Hyperlane Sealevel Client is a comprehensive command-line tool for deploying, configuring, and managing Hyperlane protocol components on Solana and SVM-compatible chains (Eclipse, Sonic, Soon, etc.). This tool enables cross-chain messaging, token bridging, and interchain gas payments on Solana-based networks.

## Installation & Setup

### Building from Source
```bash
cd /Users/danwt/Documents/dym/d-hyperlane-monorepo/rust/sealevel
cargo build --release --bin hyperlane-sealevel-client
# Binary will be at: ./target/release/hyperlane-sealevel-client
```

### Basic Usage
```bash
# Run with cargo
cargo run -- [OPTIONS] <COMMAND>

# Or use the built binary
./target/release/hyperlane-sealevel-client [OPTIONS] <COMMAND>
```

## Global Options

All commands accept these global options:

- `-u, --url <URL>`: RPC endpoint URL (defaults to config file or localhost)
- `-k, --keypair <KEYPAIR>`: Path to keypair file or public key
- `-b, --compute-budget <BUDGET>`: Compute units limit (default: 1400000, max: 1400000)
- `-a, --heap-size <SIZE>`: Heap frame size in bytes (max: 256KB)
- `-C, --config <CONFIG>`: Path to Solana CLI config file
- `--require-tx-approval`: Require manual approval before sending transactions

## Core Commands

### 1. Core - Deploy Core Hyperlane Infrastructure

Deploys the core Hyperlane programs (Mailbox, ISM, IGP, Validator Announce).

```bash
cargo run -- core deploy \
  --local-domain <DOMAIN_ID> \
  --environment <ENV> \
  --environments-dir <PATH> \
  --chain <CHAIN_NAME> \
  --remote-domains <DOMAIN1,DOMAIN2> \
  --built-so-dir <PATH_TO_COMPILED_PROGRAMS>
```

**Options:**
- `--protocol-fee-config-file`: JSON file with protocol fee configuration
- `--gas-oracle-config-file`: JSON file with gas oracle settings
- `--overhead-config-file`: JSON file with gas overhead configuration

### 2. Mailbox - Message Passing Operations

The Mailbox is the core contract for sending and receiving cross-chain messages.

#### Initialize Mailbox
```bash
cargo run -- mailbox init \
  --program-id <MAILBOX_PROGRAM_ID> \
  --local-domain <DOMAIN_ID> \
  --default-ism <ISM_PROGRAM_ID> \
  --max-protocol-fee <LAMPORTS> \
  --protocol-fee <LAMPORTS>
```

#### Query Mailbox State
```bash
cargo run -- mailbox query --program-id <MAILBOX_PROGRAM_ID>
```

#### Send Message
```bash
cargo run -- mailbox send \
  --program-id <MAILBOX_PROGRAM_ID> \
  --destination <DESTINATION_DOMAIN> \
  --recipient <RECIPIENT_ADDRESS> \
  --message "Your message here"
```

#### Check Message Delivery
```bash
cargo run -- mailbox delivered \
  --program-id <MAILBOX_PROGRAM_ID> \
  --message-id <MESSAGE_ID>
```

#### Transfer Ownership
```bash
cargo run -- mailbox transfer-ownership \
  --program-id <MAILBOX_PROGRAM_ID> \
  <NEW_OWNER_PUBKEY>
```

### 3. Token - Warp Route Token Bridging

Warp Routes enable token bridging across chains with support for native, synthetic, and collateral tokens.

#### Query Token Configuration
```bash
cargo run -- token query \
  --program-id <TOKEN_PROGRAM_ID> \
  <TOKEN_TYPE>  # native, native-memo, synthetic, synthetic-memo, collateral, collateral-memo
```

#### Transfer Tokens to Remote Chain
```bash
cargo run -- token transfer-remote \
  --program-id <TOKEN_PROGRAM_ID> \
  <SENDER_KEYPAIR_PATH> \
  <AMOUNT> \
  <DESTINATION_DOMAIN> \
  <RECIPIENT_ADDRESS> \
  <TOKEN_TYPE>
```

#### Transfer with Memo (Dymension Extension)
```bash
cargo run -- token transfer-remote-memo \
  --program-id <TOKEN_PROGRAM_ID> \
  <SENDER_KEYPAIR_PATH> \
  <AMOUNT> \
  <DESTINATION_DOMAIN> \
  <RECIPIENT_ADDRESS> \
  <TOKEN_TYPE> \
  <MEMO_TEXT>
```

#### Enroll Remote Router
```bash
cargo run -- token enroll-remote-router \
  --program-id <TOKEN_PROGRAM_ID> \
  <DOMAIN> \
  <ROUTER_ADDRESS>
```

#### Set Destination Gas
```bash
cargo run -- token set-destination-gas \
  --program-id <TOKEN_PROGRAM_ID> \
  <DOMAIN> \
  <GAS_AMOUNT>
```

### 4. IGP - Interchain Gas Payments

The IGP (Interchain Gas Paymaster) handles gas payments for cross-chain messages.

#### Deploy IGP Program
```bash
cargo run -- igp deploy-program \
  --environment <ENV> \
  --environments-dir <PATH> \
  --chain <CHAIN_NAME> \
  --built-so-dir <PATH>
```

#### Initialize IGP Account
```bash
cargo run -- igp init-igp-account \
  --program-id <IGP_PROGRAM_ID> \
  --environment <ENV> \
  --environments-dir <PATH> \
  --chain <CHAIN_NAME> \
  --context <CONTEXT_NAME>  # Optional, defaults to "default"
  --account-salt <SALT>     # Optional for deterministic addresses
```

#### Query IGP State
```bash
cargo run -- igp query \
  --program-id <IGP_PROGRAM_ID> \
  --igp-account <IGP_ACCOUNT> \
  --gas-payment-account <PAYMENT_ACCOUNT>  # Optional
```

#### Pay for Gas
```bash
cargo run -- igp pay-for-gas \
  --program-id <IGP_PROGRAM_ID> \
  --message-id <MESSAGE_ID> \
  --destination-domain <DOMAIN> \
  --gas <GAS_AMOUNT>
```

#### Configure Gas Oracle
```bash
cargo run -- igp gas-oracle-config \
  --environment <ENV> \
  --environments-dir <PATH> \
  --chain-name <CHAIN> \
  --remote-domain <DOMAIN> \
  set \
  --token-exchange-rate <RATE> \
  --gas-price <PRICE> \
  --token-decimals <DECIMALS>
```

### 5. Warp Route - Deploy Token Bridges

Deploy complete token bridging infrastructure.

```bash
cargo run -- warp-route deploy \
  --environment <ENV> \
  --environments-dir <PATH> \
  --warp-route-name <NAME> \
  --token-config-file <PATH> \
  --registry <PATH> \
  --built-so-dir <PATH> \
  --ata-payer-funding-amount <LAMPORTS>  # Optional
```

#### Token Configuration File Format
```json
{
  "chain1": {
    "type": "native",
    "decimals": 9
  },
  "chain2": {
    "type": "synthetic",
    "decimals": 9,
    "name": "Wrapped Token",
    "symbol": "wTOKEN"
  },
  "chain3": {
    "type": "collateral",
    "token": "MINT_ADDRESS",
    "decimals": 6
  }
}
```

### 6. Multisig ISM - Configure Message Validation

Deploy and configure multisig ISM for message validation.

#### Deploy Multisig ISM
```bash
cargo run -- multisig-ism-message-id deploy \
  --environment <ENV> \
  --environments-dir <PATH> \
  --chain <CHAIN> \
  --context <CONTEXT> \
  --registry <PATH> \
  --built-so-dir <PATH>
```

#### Set Validators and Threshold
```bash
cargo run -- multisig-ism-message-id set-validators-and-threshold \
  --program-id <ISM_PROGRAM_ID> \
  --domain <DOMAIN> \
  --validators <VALIDATOR1,VALIDATOR2,VALIDATOR3> \
  --threshold <THRESHOLD>
```

#### Query Configuration
```bash
cargo run -- multisig-ism-message-id query \
  --program-id <ISM_PROGRAM_ID> \
  --domains <DOMAIN1,DOMAIN2>  # Optional
```

### 7. Validator Announce - Validator Registration

#### Initialize Validator Announce
```bash
cargo run -- validator-announce init \
  --program-id <VALIDATOR_ANNOUNCE_PROGRAM_ID> \
  --mailbox-id <MAILBOX_PROGRAM_ID> \
  --local-domain <DOMAIN>
```

#### Announce Validator
```bash
cargo run -- validator-announce announce \
  --program-id <VALIDATOR_ANNOUNCE_PROGRAM_ID> \
  --validator <VALIDATOR_ADDRESS> \
  --storage-location <LOCATION_URL> \
  --signature <SIGNATURE>
```

#### Query Validator
```bash
cargo run -- validator-announce query \
  --program-id <VALIDATOR_ANNOUNCE_PROGRAM_ID> \
  <VALIDATOR_ADDRESS>
```

### 8. Test ISM - Testing Infrastructure

Deploy a test ISM that can be configured to accept or reject all messages.

**WARNING: FOR TESTING ONLY - Never deploy to production!**

#### Deploy Test ISM
```bash
cargo run -- test-ism deploy \
  --environment <ENV> \
  --environments-dir <PATH> \
  --chain <CHAIN> \
  --context <CONTEXT> \
  --built-so-dir <PATH>
```

#### Initialize Test ISM
```bash
cargo run -- test-ism init --program-id <TEST_ISM_PROGRAM_ID>
```

#### Set Accept/Reject Mode
```bash
cargo run -- test-ism set-accept \
  --program-id <TEST_ISM_PROGRAM_ID> \
  --accept <true|false>
```

### 9. Hello World - Example Application

Deploy and interact with the Hello World example application.

#### Deploy Hello World
```bash
cargo run -- hello-world deploy \
  --environment <ENV> \
  --environments-dir <PATH> \
  --config-file <PATH> \
  --registry <PATH> \
  --context <CONTEXT> \
  --built-so-dir <PATH>
```

#### Query Hello World State
```bash
cargo run -- hello-world query --program-id <HELLO_WORLD_PROGRAM_ID>
```

### 10. Squads - Multisig Verification

Verify Squads multisig transactions for chain governance.

```bash
cargo run -- squads verify \
  --environment <ENV> \
  --environments-dir <PATH> \
  --registry <PATH> \
  --tx-pubkeys <TX1,TX2,TX3> \
  --chain <CHAIN>
```

## Environment Structure

The CLI expects a specific directory structure for environments:

```
environments/
├── <environment>/
│   ├── <chain>/
│   │   ├── core/
│   │   │   ├── program-ids.json
│   │   │   └── keys/
│   │   ├── igp/
│   │   │   └── <context>/
│   │   │       └── igp-accounts.json
│   │   └── multisig-ism-message-id/
│   │       └── <context>/
│   │           ├── program-ids.json
│   │           └── multisig-config.json
│   ├── warp-routes/
│   │   └── <route-name>/
│   │       ├── program-ids.json
│   │       └── token-config.json
│   └── gas-oracle-configs.json
```

## Common Workflows

### 1. Deploy Complete Hyperlane Infrastructure

```bash
# 1. Deploy core programs
cargo run -- core deploy \
  --environment testnet \
  --environments-dir ./environments \
  --chain solanatestnet \
  --local-domain 13375 \
  --remote-domains 11155111,421614 \
  --built-so-dir ./target/deploy

# 2. Initialize IGP
cargo run -- igp init-igp-account \
  --program-id <IGP_PROGRAM_ID> \
  --environment testnet \
  --environments-dir ./environments \
  --chain solanatestnet

# 3. Configure gas oracle for remote chains
cargo run -- igp gas-oracle-config \
  --environment testnet \
  --environments-dir ./environments \
  --chain-name solanatestnet \
  --remote-domain 11155111 \
  set \
  --token-exchange-rate 1000000 \
  --gas-price 20000000000 \
  --token-decimals 18

# 4. Deploy warp route
cargo run -- warp-route deploy \
  --environment testnet \
  --environments-dir ./environments \
  --warp-route-name my-token-bridge \
  --token-config-file ./token-config.json \
  --registry ./registry \
  --built-so-dir ./target/deploy
```

### 2. Bridge Tokens Between Chains

```bash
# 1. Check token configuration
cargo run -- token query \
  --program-id <TOKEN_PROGRAM_ID> \
  native

# 2. Transfer tokens to remote chain
cargo run -- token transfer-remote \
  --program-id <TOKEN_PROGRAM_ID> \
  ./my-wallet.json \
  1000000000 \
  11155111 \
  0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0 \
  native
```

### 3. Send Cross-Chain Message

```bash
# 1. Send message
cargo run -- mailbox send \
  --program-id <MAILBOX_PROGRAM_ID> \
  --destination 11155111 \
  --recipient <RECIPIENT_ADDRESS> \
  --message "Hello from Solana!"

# 2. Check delivery status
cargo run -- mailbox delivered \
  --program-id <MAILBOX_PROGRAM_ID> \
  --message-id <MESSAGE_ID>
```

## Token Types Explained

- **Native**: Bridges SOL (or native chain token) directly
- **Native-Memo**: Native token bridging with memo support
- **Synthetic**: Creates wrapped tokens on destination chain
- **Synthetic-Memo**: Synthetic tokens with memo support
- **Collateral**: Uses existing SPL tokens as collateral
- **Collateral-Memo**: Collateral tokens with memo support

## Important Notes

1. **Program IDs**: Most commands use default program IDs from mainnet/testnet deployments. Override with `--program-id` when needed.

2. **Keypair Management**: The CLI supports both keypair files and public keys. For signing operations, a keypair file is required.

3. **Compute Budget**: The default compute budget (1.4M units) should be sufficient for most operations. Reduce if needed to save on fees.

4. **Environments**: The `--environment` flag helps organize deployments (e.g., testnet, mainnet, local-e2e).

5. **Registry**: The registry path should point to a directory containing chain metadata and configurations.

6. **Memo Support**: Memo functionality is a Dymension-specific extension for adding arbitrary data to token transfers.

## Troubleshooting

### Common Issues

1. **"Program not found"**: Ensure the program is deployed and you're using the correct program ID
2. **"Insufficient funds"**: Fund your wallet with SOL for transaction fees
3. **"Account does not exist"**: Initialize the required accounts first (mailbox, IGP, etc.)
4. **"Invalid domain"**: Check that domain IDs match your chain configuration

### Debug Commands

```bash
# Check account balance
solana balance <ADDRESS>

# Verify program deployment
solana program show <PROGRAM_ID>

# Check transaction status
solana confirm <TX_SIGNATURE>
```

## Security Considerations

1. **Never deploy Test ISM to production** - It has no access control
2. **Protect keypair files** - Store securely and never commit to version control
3. **Verify multisig configurations** - Ensure proper threshold and validator settings
4. **Audit warp route configurations** - Check decimals, token types, and router addresses

## Advanced Configuration

### Custom RPC Endpoints
```bash
# Use custom RPC
cargo run -- -u https://api.mainnet-beta.solana.com <COMMAND>

# Use Solana CLI config
cargo run -- -C ~/.config/solana/cli/config.yml <COMMAND>
```

### Transaction Approval
```bash
# Require manual approval for each transaction
cargo run -- --require-tx-approval <COMMAND>
```

### Deterministic Addresses
Many commands support `--account-salt` for creating deterministic PDAs, useful for cross-chain address prediction.

## Support & Resources

- **Hyperlane Documentation**: https://docs.hyperlane.xyz
- **Solana Documentation**: https://docs.solana.com
- **Repository**: https://github.com/hyperlane-xyz/hyperlane-monorepo