# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

**Be extremely concise. Sacrifice grammar for concision. Terse responses preferred. No fluff.**

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.

## Overview

Hyperlane is an interchain messaging protocol that enables applications to communicate between blockchains. The monorepo contains three main components:

1. **Smart Contracts (Solidity)** - Core on-chain messaging infrastructure in `solidity/`
2. **TypeScript Packages** - SDK, CLI, and infrastructure tooling in `typescript/`
3. **Rust Agents** - Off-chain relayer and validator infrastructure in `rust/`

## Quick Reference

### Most Common Commands

```bash
# Build everything
pnpm build

# Run all tests
pnpm test

# Lint and format
pnpm lint && pnpm prettier

# Solidity tests (both Hardhat and Forge)
pnpm -C solidity test

# TypeScript SDK tests
pnpm -C typescript/sdk test

# Rust tests
cd rust/main && cargo test

# CLI e2e tests (useful for testing warp routes, core deployments)
pnpm -C typescript/cli test:ethereum:e2e
pnpm -C typescript/cli test:cosmosnative:e2e
pnpm -C typescript/cli test:radix:e2e
```

### Before Committing

```bash
# TypeScript/Solidity
pnpm lint          # Must pass
pnpm prettier      # Auto-formats code
pnpm test          # Run relevant tests
pnpm changeset     # Add changeset if modifying published packages

# Rust (CI-compatible commands)
cd rust/main && cargo clippy --features aleo,integration_test -- -D warnings
cd rust/main && cargo test --all-targets --features aleo,integration_test
cd rust/main && cargo fmt
```

### Changeset Style

Write changeset descriptions in past tense describing what changed:

```text
# Good
The registry code is restructured by moving filesystem components to a dedicated directory.

# Bad
Restructures the registry code.
```

## Repository Structure

```
├── solidity/              # Smart contracts (Hardhat + Forge)
│   ├── contracts/         # Solidity source files
│   │   ├── Mailbox.sol    # Core messaging hub
│   │   ├── isms/          # Interchain Security Modules
│   │   ├── hooks/         # Post-dispatch hooks
│   │   └── token/         # Warp route token contracts
│   └── test/              # Contract tests
├── typescript/
│   ├── sdk/               # Core SDK (@hyperlane-xyz/sdk)
│   ├── cli/               # Hyperlane CLI tool
│   ├── infra/             # Infrastructure and deployment scripts
│   ├── utils/             # Shared utilities (@hyperlane-xyz/utils)
│   └── [other packages]/  # cosmos-sdk, widgets, etc.
├── rust/
│   └── main/              # Rust agents monorepo
│       ├── agents/        # Relayer, Validator, Scraper
│       ├── chains/        # Chain-specific implementations
│       └── config/        # Agent configuration files
└── starknet/              # Starknet utilities and tooling
```

## Engineering Philosophy

### Simplicity First

- Before adding functionality:
  - Verify it cannot be achieved with existing SDK primitives
  - Ensure it solves a recurring problem, not a one-off edge case
  - Confirm the logic belongs in the monorepo rather than a consumer app
- Avoid enterprise-style patterns:
  - No deep inheritance hierarchies; prefer composition
  - No over-engineered abstractions for "future-proofing"
  - No redundant interfaces for single-implementation classes

### Error Handling

The codebase uses `assert()` as the primary error handling pattern:

```typescript
import { assert } from '@hyperlane-xyz/utils';

// Validate preconditions - fails fast with clear message
assert(config, `Missing config for chain ${chain}`);
assert(config.rpcUrls.length > 0, 'At least one RPC URL required');

// Invariant checks
assert(amount > 0, 'Amount must be positive');
```

**When to use each pattern:**

| Situation                  | Pattern           | Example                       |
| -------------------------- | ----------------- | ----------------------------- |
| Preconditions & invariants | `assert()`        | Missing config, invalid state |
| External system calls      | `try/catch`       | RPC requests, file I/O        |
| Graceful degradation       | `try/catch` + log | Optional feature unavailable  |

**Catch block guidelines:**

```typescript
// Preferred: catch with unknown, narrow with type guard
try {
  await provider.getBalance(address);
} catch (error) {
  this.logger.error('Failed to fetch balance', { address, error });
  throw new Error(`Balance fetch failed for ${address}`);
}

// Acceptable in existing code: catch (e: any) when accessing e.message
// New code should prefer unknown + type guards
```

**Do NOT:**

- Swallow errors silently (always log or re-throw)
- Use exceptions for control flow
- Add defensive fallbacks that mask bugs (e.g., `catch(() => AddressZero)`)

### Backwards-Compatibility

| Change Location    | Backwards-Compat? | Rationale                                |
| ------------------ | ----------------- | ---------------------------------------- |
| Local/uncommitted  | No                | Iteration speed; no external impact      |
| In main unreleased | Preferred         | Minimize friction for other developers   |
| Released           | Required          | Prevent breaking downstream integrations |

## Development Commands

### Building

```bash
pnpm build                              # Build all packages (uses Turbo)
pnpm -C solidity build                  # Build Solidity contracts
pnpm -C typescript/sdk build            # Build TypeScript SDK
cd rust/main && cargo build             # Build Rust agents
```

### Testing

```bash
# Solidity
pnpm -C solidity test                   # Both Hardhat and Forge tests
pnpm -C solidity test:hardhat           # Hardhat only
pnpm -C solidity test:forge             # Forge only
forge test -vvv --decode-internal       # Detailed Forge output

# TypeScript
pnpm -C typescript/sdk test             # SDK tests
pnpm -C typescript/sdk test:unit        # Unit tests only
pnpm -C typescript/cli test:ethereum:e2e          # CLI e2e tests (EVM)
pnpm -C typescript/cli test:cosmosnative:e2e      # CLI e2e tests (Cosmos)
pnpm -C typescript/cli test:radix:e2e             # CLI e2e tests (Radix)

# Rust
cd rust/main && cargo test              # All Rust tests
cd rust/main && cargo test <test_name>  # Single test

# E2E (runs local chains + agents)
cd rust/main && cargo run --release --bin run-locally

# VM-specific e2e
cd rust/main && cargo test --release --package run-locally --features cosmos -- cosmos::test --nocapture
cd rust/main && cargo test --release --package run-locally --features sealevel -- sealevel::test --nocapture
```

### Linting & Formatting

```bash
pnpm lint                               # Lint all packages
pnpm prettier                           # Format all packages
pnpm -C solidity lint                   # Solidity linting (solhint)
cd rust/main && cargo clippy            # Rust linting
cd rust/main && cargo fmt               # Rust formatting
```

### Solidity-Specific

```bash
pnpm -C solidity hardhat-esm compile    # Compile contracts
pnpm -C solidity fixtures               # Generate test fixtures (required before forge tests)
pnpm -C solidity gas                    # Generate gas snapshots
pnpm -C solidity coverage               # Coverage report
pnpm -C solidity storage                # Storage layout analysis
forge test --match-test <pattern>       # Run specific Forge tests
```

### CLI Development

```bash
# Install CLI globally from local build
pnpm -C typescript/cli build && npm link

# Run CLI commands
hyperlane --help
hyperlane core deploy --help
hyperlane warp deploy --help
```

## Architecture

### Message Flow

1. **Dispatch**: Applications call `Mailbox.dispatch()` on origin chain
2. **Index**: Relayer agents index dispatched messages from chain events
3. **Security**: Relayer fetches metadata from validators/ISMs
4. **Delivery**: Messages delivered to `Mailbox.process()` on destination
5. **Handle**: Recipient contract receives message via `IMessageRecipient.handle()`

### Core Contracts (`solidity/contracts/`)

| Contract      | Purpose                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `Mailbox.sol` | Central hub for dispatch/process, maintains merkle tree                                  |
| `isms/*`      | Interchain Security Modules - pluggable verification (MultisigIsm, AggregationIsm, etc.) |
| `hooks/*`     | Post-dispatch processing (MerkleTreeHook, InterchainGasPaymaster)                        |
| `token/*`     | Warp route implementations (HypERC20, HypERC20Collateral, HypNative)                     |

### TypeScript SDK (`typescript/sdk/src/`)

| Module                  | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `MultiProvider`         | Multi-chain provider management                  |
| `HyperlaneCore`         | Core contract interactions                       |
| `ChainMap<T>`           | Type-safe per-chain configuration                |
| `WarpCore`              | Warp route deployment and management             |
| `MultiProtocolProvider` | Unified interface across VMs (EVM, Cosmos, etc.) |

### Multi-VM Package Structure

For AltVM (Cosmos, Sealevel, Starknet, Radix) development:

| Package                       | Purpose                                 |
| ----------------------------- | --------------------------------------- |
| `@hyperlane-xyz/provider-sdk` | Protocol-agnostic provider abstractions |
| `@hyperlane-xyz/deploy-sdk`   | Deployment modules for all VM types     |
| `@hyperlane-xyz/sdk`          | Core SDK (EVM-specific)                 |

See `docs/2025-11-20-multi-vm-migration.md` for full migration guide.

### Rust Agents (`rust/main/`)

| Agent       | Purpose                                    |
| ----------- | ------------------------------------------ |
| `relayer`   | Indexes messages, delivers to destinations |
| `validator` | Signs checkpoints for message verification |
| `scraper`   | Indexes chain data for analytics           |

**Chain Crates** (`chains/`):

| Crate                | VM Type       |
| -------------------- | ------------- |
| `hyperlane-ethereum` | EVM chains    |
| `hyperlane-cosmos`   | Cosmos chains |
| `hyperlane-sealevel` | Solana/SVM    |
| `hyperlane-fuel`     | Fuel          |
| `hyperlane-aleo`     | Aleo          |
| `hyperlane-radix`    | Radix         |
| `hyperlane-starknet` | Starknet      |

**Core Crates**: `hyperlane-core` (traits, message types), `hyperlane-base` (shared agent utilities)

## Key Concepts

| Term           | Definition                                                       |
| -------------- | ---------------------------------------------------------------- |
| **Domain**     | Unique identifier for each blockchain (not chain ID)             |
| **Message**    | Core struct: sender, recipient, origin/destination domains, body |
| **ISM**        | Interchain Security Module - pluggable verification logic        |
| **Hook**       | Post-dispatch processing (gas payments, merkle tree, etc.)       |
| **Checkpoint** | Validator-signed commitment to merkle root at index              |
| **Warp Route** | Token bridge deployment across chains                            |

## Configuration

### Chain Configs

- `rust/main/config/` - Agent chain configurations (mainnet3, testnet4)
- `typescript/sdk/src/consts/` - SDK chain metadata
- Registry: External package `@hyperlane-xyz/registry` contains canonical chain configs

### Environment Files

- `.registryrc` - Points to registry version/path
- `typescript/infra/config/` - Infrastructure deployment configs

## Solidity Security Guidelines

Based on [Solcurity Standard](https://github.com/transmissions11/solcurity):

### Core Principles

- Preserve backward compatibility of interfaces and storage layout unless absolutely necessary
- Check for reentrancy vulnerabilities - follow checks-effects-interactions pattern (SWC-107)
- Ensure access control modifiers (`onlyOwner`, etc.) are on privileged functions
- Avoid unchecked arithmetic unless explicitly safe (SWC-101)

### Variables & Storage

- Set visibility explicitly on all variables (SWC-108)
- Pack storage variables when possible (adjacent smaller types)
- Use `constant` for compile-time values, `immutable` for constructor-set values
- Use 256-bit types except when packing for gas efficiency
- Never shadow state variables (SWC-119)

### Functions

- Use `external` visibility when function is only called externally
- Validate all parameters within safe bounds
- Follow checks-before-effects pattern to prevent reentrancy
- Check for front-running vulnerabilities (SWC-114)
- Ensure return values are always assigned
- Don't assume `msg.sender` is the operated-upon user

### External Calls

- Verify external call necessity and assess DoS risk from errors (SWC-113)
- Check harmlessness if reentering current or other functions
- Use SafeERC20 or safely check return values for token transfers
- Use `.call{value: ...}("")` instead of `transfer`/`send` (SWC-134)
- Check contract existence before low-level calls
- Don't assume success implies function existence (phantom functions)

### Math & Data

- Multiply before dividing (unless overflow risk)
- Document precision loss and which actors benefit/suffer
- Use `abi.encode()` over `abi.encodePacked()` for dynamic types (SWC-133)
- Protect signatures with nonce and `block.chainid` (SWC-121)
- Implement EIP-712 for signature standards (SWC-117, SWC-122)

### Events

- Emit events for all storage mutations
- Index action creator and operated-upon users/IDs
- Never index dynamic types (strings, bytes)
- Avoid function calls in event arguments

### DeFi-Specific

- Don't use AMM spot price as oracle
- Separate internal accounting from actual balances
- Document rebasing token, fee-on-transfer, and ERC-777 support status
- Use sanity checks against price manipulation
- Prevent arbitrary calls from user input in approval targets

## Code Review Guidelines

### Security-Critical Areas

| Area                  | Key Concerns                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `solidity/contracts/` | Reentrancy, access control, overflow, storage collisions, upgrade safety |
| `isms/`               | Message verification, multisig thresholds, validator sets                |
| `hooks/`              | Fee calculations, merkle tree integrity                                  |
| `rust/main/agents/`   | Key management, checkpoint signing, message validation                   |
| `typescript/infra/`   | Secrets exposure, RPC endpoints, deployment parameters                   |

### Common Patterns to Enforce

- Use `onlyOwner` or appropriate access modifiers on privileged functions
- Validate inputs at system boundaries using `assert()`
- Follow existing naming conventions and code organization
- Ensure backward compatibility for protocol upgrades
- Include tests for new functionality (especially edge cases)
- Gas efficiency for Solidity (avoid unnecessary storage writes)
- Use `ChainMap` for per-chain configurations in TypeScript

### What NOT to Flag

- Minor style issues handled by prettier/linters
- Existing intentional patterns (check git history if unsure)
- Theoretical issues without practical exploit paths

### What NOT to Add

| Pattern                          | Why Problematic                    | Alternative                                               |
| -------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| Fallbacks for unlikely scenarios | Masks bugs, hides real failures    | Let errors propagate; log and re-throw                    |
| Excessive validation layers      | Bloats code, slows review          | Validate at system boundaries only                        |
| "Just in case" abstractions      | Premature generalization           | Build for current use case; refactor when pattern repeats |
| Defensive defaults               | Silently fails instead of alerting | Fail fast with `assert()`                                 |

## Debugging & Operations

### Skills for Common Tasks

| Skill                                       | Use For                                      |
| ------------------------------------------- | -------------------------------------------- |
| `/debug-message`                            | Debug why a specific message isn't processed |
| `/gcp-logs`                                 | Query GCP logs with efficient filtering      |
| `/debug-validator-checkpoint-inconsistency` | Debug validator checkpoint issues            |

### Primary References

- `docs/ai-agents/operational-debugging.md` - Detailed Grafana/GCP debugging workflows
- [Operations Runbook](https://www.notion.so/hyperlanexyz/Runbook-AI-Agent-24a6d35200d680229b38e8501164ca66) - Manual procedures

### Debugging Priority Order

1. **Use skills first** - `/debug-message` for message issues, `/gcp-logs` for log queries
2. **Start with Grafana** - Check alerts and dashboards for context
3. **Use Hyperlane Explorer** - Find stuck messages before querying logs
4. **Query GCP logs** - Use `gcloud` CLI (not MCP server)

### Key Dashboards

| Dashboard          | UID                                    | Use For                          |
| ------------------ | -------------------------------------- | -------------------------------- |
| Easy Dashboard     | `fdf6ada6uzvgga`                       | Queue lengths, reprepare reasons |
| Relayers v2 & v3   | `k4aYDtK4k`                            | Prepare queues, message flow     |
| RPC Usage & Errors | `bdbwtrzoms5c0c`                       | RPC error rates                  |
| Lander Dashboard   | `197feea9-f831-48ce-b936-eaaa3294a3f6` | Transaction submission           |
| Validator In-house | `xrNCvpK4k`                            | Internal validator health        |
| Validator External | `cdqntgxna4vswd`                       | External validator status        |

### Common Error Patterns

| Error                      | Priority | Action                                               |
| -------------------------- | -------- | ---------------------------------------------------- |
| `eth_estimateGas` failures | HIGH     | Check for contract reverts, decode with `cast 4byte` |
| High retry counts (40+)    | HIGH     | Investigate persistent issues                        |
| `CouldNotFetchMetadata`    | LOW      | Only check validators after 5+ min delays            |
| Nonce errors               | LOW      | Normal during gas escalation unless persistent       |
| Connection resets          | LOW      | Normal RPC hiccups unless frequent                   |
| 503 errors                 | LOW      | Provider issues, only investigate if persistent      |

### Validator Debugging

Use `hyperlane_observed_validator_latest_index{origin="[chain]"}` for ALL validators (including external).

Convert addresses to names: `grep -i "[address]" typescript/sdk/src/consts/multisigIsm.ts`

## TypeScript Style

### Type Safety

- Avoid unnecessary type casts (`as` assertions), especially `as unknown as X` double-casts
- If types don't match, fix the underlying types rather than casting:
  - Adjust interface definitions to be compatible
  - Use type guards for runtime narrowing
  - Compose objects explicitly (spread + missing properties)
- Prefer proper typing over `any` or type assertions
- Note: spread operators (`{ ...obj }`) don't bypass type checking

### SDK Patterns

- Use `ChainMap<T>` for per-chain configurations
- Use `MultiProvider` for multi-chain provider management
- Import types from `@hyperlane-xyz/sdk` rather than redefining
- Use `MultiProtocolProvider` for cross-VM abstractions

### Schema Validation

The SDK uses Zod for config validation. Follow existing patterns in `typescript/sdk/src/` for schema definitions.

### Infrastructure Code (`typescript/infra/`)

- Never expose secrets in code or logs
- Validate RPC endpoints and deployment parameters
- Use config files from `typescript/infra/config/` as examples

## MCP Server Setup

For AI agent integrations, see `docs/ai-agents/mcp-server-setup.md`.

Available MCP servers:

| Server               | Purpose                       |
| -------------------- | ----------------------------- |
| `google-cloud-mcp`   | GCP logging queries           |
| `grafana`            | Grafana dashboards and alerts |
| `hyperlane-explorer` | Message status queries        |
| `notion`             | Documentation access          |

## Tips for Claude Code Sessions

1. **Run tests incrementally** - Don't run full test suite; run specific tests for changed code
2. **Check existing patterns** - Search codebase for similar implementations before writing new code
3. **Use TypeScript SDK types** - The SDK has comprehensive types; import from `@hyperlane-xyz/sdk`
4. **Solidity inheritance** - Many contracts inherit from base classes; check the hierarchy
5. **Config-driven** - Most deployments are config-driven; check `typescript/infra/config/` for examples
6. **Registry is external** - Chain metadata lives in `@hyperlane-xyz/registry`, not this repo
7. **Keep changes minimal** - Only modify what's necessary; avoid scope creep
8. **Use `assert()` liberally** - For preconditions, invariants, and unexpected states
9. **Check error patterns first** - Review existing error handling before adding new try/catch
10. **Question fallbacks** - Undefined values often signal bugs; don't mask with defaults
11. **Never force push** - Don't use `git push --force`; use `git pull --rebase` to sync with remote and preserve git history

## Verify Before Acting

**Always search the codebase before assuming.** Don't hallucinate file paths, function names, or patterns.

- `grep` or search before claiming "X doesn't exist"
- Read the actual file before suggesting changes to it
- Check `git log` or blame before assuming why code exists
- Verify imports exist in `package.json` before using them

## When Claude Gets It Wrong

If output seems wrong, check:

1. **Did I read the actual file?** Or did I assume its contents?
2. **Did I search for existing patterns?** The codebase likely has examples
3. **Am I using stale context?** Re-read files that may have changed
4. **Did I verify the error message?** Run the command and read actual output
