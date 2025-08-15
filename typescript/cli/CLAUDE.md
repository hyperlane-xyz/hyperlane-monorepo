# Hyperlane CLI User Guide

## Table of Contents

1. [Overview](#overview)
2. [System Architecture & Domain Model](#system-architecture--domain-model)
3. [Installation & Setup](#installation--setup)
4. [Global Options & Environment Variables](#global-options--environment-variables)
5. [Core Commands](#core-commands)
6. [Warp Route Management](#warp-route-management)
7. [Message Operations](#message-operations)
8. [Validator Management](#validator-management)
9. [Registry Management](#registry-management)
10. [Advanced Operations](#advanced-operations)
11. [Configuration Files](#configuration-files)
12. [Common Workflows](#common-workflows)
13. [Troubleshooting](#troubleshooting)

## Overview

The Hyperlane CLI is a comprehensive command-line tool for managing all aspects of the Hyperlane interchain messaging protocol. It provides functionality for:

- Deploying and managing core Hyperlane contracts
- Creating and operating Warp Routes for token bridging
- Sending and tracking interchain messages
- Running validators and relayers
- Managing chain registries and configurations
- Testing with local forks

### Quick Start

```bash
# Install Hyperlane CLI
npm install -g @hyperlane-xyz/cli

# Check version
hyperlane --version

# Get help
hyperlane --help
hyperlane <command> --help
```

## System Architecture & Domain Model

### Core Concepts

#### 1. The Hyperlane Protocol

Hyperlane is a permissionless interchain messaging protocol that enables secure communication between blockchain networks. At its core, it implements a hub-and-spoke model where:

- **Messages** are the fundamental unit of cross-chain communication
- **Mailboxes** are the entry/exit points on each chain
- **Validators** secure the protocol by attesting to message validity
- **Relayers** transport messages between chains
- **ISMs (Interchain Security Modules)** define custom security models
- **Hooks** enable custom processing logic for messages

#### 2. Domain Model

##### Mailbox

The **Mailbox** is the core contract on each chain that:

- **Dispatches** outbound messages from the origin chain
- **Processes** inbound messages on the destination chain
- Maintains a **message nonce** for ordering and replay protection
- Calculates **message IDs** deterministically from message contents
- Enforces the **default ISM** unless overridden by recipients

##### Messages

Each **Message** contains:

- **Version**: Protocol version for forward compatibility
- **Nonce**: Monotonically increasing counter per sender
- **Origin Domain**: Unique identifier of the source chain
- **Sender**: Address that initiated the message
- **Destination Domain**: Target chain identifier
- **Recipient**: Target contract address
- **Body**: Arbitrary bytes payload

The message lifecycle:

1. **Dispatch**: Application calls `mailbox.dispatch()` on origin chain
2. **Indexing**: Validators observe and sign the message
3. **Transport**: Relayers fetch signatures and create proof
4. **Delivery**: Relayer calls `mailbox.process()` on destination chain
5. **Verification**: ISM validates the message authenticity
6. **Execution**: Recipient contract handles the message

##### Interchain Security Modules (ISMs)

ISMs define **how messages are verified** on the destination chain:

- **Multisig ISM**: Requires M-of-N validator signatures

  - Validators run off-chain infrastructure monitoring origin chains
  - Each validator signs a checkpoint (merkle root) of dispatched messages
  - Destination chain verifies threshold signatures before processing

- **Aggregation ISM**: Combines multiple ISMs with AND/OR logic

  - Useful for defense-in-depth security models
  - Can require multiple independent validator sets

- **Routing ISM**: Different ISMs for different origin chains

  - Allows per-chain security customization
  - Critical for heterogeneous network topologies

- **Optimistic ISM**: Assumes messages are valid with a challenge period

  - Lower latency but requires fraud proof mechanism
  - Watchers can dispute invalid messages

- **CCIP Read ISM**: Leverages external data availability
  - Fetches proofs from off-chain storage
  - Reduces on-chain storage costs

##### Hooks

Hooks are **message lifecycle interceptors** that:

- **Pre-dispatch hooks**: Execute before message dispatch

  - Fee collection (protocol fees, dynamic gas payment)
  - Rate limiting or access control
  - Message validation or transformation

- **Post-dispatch hooks**: Execute after message dispatch
  - Emit events for indexers
  - Update auxiliary state
  - Trigger dependent operations

Common hook types:

- **Protocol Fee Hook**: Collects fees for protocol sustainability
- **Interchain Gas Payment (IGP)**: Pays relayers for destination gas
- **Merkle Tree Hook**: Aggregates messages into merkle trees
- **Pausable Hook**: Emergency pause functionality
- **Routing Hook**: Different hooks for different destinations

#### 3. Warp Routes

Warp Routes are **application-specific message passing contracts** for token bridging:

##### Token Types

- **Native**: Wraps the chain's native currency (ETH, MATIC, etc.)
  - Locks native tokens in escrow on dispatch
  - Mints synthetic representation on destination
- **Collateral**: Bridges existing ERC20/721 tokens
  - Locks tokens in vault contract
  - Maintains 1:1 backing with synthetics
- **Synthetic**: Minted representations on non-origin chains
  - Burned on transfer back to origin
  - Total supply tracks locked collateral

##### Bridging Mechanics

1. **Lock/Burn on Origin**:

   - Native/Collateral: Tokens locked in warp route contract
   - Synthetic: Tokens burned to reduce supply

2. **Message Dispatch**:

   - Warp route calls mailbox with transfer details
   - Message includes recipient, amount, and metadata

3. **Mint/Release on Destination**:
   - Message delivered to destination warp route
   - Native/Collateral origin: Mint synthetic tokens
   - Synthetic origin: Release locked collateral

##### Security Considerations

- **Rate Limiting**: Prevents large-scale exploits
- **Liquidity Pools**: Managed reserves for instant finality
- **Rebalancing**: Automated liquidity management across chains

#### 4. Validators

Validators are **the security backbone** of Hyperlane:

##### Responsibilities

- **Observe**: Monitor origin chain mailboxes for new messages
- **Attest**: Sign merkle roots (checkpoints) of message batches
- **Store**: Make signatures available (S3, IPFS, etc.)
- **Maintain**: Ensure high availability and security

##### Validator Sets

- **Default Set**: Protocol-defined validators for standard security
- **Custom Sets**: Application-specific validators for enhanced security
- **Sovereign Sets**: Chain-specific validators for local consensus

##### Economic Security

- **Staking**: Validators stake tokens as collateral (in some configurations)
- **Slashing**: Misbehavior results in stake penalties
- **Rewards**: Fees distributed to honest validators

#### 5. Relayers

Relayers are **permissionless message transporters**:

##### Core Functions

- **Monitor**: Watch for new messages across chains
- **Aggregate**: Collect validator signatures for messages
- **Deliver**: Submit messages to destination mailboxes
- **Optimize**: Batch operations for gas efficiency

##### Relayer Types

- **Permissionless Relayers**: Anyone can run, compete on speed/price
- **Subsidized Relayers**: Application-sponsored for specific routes
- **Dedicated Relayers**: Exclusive relayers for critical applications

##### Incentive Model

- **Gas Refunds**: IGP (Interchain Gas Payment) covers destination gas
- **Priority Fees**: Applications pay extra for faster delivery
- **MEV Opportunities**: Arbitrage from message ordering

#### 6. Registry

The Registry is **the source of truth** for network configuration:

##### Contents

- **Chain Metadata**: RPC endpoints, chain IDs, block explorers
- **Contract Addresses**: Mailboxes, ISMs, IGP contracts per chain
- **Validator Information**: Addresses, locations, public keys
- **Gas Oracles**: Price feeds for accurate gas estimation

##### Registry Types

- **Official Registry**: Hyperlane-maintained GitHub repository
- **Local Registry**: Custom configurations for private networks
- **Override Registry**: Development and testing configurations

### Message Flow Deep Dive

#### Standard Message Flow

```
Origin Chain                    Off-Chain                  Destination Chain
     │                              │                              │
     ├─[1. dispatch()]              │                              │
     │   └─> Mailbox                │                              │
     │       ├─> Increment nonce    │                              │
     │       ├─> Calculate ID       │                              │
     │       ├─> Call hooks         │                              │
     │       └─> Emit event         │                              │
     │                              │                              │
     │                    [2. Validators observe]                  │
     │                         ├─> Sign checkpoint                 │
     │                         └─> Store signatures                │
     │                              │                              │
     │                    [3. Relayer aggregates]                  │
     │                         ├─> Fetch signatures                │
     │                         └─> Build proof                     │
     │                              │                              │
     │                              │                 [4. process()]
     │                              │                      └─> Mailbox
     │                              │                          ├─> Verify ISM
     │                              │                          ├─> Check replay
     │                              │                          └─> Call recipient
```

#### Warp Route Token Transfer

```
User on Chain A                                          User on Chain B
      │                                                         │
      ├─[transfer(amount, chainB, recipient)]                  │
      │                                                         │
  Warp Route A                                            Warp Route B
      ├─> Lock/burn tokens                                     │
      ├─> Calculate transfer ID                                │
      ├─> mailbox.dispatch(message)                           │
      │                                                         │
      │                    [Validators + Relayer]              │
      │                                                         │
      │                                                    [Receives message]
      │                                                         ├─> Verify sender
      │                                                         ├─> Mint/release tokens
      │                                                         └─> Credit recipient
```

## Installation & Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- Git (for registry access)

### Installation Methods

#### Via npm (Recommended)

```bash
npm install -g @hyperlane-xyz/cli
```

#### Via yarn

```bash
yarn global add @hyperlane-xyz/cli
```

#### From Source

```bash
git clone https://github.com/hyperlane-xyz/hyperlane-monorepo.git
cd hyperlane-monorepo/typescript/cli
yarn install
yarn build
npm link
```

### Initial Setup

1. **Set up your private key**:

```bash
# Option 1: Environment variable
export HYP_KEY="your-private-key-or-seed-phrase"

# Option 2: Command line flag
hyperlane <command> --key "your-private-key"

# Option 3: Protocol-specific keys
export HYP_KEY_ETHEREUM="ethereum-private-key"
export HYP_KEY_COSMOS="cosmos-seed-phrase"
```

2. **Configure registry access** (optional):

```bash
# For private registries
export GH_AUTH_TOKEN="your-github-token"

# Use local registry
hyperlane <command> --registry ~/.hyperlane
```

## Global Options & Environment Variables

### Global Command Options

These options are available for all commands:

| Option           | Alias | Description                | Values                                           |
| ---------------- | ----- | -------------------------- | ------------------------------------------------ |
| `--log`          | `-l`  | Log output format          | `pretty`, `json`                                 |
| `--verbosity`    | `-v`  | Log verbosity level        | `trace`, `debug`, `info`, `warn`, `error`, `off` |
| `--registry`     | `-r`  | Registry paths (array)     | GitHub URLs or local paths                       |
| `--key`          | `-k`  | Private key or seed phrase | Hex string or mnemonic                           |
| `--yes`          | `-y`  | Skip confirmation prompts  | Boolean                                          |
| `--strategy`     | `-s`  | Transaction strategy file  | File path                                        |
| `--authToken`    |       | GitHub auth token          | String                                           |
| `--disableProxy` |       | Disable GitHub proxy       | Boolean                                          |

### Environment Variables

| Variable                | Description           | Example                   |
| ----------------------- | --------------------- | ------------------------- |
| `HYP_KEY`               | Default private key   | `0x123...` or seed phrase |
| `HYP_KEY_{PROTOCOL}`    | Protocol-specific key | `HYP_KEY_ETHEREUM=0x...`  |
| `GH_AUTH_TOKEN`         | GitHub authentication | `ghp_...`                 |
| `AWS_ACCESS_KEY_ID`     | AWS access key        | For validator S3/KMS      |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key        | For validator S3/KMS      |
| `AWS_REGION`            | AWS region            | `us-east-1`               |
| `ANVIL_IP_ADDR`         | Anvil node IP         | `127.0.0.1`               |
| `ANVIL_PORT`            | Anvil node port       | `8545`                    |
| `COINGECKO_API_KEY`     | CoinGecko API key     | For price data            |
| `LOG_FORMAT`            | Default log format    | `pretty` or `json`        |
| `LOG_LEVEL`             | Default log level     | `info`, `debug`, etc.     |

## Core Commands

### hyperlane core

**Semantic Purpose**: The `hyperlane core` commands manage the fundamental infrastructure contracts that enable interchain messaging on each blockchain. These commands handle the deployment, configuration, and management of the Mailbox contract (the message router), ISMs (security policies), and Hooks (message processing logic).

**What it does in the system**:

- **Establishes the messaging endpoint** on each chain by deploying a Mailbox contract
- **Defines security models** through ISM configuration - determining how many validators must attest to a message
- **Sets up fee collection and processing logic** through Hook configuration
- **Creates the trust foundation** that applications will rely on for secure message passing

#### Initialize Core Configuration

**What this does**: Creates a configuration file that defines how the Hyperlane protocol should behave on a specific chain. This includes:

- **Owner privileges**: Who can modify protocol parameters
- **Default security**: The ISM that will verify messages by default
- **Fee structure**: How protocol fees are collected and distributed
- **Processing hooks**: Custom logic for message handling

```bash
# Basic configuration
hyperlane core init

# Advanced configuration with custom ISMs and hooks
hyperlane core init --advanced --config ./my-core-config.yaml
```

#### Deploy Core Contracts

**What this does**: Deploys the actual smart contracts that form the Hyperlane infrastructure on a blockchain:

1. **Deploys Mailbox**: The main contract that applications call to send/receive messages
2. **Deploys ISM contracts**: The verification logic for incoming messages
3. **Deploys Hook contracts**: Fee collection and processing logic
4. **Establishes domain ID**: Assigns a unique identifier to this chain in the Hyperlane network
5. **Initializes state**: Sets owner, connects components, and prepares for message processing

```bash
# Deploy to a single chain
hyperlane core deploy --chain sepolia --config ./core-config.yaml

# Dry run deployment (simulation)
hyperlane core deploy --dry-run sepolia --from-address 0x123...

# Deploy to multiple chains interactively
hyperlane core deploy
```

#### Read Onchain Configuration

**What this does**: Queries the blockchain to extract the current configuration of deployed Hyperlane contracts:

- **Fetches Mailbox state**: Owner, default ISM address, default hook address
- **Resolves ISM configuration**: Type (multisig, aggregation, etc.), validator addresses, thresholds
- **Extracts Hook settings**: Fee amounts, beneficiaries, rate limits
- **Builds complete picture**: How messages are currently being processed on this chain

```bash
# Read default mailbox config
hyperlane core read --chain ethereum

# Read specific mailbox
hyperlane core read --chain ethereum --mailbox 0x123... --config ./output.yaml
```

#### Check Configuration

**What this does**: Performs a differential analysis between deployed contracts and expected configuration:

- **Validates security settings**: Ensures ISM thresholds and validators match expectations
- **Verifies ownership**: Confirms correct admin addresses
- **Checks fee structure**: Validates protocol fees and beneficiaries
- **Identifies discrepancies**: Reports any mismatch that could affect security or operations
- **Pre-deployment validation**: Can verify a config will result in expected deployment

```bash
# Compare onchain vs expected config
hyperlane core check --chain ethereum --config ./expected-config.yaml
```

#### Apply Configuration Updates

**What this does**: Modifies the configuration of already-deployed Hyperlane contracts:

- **Updates ISM settings**: Changes validator sets, adjusts signature thresholds
- **Modifies hooks**: Updates fee amounts, changes beneficiaries
- **Transfers ownership**: Hands control to new administrators
- **Migrates security models**: Switches between different ISM types
- **Atomic updates**: Ensures changes are applied consistently

**Important**: Only the contract owner can apply updates. This command will:

1. Read current onchain state
2. Calculate required transactions
3. Submit changes through the appropriate admin functions
4. Verify successful application

```bash
# Update onchain configuration
hyperlane core apply --chain ethereum --config ./new-config.yaml
```

### Example Core Config

```yaml
owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
defaultIsm:
  type: 'multisigIsm'
  threshold: 2
  validators:
    - '0xa0ee7a142d267c1f36714e4a8f75612f20a79720'
    - '0xbcd4042de499d14e55001ccbb24a551f3b954096'
    - '0x71be63f3384f5fb98995898a86b02fb2426c5788'
defaultHook:
  type: protocolFee
  maxProtocolFee: '1000000000000000000'
  protocolFee: '200000000000000'
  beneficiary: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
requiredHook:
  type: pausableHook
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  paused: false
```

## Warp Route Management

### hyperlane warp

**Semantic Purpose**: Warp Routes are Hyperlane's token bridge implementation. These commands manage the entire lifecycle of cross-chain token transfers, from deploying bridge contracts to executing transfers and maintaining liquidity balance.

**What it does in the system**:

- **Creates token bridges**: Deploys contracts that can lock, mint, burn, and transfer tokens across chains
- **Manages token representations**: Handles native tokens, wrapped tokens, and synthetic tokens
- **Maintains cross-chain accounting**: Ensures total supply consistency across all chains
- **Enables liquidity management**: Provides rebalancing capabilities for optimal capital efficiency

#### Initialize Warp Route Configuration

**What this does**: Generates a configuration file that defines how tokens should be bridged between chains:

- **Token type specification**: Defines whether each chain handles native, collateral, or synthetic tokens
- **Security customization**: Optional custom ISMs for enhanced bridge security
- **Metadata definition**: Token names, symbols, decimals for synthetic representations
- **Route topology**: Which chains are connected and how tokens flow between them

```bash
# Basic warp route
hyperlane warp init --out ./warp-config.yaml

# Advanced with custom ISMs
hyperlane warp init --advanced --out ./advanced-warp.yaml
```

#### Deploy Warp Route

**What this does**: Deploys the smart contracts that implement the token bridge:

1. **Deploys Router contracts**: One on each chain to handle token operations
2. **Configures token handling**:
   - **Native chains**: Deploy wrapper contract for native currency
   - **Collateral chains**: Deploy vault contract to hold locked tokens
   - **Synthetic chains**: Deploy mintable token contract
3. **Establishes connections**: Registers remote routers so chains know their counterparts
4. **Sets up security**: Configures ISMs for bridge-specific verification
5. **Initializes accounting**: Sets initial supplies and exchange rates

**System impact**:

- Creates new liquidity pathways between chains
- Establishes trust relationships for token transfers
- Enables permissionless token bridging

```bash
# Deploy using config file
hyperlane warp deploy --config ./warp-config.yaml

# Dry run deployment
hyperlane warp deploy --config ./warp-config.yaml --dry-run sepolia

# Deploy with specific warp route ID
hyperlane warp deploy --warpRouteId my-token-bridge
```

#### Send Token Transfer

**What this does**: Executes a cross-chain token transfer through the following process:

1. **Origin chain operations**:
   - **Native/Collateral**: Locks tokens in the router contract
   - **Synthetic**: Burns tokens to reduce supply
   - Calculates transfer amount after fees
   - Dispatches Hyperlane message with transfer details
2. **Message propagation**:
   - Validators observe and sign the transfer message
   - Relayers aggregate signatures and deliver to destination
3. **Destination chain operations**:
   - Verifies message authenticity via ISM
   - **Native/Collateral origin**: Mints synthetic tokens to recipient
   - **Synthetic origin**: Releases locked collateral to recipient
   - Emits transfer completion events

**Economic flow**:

- User pays: Token amount + protocol fees + relayer gas payment
- Validators earn: Attestation rewards (if configured)
- Relayers earn: Gas reimbursement + priority fees
- Protocol earns: Base protocol fee

```bash
# Basic transfer
hyperlane warp send --symbol USDC --origin ethereum --destination polygon --amount 100

# Transfer with custom recipient
hyperlane warp send --symbol USDC \
  --origin ethereum \
  --destination polygon \
  --amount 100 \
  --recipient 0x456...

# Quick transfer (don't wait for delivery)
hyperlane warp send --symbol USDC \
  --origin ethereum \
  --destination polygon \
  --amount 100 \
  --quick

# Round-trip transfer to all configured chains
hyperlane warp send --symbol USDC --round-trip
```

#### Read Warp Route Configuration

**What this does**: Queries deployed warp route contracts to understand the current bridge configuration:

- **Discovers route topology**: Which chains are connected and their token types
- **Fetches token metadata**: Names, symbols, decimals, total supplies
- **Retrieves security config**: ISMs and thresholds for each route
- **Extracts operational parameters**: Rate limits, fees, owner addresses
- **Builds complete picture**: How tokens can move through the bridge network

**Use cases**:

- Auditing deployed bridges
- Preparing configuration updates
- Debugging transfer issues
- Understanding liquidity distribution

```bash
# Read by symbol
hyperlane warp read --symbol USDC

# Read specific chain
hyperlane warp read --symbol USDC --chain ethereum

# Read by address
hyperlane warp read --address 0x123... --chain ethereum
```

#### Check Warp Route

**What this does**: Validates that deployed warp route contracts match expected configuration:

- **Verifies token consistency**: Ensures names, symbols, decimals match across chains
- **Validates connections**: Confirms all routers know their remote counterparts
- **Checks security settings**: Verifies ISMs and ownership are correctly configured
- **Audits supply integrity**: Ensures total minted synthetics ≤ locked collateral
- **Identifies misconfigurations**: Reports issues that could affect bridge operation

```bash
# Verify configuration matches onchain
hyperlane warp check --symbol USDC
```

#### Apply Updates

**What this does**: Modifies existing warp route configuration on-chain:

- **Updates router connections**: Adds/removes chains from the bridge network
- **Modifies security parameters**: Changes ISMs or validation requirements
- **Adjusts operational settings**: Updates rate limits, fees, or pausing status
- **Transfers ownership**: Hands control to new administrators
- **Manages router enrollment**: Authorizes new routers or revokes existing ones

**Safety mechanisms**:

- Only owner can apply updates
- Validates changes won't break invariants
- Can use timelocks for critical changes
- Supports gradual rollout strategies

```bash
# Update warp route configuration
hyperlane warp apply --symbol USDC --strategy ./strategy.yaml
```

#### Run Rebalancer

**What this does**: Manages liquidity distribution across chains in a warp route:

- **Monitors balances**: Tracks collateral and synthetic token amounts on each chain
- **Calculates optimal distribution**: Determines where liquidity is needed
- **Executes rebalancing**:
  1. Identifies source chain with excess liquidity
  2. Initiates transfer to destination needing liquidity
  3. Uses the warp route itself for rebalancing
- **Maintains thresholds**: Keeps liquidity within configured min/max bounds
- **Optimizes capital efficiency**: Ensures liquidity is where it's most useful

**Rebalancing strategies**:

- **Threshold-based**: Rebalance when limits exceeded
- **Predictive**: Anticipate demand based on historical patterns
- **Manual**: Operator-triggered rebalancing
- **Emergency**: Rapid rebalancing during high demand

```bash
# Automatic rebalancing
hyperlane warp rebalancer --config ./rebalancer-config.yaml

# Monitor-only mode
hyperlane warp rebalancer --config ./rebalancer-config.yaml --monitorOnly

# Manual rebalance
hyperlane warp rebalancer --config ./rebalancer-config.yaml \
  --manual \
  --origin ethereum \
  --destination polygon \
  --amount 1000
```

#### Fork for Testing

**What this does**: Creates local blockchain forks with deployed warp routes for testing:

- **Forks mainnet state**: Creates local copy of blockchain at current block
- **Preserves warp routes**: Includes all deployed contracts and balances
- **Enables testing**: Allows risk-free testing of transfers and updates
- **Simulates production**: Tests against real liquidity and configuration
- **Supports debugging**: Inspect transaction traces and state changes

**Testing capabilities**:

- Test large transfers without real funds
- Simulate edge cases and error conditions
- Validate upgrade procedures
- Test integration with other protocols

```bash
# Fork chains with warp routes
hyperlane warp fork --symbol USDC --port 8545

# Fork with custom config
hyperlane warp fork --fork-config ./fork-config.yaml
```

### Example Warp Route Config

```yaml
# Native token on source chain
ethereum:
  type: native
  mailbox: '0x123...'
  owner: '0x456...'

# Synthetic token on destination
polygon:
  type: synthetic
  mailbox: '0x789...'
  owner: '0x456...'
  name: 'Wrapped ETH'
  symbol: 'WETH'
  decimals: 18
  totalSupply: 0

# Collateral token
arbitrum:
  type: collateral
  token: '0xabc...' # Existing token address
  mailbox: '0xdef...'
  owner: '0x456...'
```

## Message Operations

### hyperlane send

**Semantic Purpose**: The send command initiates cross-chain messages to test connectivity, debug routing, or trigger remote contract execution. It demonstrates the fundamental Hyperlane primitive: dispatching a message on one chain that executes on another.

**What it does in the system**:

- **Constructs a message**: Builds a properly formatted Hyperlane message with headers and payload
- **Calls mailbox.dispatch()**: Submits the message to the origin chain's Mailbox contract
- **Pays fees**: Covers protocol fees and relayer gas costs through IGP (Interchain Gas Payment)
- **Triggers propagation**: Message enters the validator observation and relayer delivery pipeline
- **Enables testing**: Validates that the messaging infrastructure is operational

```bash
# Send basic message
hyperlane send message --origin ethereum --destination polygon

# Send custom message
hyperlane send message \
  --origin ethereum \
  --destination polygon \
  --body "Hello from Ethereum!"

# Send with relay
hyperlane send message \
  --origin ethereum \
  --destination polygon \
  --relay

# Quick send (don't wait)
hyperlane send message \
  --origin ethereum \
  --destination polygon \
  --quick
```

### hyperlane status

**Semantic Purpose**: Tracks a message through its complete lifecycle from dispatch to delivery, providing visibility into the cross-chain messaging process and helping diagnose delivery issues.

**What it does in the system**:

- **Queries origin chain**: Checks if message was successfully dispatched
- **Monitors validator attestations**: Tracks how many validators have signed the message
- **Checks relayer status**: Determines if message is queued for delivery
- **Queries destination chain**: Verifies if message was successfully processed
- **Diagnoses failures**: Identifies where in the pipeline a message may be stuck

**Message states**:

1. **Dispatched**: Message emitted from origin Mailbox
2. **Signed**: Validators have attested (checkpoint includes message)
3. **Relayed**: Relayer has submitted to destination
4. **Processed**: Destination Mailbox executed the message
5. **Failed**: Message delivery failed (could be reverted, insufficient gas, etc.)

```bash
# Check by message ID
hyperlane status --origin ethereum --id 0x123...

# Check by transaction hash
hyperlane status --origin ethereum --dispatchTx 0xabc...

# Check with relay
hyperlane status --origin ethereum --id 0x123... --relay

# Set custom timeout
hyperlane status --origin ethereum --id 0x123... --timeout 600
```

## Validator Management

### hyperlane validator

**Semantic Purpose**: Validators are the security backbone of Hyperlane, attesting to the validity of messages by observing origin chains and signing checkpoints. These commands manage validator infrastructure and configuration.

**What validators do in the system**:

- **Observe origin chains**: Monitor Mailbox contracts for dispatched messages
- **Build merkle trees**: Aggregate messages into checkpoints for efficiency
- **Sign attestations**: Cryptographically sign merkle roots to prove observation
- **Store signatures**: Make attestations available for relayers (typically in S3)
- **Provide security**: Form the trust foundation that destination chains rely on

**Security model**:

- **M-of-N threshold**: Destinations require M validators out of N to attest
- **Economic security**: Validators may stake tokens as collateral
- **Reputation-based**: Validators build trust through consistent operation
- **Heterogeneous sets**: Different chains can require different validator sets

#### Get Validator Address

```bash
# From S3 bucket
hyperlane validator address \
  --bucket my-validator-bucket \
  --region us-east-1

# From KMS key
hyperlane validator address \
  --key-id alias/hyperlane-validator \
  --region us-east-1

# With explicit AWS credentials
hyperlane validator address \
  --bucket my-validator-bucket \
  --access-key AKIA... \
  --secret-key secret... \
  --region us-east-1
```

#### Check Validator Setup

```bash
# Check specific validators
hyperlane validator check \
  --chain ethereum \
  --validators "0x123...,0x456...,0x789..."
```

### hyperlane avs

**Semantic Purpose**: AVS (Actively Validated Service) integration with EigenLayer enables Ethereum validators to provide security for Hyperlane by restaking their ETH. This creates shared security between Ethereum and Hyperlane.

**What it does in the system**:

- **Leverages Ethereum security**: Uses restaked ETH to secure Hyperlane messages
- **Enables operator participation**: Allows EigenLayer operators to validate Hyperlane
- **Provides economic security**: Slashing conditions ensure honest behavior
- **Reduces validation costs**: Shared infrastructure across multiple protocols

**AVS Architecture**:

1. **Operators**: Run Hyperlane validator software alongside Ethereum validation
2. **Restaking**: ETH staked in Ethereum also secures Hyperlane
3. **Slashing**: Misbehavior results in loss of staked ETH
4. **Rewards**: Operators earn fees for Hyperlane validation

#### Register Operator

```bash
hyperlane avs register \
  --chain holesky \
  --operatorKeyPath ./operator.ecdsa.key.json \
  --avsSigningKeyAddress 0x123...
```

#### Check AVS Status

```bash
# Check by operator key
hyperlane avs check \
  --chain holesky \
  --operatorKeyPath ./operator.ecdsa.key.json

# Check by address
hyperlane avs check \
  --chain holesky \
  --operatorAddress 0x456...
```

#### Deregister Operator

```bash
hyperlane avs deregister \
  --chain holesky \
  --operatorKeyPath ./operator.ecdsa.key.json
```

## Registry Management

### hyperlane registry

**Semantic Purpose**: The registry is the canonical source of truth for Hyperlane network configuration. It stores chain metadata, contract addresses, and network topology, enabling seamless multi-chain operations.

**What it does in the system**:

- **Maintains chain metadata**: RPC endpoints, chain IDs, native currencies
- **Stores contract addresses**: Mailboxes, ISMs, IGP contracts for each chain
- **Defines network topology**: Which chains are connected and how
- **Provides validator info**: Addresses and locations of validator services
- **Enables automation**: Tools can dynamically discover network configuration

**Registry architecture**:

- **GitHub-based**: Primary registry stored in version-controlled repository
- **Local overrides**: Custom configurations for private/test networks
- **Hierarchical**: Later registries override earlier ones
- **Cached**: Local caching for performance and offline access

#### List Chains

```bash
# List all chains
hyperlane registry list

# List mainnet chains
hyperlane registry list --type mainnet

# List testnet chains
hyperlane registry list --type testnet
```

#### Get Contract Addresses

```bash
# All contracts for a chain
hyperlane registry addresses --name ethereum

# Specific contract
hyperlane registry addresses --name ethereum --contract mailbox
```

#### Get RPC URLs

```bash
# Default RPC
hyperlane registry rpc --name ethereum

# Specific RPC by index
hyperlane registry rpc --name ethereum --index 1
```

#### Create Agent Config

```bash
# For specific chains
hyperlane registry agent-config \
  --chains "ethereum,polygon,arbitrum" \
  --out ./agent-config.json

# Interactive selection
hyperlane registry agent-config
```

#### Initialize New Chain

```bash
# Create minimal chain config
hyperlane registry init
```

## Advanced Operations

### hyperlane relayer

**Semantic Purpose**: Relayers are permissionless operators that deliver messages between chains. They observe origin chains for new messages, aggregate validator signatures, and submit messages to destination chains.

**What relayers do in the system**:

1. **Message Discovery**:

   - Monitor origin Mailbox contracts for Dispatch events
   - Filter messages based on destination, sender, or value
   - Queue messages for processing

2. **Signature Aggregation**:

   - Fetch validator attestations from storage (S3, IPFS)
   - Verify signature validity and threshold
   - Build merkle proofs for message inclusion

3. **Message Delivery**:

   - Estimate gas costs on destination chain
   - Submit process() transaction with message and proof
   - Handle retries for failed deliveries
   - Optimize batch deliveries for efficiency

4. **Economic Participation**:
   - Receive gas payments from IGP
   - Compete on speed and reliability
   - Earn priority fees for urgent messages

**Relayer types**:

- **Permissionless**: Anyone can run, open competition
- **Dedicated**: Application-specific relayers for guaranteed delivery
- **Subsidized**: Protocol or application pays for operation

```bash
# Relay between specific chains
hyperlane relayer --chains "ethereum,polygon,arbitrum"

# Relay for specific warp route
hyperlane relayer --symbol USDC

# With custom cache
hyperlane relayer \
  --chains "ethereum,polygon" \
  --cache ./my-relayer-cache.json
```

### hyperlane strategy

**Semantic Purpose**: Strategies define how transactions are signed and submitted across different chains and wallet types. They abstract away the complexity of multi-chain transaction management.

**What strategies do in the system**:

- **Define signing methods**: Hardware wallets, multisigs, or plain keys
- **Configure gas parameters**: Prices, limits, and priority fees per chain
- **Handle transaction routing**: Which signer to use for which chain
- **Enable automation**: Batching, retries, and nonce management
- **Support diverse setups**: From simple EOAs to complex DAO treasuries

**Strategy types**:

- **Key-based**: Direct private key signing (development/testing)
- **Ledger**: Hardware wallet signing for security
- **Gnosis Safe**: Multisig transaction proposals
- **Impersonated**: Simulated signing for testing
- **AWS KMS**: Cloud-based key management

#### Initialize Strategy

```bash
# Create default strategy
hyperlane strategy init

# Custom output path
hyperlane strategy init --out ./my-strategy.yaml
```

#### Read Strategy

```bash
# Read default strategy
hyperlane strategy read

# Read specific strategy
hyperlane strategy read --strategy ./my-strategy.yaml
```

### Example Strategy Config

```yaml
ethereum:
  type: 'ledger'
  derivationPath: "m/44'/60'/0'/0/0"

polygon:
  type: 'impersonatedAccount'
  userAddress: '0x123...'

arbitrum:
  type: 'gnosis'
  safeAddress: '0x456...'

avalanche:
  type: 'key'
  privateKey: '0x789...'
```

### hyperlane submit

**Semantic Purpose**: Executes batched transactions using predefined strategies, enabling complex multi-chain operations with proper signing, gas management, and execution tracking.

**What it does in the system**:

- **Parses transaction batch**: Reads transaction intents from input file
- **Applies strategy**: Uses appropriate signers and gas settings
- **Manages execution**:
  - Orders transactions by dependencies
  - Handles nonce management
  - Implements retry logic
  - Tracks success/failure
- **Generates receipts**: Records transaction hashes and outcomes
- **Enables automation**: Supports CI/CD and automated operations

**Use cases**:

- Multi-chain deployments
- Batch configuration updates
- Coordinated upgrades
- Emergency responses

```bash
# Submit with strategy
hyperlane submit \
  --transactions ./pending-txs.json \
  --strategy ./my-strategy.yaml \
  --receipts ./receipts.json
```

### hyperlane config validate

**Semantic Purpose**: Ensures configuration files are syntactically correct and semantically valid before deployment or updates, preventing costly mistakes and failed operations.

**What validation does**:

- **Schema validation**: Checks required fields and types
- **Semantic validation**: Ensures values make logical sense
- **Cross-reference validation**: Verifies references between sections
- **Compatibility checks**: Ensures config works with target chains
- **Security validation**: Warns about potentially dangerous settings

**Validation levels**:

1. **Syntax**: JSON/YAML parsing and structure
2. **Schema**: Required fields and type checking
3. **Semantics**: Logical consistency and value ranges
4. **Network**: Chain IDs and address formats
5. **Security**: Best practices and warnings

```bash
# Validate chain config
hyperlane config validate chain --path ./chain-config.yaml

# Validate ISM config
hyperlane config validate ism --path ./ism-config.yaml

# Validate advanced ISM
hyperlane config validate ism-advanced --path ./advanced-ism.yaml

# Validate warp config
hyperlane config validate warp --path ./warp-config.yaml

# Validate strategy
hyperlane config validate strategy --path ./strategy.yaml
```

### hyperlane ism

**Semantic Purpose**: ISMs (Interchain Security Modules) define the security model for verifying messages. This command reads and analyzes ISM configurations to understand security requirements.

**What ISMs do in the system**:

- **Define verification logic**: How to prove a message is valid
- **Set security thresholds**: How many validators must attest
- **Enable flexibility**: Different security models for different use cases
- **Provide modularity**: Compose multiple ISMs for defense-in-depth

**ISM verification process**:

1. **Message arrives**: Relayer submits message to destination Mailbox
2. **ISM called**: Mailbox queries ISM for verification
3. **Proof validated**: ISM checks signatures/proofs against requirements
4. **Decision made**: ISM returns true (valid) or false (invalid)
5. **Execution**: Valid messages proceed to recipient contract

```bash
# Read ISM configuration
hyperlane ism read \
  --chain ethereum \
  --address 0x123... \
  --out ./ism-config.yaml
```

### hyperlane hook

**Semantic Purpose**: Hooks are plugins that execute at specific points in the message lifecycle, enabling custom logic for fees, rate limiting, aggregation, and more.

**What hooks do in the system**:

- **Pre-dispatch processing**:

  - Collect fees before message sending
  - Implement rate limiting or access control
  - Validate message contents
  - Modify message metadata

- **Post-dispatch processing**:
  - Aggregate messages into merkle trees
  - Emit indexing events
  - Trigger dependent operations
  - Update metrics and analytics

**Hook composition**:

- Hooks can be chained for complex logic
- Required hooks must always execute
- Default hooks apply unless overridden
- Custom hooks enable application-specific behavior

```bash
# Read hook configuration
hyperlane hook read \
  --chain ethereum \
  --address 0x456... \
  --out ./hook-config.yaml
```

### hyperlane fork

**Semantic Purpose**: Creates local blockchain forks that replicate mainnet state, enabling risk-free testing of Hyperlane operations, debugging of issues, and validation of upgrades.

**What forking does**:

- **Replicates mainnet state**: Creates exact copy at specific block
- **Preserves contracts**: All Hyperlane contracts remain deployed
- **Maintains balances**: Token balances and liquidity preserved
- **Enables time travel**: Can advance blocks and time
- **Supports debugging**: Full transaction traces and state inspection

**Fork testing capabilities**:

- **Integration testing**: Test interactions with other protocols
- **Upgrade validation**: Verify upgrades work correctly
- **Security testing**: Attempt exploits without risk
- **Performance testing**: Measure gas costs and optimization
- **Debugging**: Reproduce and fix mainnet issues

```bash
# Basic fork
hyperlane fork

# Fork with config
hyperlane fork --fork-config ./fork-config.yaml

# Custom port range
hyperlane fork --port 9545

# Kill after config applied
hyperlane fork --fork-config ./fork-config.yaml --kill
```

### hyperlane deploy

**Semantic Purpose**: Orchestrates the deployment of Hyperlane infrastructure components, particularly complex multi-component systems like agent networks.

**What deployment does**:

- **Coordinates infrastructure**: Deploys validators, relayers, and other agents
- **Configures networking**: Sets up communication between components
- **Manages dependencies**: Ensures correct deployment order
- **Validates deployment**: Checks all components are operational
- **Enables automation**: Supports infrastructure-as-code patterns

#### Deploy Kurtosis Agents

```bash
hyperlane deploy kurtosis-agents \
  --origin ethereum \
  --targets "polygon,arbitrum" \
  --config ./agent-config.json
```

## Configuration Files

### Directory Structure

```
project/
├── configs/
│   ├── core-config.yaml         # Core contracts config
│   ├── warp-route-deployment.yaml  # Warp route config
│   ├── agent-config.json        # Agent configuration
│   └── strategy.yaml            # Transaction strategies
├── ~/.hyperlane/
│   ├── strategies/
│   │   └── default-strategy.yaml
│   └── registry/                # Local registry cache
└── generated/
    └── transactions/            # Transaction receipts
        └── receipts.yaml
```

### Core Configuration Schema

```yaml
owner: '0x...' # Owner address
defaultIsm: # Default ISM config
  type: 'multisigIsm' # ISM type
  threshold: 2 # Signature threshold
  validators: # Validator addresses
    - '0x...'
defaultHook: # Default hook config
  type: 'protocolFee'
  protocolFee: '200000000000000'
  beneficiary: '0x...'
requiredHook: # Required hook config
  type: 'pausableHook'
  paused: false
```

### Warp Route Configuration Schema

```yaml
chainName:
  type: 'native|collateral|synthetic'
  # For native:
  # No token field needed

  # For collateral:
  token: '0x...' # Existing token address

  # For synthetic:
  name: 'Token Name'
  symbol: 'TKN'
  decimals: 18
  totalSupply: 1000000

  # Common fields:
  mailbox: '0x...' # Mailbox address
  owner: '0x...' # Owner address
  interchainSecurityModule: # Optional custom ISM
    type: 'multisigIsm'
    threshold: 2
    validators: ['0x...']
```

## Common Workflows

### 1. Deploy New Hyperlane Network

```bash
# Step 1: Initialize core configuration
hyperlane core init --advanced

# Step 2: Deploy core contracts
hyperlane core deploy --chain ethereum --config ./configs/core-config.yaml
hyperlane core deploy --chain polygon --config ./configs/core-config.yaml

# Step 3: Verify deployment
hyperlane core check --chain ethereum --config ./configs/core-config.yaml
hyperlane core check --chain polygon --config ./configs/core-config.yaml
```

### 2. Create Token Bridge

```bash
# Step 1: Initialize warp route config
hyperlane warp init --advanced --out ./configs/my-token-bridge.yaml

# Step 2: Edit config file for your token
# (Set token addresses, types, etc.)

# Step 3: Deploy warp route
hyperlane warp deploy --config ./configs/my-token-bridge.yaml

# Step 4: Test the bridge
hyperlane warp send --config ./configs/my-token-bridge.yaml \
  --origin ethereum \
  --destination polygon \
  --amount 100
```

### 3. Run Validator

```bash
# Step 1: Create agent config
hyperlane registry agent-config --chains "ethereum,polygon" --out ./agent-config.json

# Step 2: Set up AWS credentials
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
export AWS_REGION=us-east-1

# Step 3: Get validator address
hyperlane validator address --bucket my-validator-bucket

# Step 4: Check validator setup
hyperlane validator check --chain ethereum --validators "0x..."
```

### 4. Test with Local Fork

```bash
# Step 1: Fork chains
hyperlane fork --port 8545

# Step 2: Deploy to forked chains
hyperlane core deploy --dry-run http://localhost:8545

# Step 3: Send test messages
hyperlane send message \
  --origin http://localhost:8545 \
  --destination http://localhost:8546
```

### 5. Update Existing Deployment

```bash
# Step 1: Read current config
hyperlane core read --chain ethereum --config ./current-config.yaml

# Step 2: Modify config file
# (Edit current-config.yaml)

# Step 3: Check what will change
hyperlane core check --chain ethereum --config ./new-config.yaml

# Step 4: Apply updates
hyperlane core apply --chain ethereum --config ./new-config.yaml
```

## Troubleshooting

### Common Issues

#### 1. Authentication Errors

```bash
# Set GitHub token for private registries
export GH_AUTH_TOKEN=your-token

# Disable proxy if having issues
hyperlane --disableProxy <command>
```

#### 2. Transaction Failures

```bash
# Use dry-run to test first
hyperlane core deploy --dry-run sepolia

# Increase gas settings in strategy
hyperlane strategy init
# Edit strategy file to adjust gas
```

#### 3. Key Management

```bash
# Test key works
hyperlane registry list --key "your-key"

# Use protocol-specific keys
export HYP_KEY_ETHEREUM="ethereum-key"
export HYP_KEY_COSMOS="cosmos-key"
```

#### 4. Registry Issues

```bash
# Use local registry only
hyperlane --registry ~/.hyperlane <command>

# Clear registry cache
rm -rf ~/.hyperlane/registry-cache
```

#### 5. Timeout Issues

```bash
# Increase timeout for slow networks
hyperlane send message --timeout 600

# Use quick mode to skip waiting
hyperlane send message --quick
```

### Debug Mode

Enable verbose logging for troubleshooting:

```bash
# Maximum verbosity
hyperlane --verbosity trace <command>

# JSON output for parsing
hyperlane --log json --verbosity debug <command>

# Write logs to file
hyperlane --verbosity debug <command> 2> debug.log
```

### Getting Help

```bash
# General help
hyperlane --help

# Command-specific help
hyperlane <command> --help
hyperlane <command> <subcommand> --help

# Examples:
hyperlane warp send --help
hyperlane core deploy --help
```

## Best Practices

1. **Always use dry-run for deployments**: Test with `--dry-run` before mainnet deployments
2. **Keep configs in version control**: Track all configuration files in git
3. **Use separate keys per environment**: Different keys for testnet vs mainnet
4. **Monitor gas prices**: Set appropriate gas settings in strategy files
5. **Regular backups**: Backup validator keys and important configs
6. **Use registries**: Leverage the official registry for chain metadata
7. **Test locally first**: Use fork mode for local testing
8. **Keep CLI updated**: Regularly update to latest version
9. **Use environment variables**: Store sensitive data in environment variables
10. **Document deployments**: Keep records of deployed addresses and configs

## Additional Resources

- [Hyperlane Documentation](https://docs.hyperlane.xyz)
- [GitHub Repository](https://github.com/hyperlane-xyz/hyperlane-monorepo)
- [Discord Community](https://discord.gg/hyperlane)
- [Example Configurations](https://github.com/hyperlane-xyz/hyperlane-registry)

## Command Reference Summary

| Command               | Purpose                                    |
| --------------------- | ------------------------------------------ |
| `hyperlane core`      | Manage core contracts (Mailbox, ISM, Hook) |
| `hyperlane warp`      | Manage token bridges (Warp Routes)         |
| `hyperlane send`      | Send test messages                         |
| `hyperlane status`    | Check message delivery status              |
| `hyperlane registry`  | Manage chain metadata                      |
| `hyperlane validator` | Configure validators                       |
| `hyperlane avs`       | Manage EigenLayer AVS integration          |
| `hyperlane relayer`   | Run message relayer                        |
| `hyperlane config`    | Validate configuration files               |
| `hyperlane strategy`  | Manage transaction strategies              |
| `hyperlane submit`    | Submit transactions                        |
| `hyperlane ism`       | Read ISM configurations                    |
| `hyperlane hook`      | Read Hook configurations                   |
| `hyperlane fork`      | Fork chains for testing                    |
| `hyperlane deploy`    | Deploy Hyperlane components                |

This guide provides comprehensive coverage of all Hyperlane CLI commands and workflows. For the most up-to-date information, always refer to `hyperlane --help` and the official documentation.
