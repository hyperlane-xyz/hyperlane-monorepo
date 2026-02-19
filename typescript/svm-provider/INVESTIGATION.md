# Deep Investigation: TypeScript-Native Solana Program Deployment

## Executive Summary

The `andrey/solana-port` branch implements a **TypeScript-native deployment system** for Hyperlane Solana programs, eliminating dependencies on Solana CLI and spl-token CLI. The implementation spans ~16K lines across `typescript/svm-provider/`.

**Status**: Core infrastructure complete, ISM/Hook artifacts working, e2e tests passing with Docker/local validator.

**Key Achievement**: Full deployment flow from `.so` binary → deployed program using only TypeScript, leveraging:

- **BPF Loader v3** (manual instruction building)
- **Codama-generated clients** (from Shank IDLs)
- **@solana/kit** (web3.js v2) for modern transaction building

---

## Current State of Hyperlane Solana Programs

### Native Solana Programs (Not Anchor)

**Critical Context**: Hyperlane Solana programs are **native Solana programs** using the raw `solana-program` SDK, NOT the Anchor framework.

**Why Not Anchor?**

- Hyperlane programs predate this TypeScript port initiative (deployed on mainnet)
- Native programs provide full control over instruction processing, serialization, and account management
- No Anchor IDL generation built-in (requires separate tooling)
- Existing production deployment scripts use Solana CLI + manual Rust client

**Program Architecture** (`rust/sealevel/programs/`):

```
mailbox/
├── src/
│   ├── lib.rs           # Module exports
│   ├── instruction.rs   # Instruction enum with Shank annotations
│   ├── processor.rs     # Manual instruction dispatch (process_instruction)
│   ├── accounts.rs      # Account structs with Borsh serialization
│   ├── pda_seeds.rs     # PDA seed macros
│   └── error.rs         # Custom error types
└── Cargo.toml           # Dependencies: borsh, shank, solana-program
```

**Key Characteristics**:

1. **Manual entrypoint**: `entrypoint!(process_instruction)` - routes instructions to handlers
2. **Borsh serialization**: All accounts/instructions use `BorshSerialize`/`BorshDeserialize`
3. **Explicit account validation**: Manual checks for signers, writable, PDAs
4. **No Anchor macros**: No `#[program]`, `#[derive(Accounts)]`, or `#[account]` attributes

### Shank Annotations (Added Later)

**Timeline**: Shank annotations added in PR #7856 (first step toward TypeScript client generation).

**Example** (from `mailbox/src/instruction.rs`):

```rust
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, ShankInstruction)]
pub enum Instruction {
    #[account(0, name = "system_program", desc = "System program")]
    #[account(1, writable, signer, name = "payer", desc = "Payer and owner")]
    #[account(2, writable, name = "inbox", desc = "Inbox PDA")]
    #[account(3, writable, name = "outbox", desc = "Outbox PDA")]
    Init(Init),

    #[account(0, signer, name = "payer", desc = "Payer account")]
    #[account(1, writable, name = "inbox", desc = "Inbox PDA")]
    InboxProcess(InboxProcess),
    // ...
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Eq, ShankAccount)]
pub struct Inbox {
    pub bump_seed: u8,
    pub local_domain: u32,
    pub default_ism: Pubkey,
    pub processed_count: u64,
    // ...
}
```

**Shank's Role**: Extract IDL from these annotations without changing program behavior.

---

## Why This TypeScript Code Generation Approach?

### Historical Context: The Problem

**Before this work**:

- Hyperlane Solana programs deployed via Rust CLI client (`rust/sealevel/client/`)
- Rust CLI depended on external tools: `solana`, `spl-token`, `solana-keygen`
- No TypeScript SDK for Solana programs
- Manual Borsh serialization in TypeScript (error-prone, maintenance burden)
- No type safety between Rust programs and TypeScript consumers

**Goal**: Enable TypeScript-native deployment matching existing Rust CLI functionality.

### Why Shank? (IDL Generation)

**Alternatives Considered**:

| Approach                 | Pros                                         | Cons                                                           | Decision      |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------------- | ------------- |
| **Anchor Framework**     | Built-in IDL, mature ecosystem               | Requires rewriting all programs, breaks production deployments | ❌ Rejected   |
| **Manual IDL authoring** | Full control                                 | Error-prone, maintenance nightmare, duplicates Rust code       | ❌ Rejected   |
| **Shank**                | Works with native programs, annotations only | Cannot scan dependency crates                                  | ✅ **Chosen** |
| **Custom parser**        | Tailored to Hyperlane                        | High maintenance, reinventing wheel                            | ❌ Rejected   |

**Shank Decision** (from PR #7856):

- Minimal changes to Rust code (add derive macros only)
- Compatible with existing native programs
- Generates Anchor-compatible IDL format
- Proven in Metaplex programs

**Trade-off Accepted**: Shank's limitation of not scanning dependencies means generic types like `H256` must be duplicated locally or converted in client code.

### Why Codama? (TypeScript Client Generation)

**Alternatives Considered**:

| Tool               | Input                 | Output                                     | Status                    |
| ------------------ | --------------------- | ------------------------------------------ | ------------------------- |
| **Solita**         | Shank IDL             | TypeScript (web3.js v1)                    | Outdated, web3.js v1 only |
| **Anchor TS**      | Anchor IDL            | TypeScript (Anchor.js)                     | Requires Anchor programs  |
| **Codama**         | Anchor-compatible IDL | TypeScript (@solana/kit), Rust, Go, Python | ✅ **Chosen**             |
| **Manual clients** | N/A                   | Custom TypeScript                          | High maintenance          |

**Codama Decision**:

- Modern output: `@solana/kit` (web3.js v2) with type safety
- Cross-language support (future Rust/Go clients)
- Active development, Metaplex-backed
- Tree-based IDL manipulation (enables transforms, multi-program generation)

**Custom Fork**: Using `github:antigremlin/renderers-js#contrib` for ESM import enhancements (`.js` extensions).

### Why Combined Codama Generation?

**Decision**: Generate all 9 programs in single Codama tree (`codama-combined.mjs`).

**Rationale**:

- **Cross-program references**: IGP program imports mailbox types, token programs reference mailbox
- **Type deduplication**: Shared types (e.g., `H256` wrapper) generated once
- **Consistent naming**: Unified resolver for type name collisions

**Alternative** (`codama-separate.mjs`): Generate each program separately. Used for debugging IDL issues.

### Why Manual Loader v3 Instructions?

**Decision**: Manually build BPF Loader v3 instructions instead of using `@solana-program/loader-v3`.

**Context**: `@solana-program/loader-v3` only provides IDL, no generated TypeScript client yet.

**Options**:

1. **Wait for Codama to generate Loader v3 client** → Blocked on external project timeline
2. **Generate Loader v3 client ourselves** → Adds complexity, another dependency
3. **Manual implementation** → Full control, matches Rust CLI exactly

**Chosen**: Manual implementation (523 lines in `program-deployer.ts`).

**Validation**: Matches Solana CLI behavior exactly:

- Chunk size: 880 bytes (verified against Solana CLI source)
- Deploy flow: create buffer → write chunks → deploy
- Upgrade flow: create new buffer → write → upgrade (closes old buffer)

---

## Architecture & Code Structure

### Package Organization

```
typescript/svm-provider/
├── src/
│   ├── deploy/              # Program deployment (Loader v3)
│   ├── clients/             # Provider/protocol abstraction (placeholder)
│   ├── ism/                 # ISM artifact managers (test, multisig)
│   ├── hook/                # Hook artifact managers (merkle, IGP)
│   ├── generated/           # Codama-generated TypeScript clients
│   ├── testing/             # Docker/local validator setup
│   ├── tests/               # E2E tests
│   ├── tx.ts, signer.ts     # Transaction/signing primitives
│   ├── rpc.ts, pda.ts       # RPC client factory, PDA helpers
│   └── types.ts             # Core types
├── codama-combined.mjs      # IDL → TypeScript generation script
└── package.json             # Dependencies (@solana/kit, codama, etc.)
```

### Design Philosophy

**1. Artifact API Pattern** (from provider-sdk)

- `ArtifactReader<Config, Address>` - Read on-chain state
- `ArtifactWriter<Config, Address>` - Deploy/update state
- Consistent interface across VMs (EVM, Cosmos, Radix, Aleo)

**2. Separation of Concerns**

- **Program Deployer** (`deploy/program-deployer.ts`) - Handles BPF Loader v3 protocol
- **Artifact Managers** (`ism/`, `hook/`) - High-level business logic (ISM setup, IGP config)
- **Generated Clients** (`generated/`) - Low-level instruction building (auto-generated, never edit)
- **Testing Infrastructure** (`testing/`) - Validator lifecycle (Docker/local binary)

**3. No Solana CLI Dependency**

- All deployment operations via TypeScript
- Program deployment: Manual Loader v3 instructions
- Token operations: Would use `@solana-program/token-2022` (not yet implemented)

---

## Toolchain Pipeline: Rust → IDL → TypeScript

### Phase 1: Shank Annotations (Rust)

**Location**: `rust/sealevel/programs/*/src/`

Rust programs annotated with Shank derive macros:

```rust
#[derive(ShankAccount)]
pub struct Inbox {
    pub local_domain: u32,
    pub processed_count: u32,
    // ...
}

#[derive(ShankInstruction)]
pub enum Instruction {
    #[account(0, writable, signer, name="payer")]
    #[account(1, writable, name="inbox")]
    InboxProcess { metadata: Vec<u8>, message: Vec<u8> },
}
```

**Limitation**: Shank cannot scan dependencies. Generic types (like `H256`) must be duplicated locally or converted in client code.

### Phase 2: IDL Generation

**Script**: `rust/sealevel/generate-idls.sh`
**Output**: `rust/sealevel/programs/idl/*.json` (9 IDL files)

Example IDL structure:

```json
{
  "version": "0.1.0",
  "name": "hyperlane_sealevel_mailbox",
  "instructions": [...],
  "accounts": [...],
  "types": [...],
  "metadata": {
    "address": "HyperlaneMailbox11111111111111111111111111111",
    "origin": "shank"
  }
}
```

### Phase 3: Codama Code Generation

**Script**: `typescript/svm-provider/codama-combined.mjs`
**Tool**: Codama (IDL → TypeScript client generator)

Process:

1. Load all 9 IDL files
2. Create unified Codama tree (enables cross-program references)
3. Generate TypeScript clients with `@codama/renderers-js`

**Output** (per program):

```
src/generated/programs/hyperlaneSealevelMailbox.ts  # Program metadata
src/generated/instructions/*.ts                      # Instruction builders
src/generated/accounts/*.ts                          # Account codecs
src/generated/types/*.ts                             # Custom type definitions
src/generated/errors/*.ts                            # Error codes
```

### Phase 4: Manual Integration

Artifact managers import generated clients:

```typescript
import { fetchInbox } from '../generated/accounts/inbox.js';
import { getInboxProcessInstruction } from '../generated/instructions/inboxProcess.js';

// Use generated instruction builder
const ix = getInboxProcessInstruction({
  payer: payerAddress,
  inbox: inboxPda,
  // ... accounts inferred from IDL
  metadata,
  message,
});
```

---

## Key Components Deep Dive

### 1. Program Deployer (`deploy/program-deployer.ts`)

**Implements BPF Loader v3 (Upgradeable Loader) protocol manually.**

#### Deployment Flow

```typescript
deployProgram({ rpc, signer, programBytes });
```

**Steps**:

1. **Create buffer account** (rent-exempt size = `programBytes.length + 45`)
2. **Initialize buffer** (sets upgrade authority)
3. **Write program chunks** (~880 bytes/tx, matching Solana CLI)
4. **Deploy from buffer** (creates program account, sets max data len = 2x program size)

**Key Constants**:

- `WRITE_CHUNK_SIZE = 880` (max ~1000 bytes/tx after headers)
- `PROGRAM_DATA_HEADER_SIZE = 45` (4 enum + 8 slot + 1 option + 32 authority)

#### Upgrade Flow

```typescript
upgradeProgram({ rpc, signer, programId, newProgramBytes, upgradeAuthority });
```

**Steps**:

1. Create new buffer account
2. Write new program bytes
3. Execute upgrade instruction (old buffer closed, rent refunded)

#### Manual Instruction Building

No dependency on `@solana-program/loader-v3`. All Loader v3 instructions built manually:

```typescript
function createWriteInstruction(
  bufferAccount: Address,
  bufferAuthority: KeyPairSigner,
  offset: number,
  bytes: Uint8Array,
): IInstruction {
  // Data: [discriminator(u32), offset(u32), bytes_len(u64), bytes...]
  const data = new Uint8Array(16 + bytes.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, LoaderV3Discriminator.Write, true);
  view.setUint32(4, offset, true);
  view.setBigUint64(8, BigInt(bytes.length), true);
  data.set(bytes, 16);

  return {
    programAddress: LOADER_V3_PROGRAM_ID,
    accounts: [
      { address: bufferAccount, role: 1 }, // writable
      { address: bufferAuthority.address, role: 2 }, // signer
    ],
    data,
  };
}
```

**Why manual?** `@solana-program/loader-v3` only has IDL, not full TypeScript client. Manual implementation gives full control.

---

### 2. ISM Artifact Manager (`ism/ism-artifact-manager.ts`)

**Factory for ISM readers/writers.** Detects ISM type and delegates to specialized handlers.

#### Supported ISM Types

| Type                   | Program                                      | Status           |
| ---------------------- | -------------------------------------------- | ---------------- |
| `TEST_ISM`             | `hyperlane_sealevel_test_ism`                | ✅ Implemented   |
| `MESSAGE_ID_MULTISIG`  | `hyperlane_sealevel_multisig_ism_message_id` | ✅ Implemented   |
| `MERKLE_ROOT_MULTISIG` | N/A                                          | ❌ Not on Solana |
| `DOMAIN_ROUTING`       | N/A                                          | ❌ Not on Solana |

#### Multisig ISM Complexity (`ism/multisig-ism.ts`)

**Solana-specific design**: Validators stored per-domain in separate PDAs (vs. EVM single contract).

```typescript
interface SvmMultisigIsmConfig extends MultisigIsmConfig {
  domains?: Record<number, { validators: string[]; threshold: number }>;
}
```

**Create flow**:

1. Initialize access control (sets owner)
2. For each domain: batch `setValidatorsAndThreshold` instructions (5 domains/tx)

**Read limitation**: Cannot enumerate all configured domains from on-chain data. Requires off-chain indexing or caller must know domain IDs.

---

### 3. Hook Artifact Manager (`hook/hook-artifact-manager.ts`)

#### Supported Hook Types

| Type                       | Implementation     | Status         |
| -------------------------- | ------------------ | -------------- |
| `MERKLE_TREE`              | Built into mailbox | ✅ Implemented |
| `INTERCHAIN_GAS_PAYMASTER` | IGP program        | ✅ Implemented |

#### IGP Hook (`hook/igp-hook.ts`)

**Salt-based PDA derivation**:

```typescript
const salt = deriveIgpSalt('default'); // sha256('default') truncated to 32 bytes
const igpPda = await deriveIgpAccount(igpProgramId, salt);
```

**Create flow**:

1. Initialize IGP account (with salt)
2. Set gas oracle configs (per destination domain)
3. Set overhead configs (gas overhead per destination)

**Complexity**: IGP uses 8-byte discriminators (not standard 1-byte Anchor discriminators).

---

### 4. Generated Code Structure (`generated/`)

**Auto-generated by Codama. Never edit.**

#### Example: Inbox Process Instruction

```typescript
// src/generated/instructions/inboxProcess.ts
export type InboxProcessInstructionAccounts = {
  payer: TransactionSigner;
  inbox: Address;
  processedMessage: Address;
  storageGasOracle?: Address;
  interchainGasPaymaster?: Address;
  systemProgram?: Address;
};

export type InboxProcessInstructionData = {
  discriminator: number;
  metadata: Uint8Array;
  message: Uint8Array;
};

export function getInboxProcessInstruction(
  input: InboxProcessInstructionAccounts & InboxProcessInstructionData,
): InstructionWithSigners {
  // Generated encoder/decoder logic
}
```

**Type Safety**: Codama generates discriminated unions for instruction types, preventing misuse.

---

### 5. Transaction Building (`tx.ts`)

**Uses @solana/kit functional composition pattern.**

```typescript
export function buildTransaction(params: {
  instructions: SvmInstruction[];
  feePayer: TransactionSigner;
  recentBlockhash: Blockhash;
  lastValidBlockHeight: bigint;
  computeUnits?: number;
}): CompiledTransaction {
  // Add compute budget instructions first
  const computeBudgetIxs = getComputeBudgetInstructions(computeUnits);
  const allInstructions = [...computeBudgetIxs, ...instructions];

  // Functional composition (pipe pattern)
  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(feePayer.address, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash, lastValidBlockHeight },
        tx,
      ),
    (tx) => appendTransactionMessageInstructions(allInstructions, tx),
  );

  return compileTransaction(txMessage);
}
```

**Key difference from web3.js v1**: Immutable transaction messages, functional composition.

---

### 6. Signer (`signer.ts`)

**Custom implementation (not using ISigner interface from provider-sdk).**

```typescript
export interface SvmSigner {
  address: Address;
  keypair: KeyPairSigner;
  signAndSend(rpc, tx): Promise<SvmReceipt>;
  signAndSendBatch(rpc, txs): Promise<SvmReceipt[]>;
}
```

**Key features**:

- Supports hex (32/64 bytes), base58, base64 private keys
- Custom transaction serialization (manual wire format construction)
- Fast polling for local validators (500ms interval)
- `skipPreflight: true` for faster local testing

**Wire format construction**:

```typescript
const wireBytes = new Uint8Array(1 + sigCount * 64 + msgBytes.length);
wireBytes[0] = sigCount;
// Write all 64-byte signatures
// Write message bytes
const base64Tx = Buffer.from(wireBytes).toString('base64');
await rpc
  .sendTransaction(base64Tx, { encoding: 'base64', skipPreflight: true })
  .send();
```

---

### 7. Testing Infrastructure (`testing/solana-container.ts`)

**Sophisticated validator startup strategy.**

#### Platform Detection

```typescript
isAppleSilicon(); // Returns true if Darwin + arm64
```

**Apple Silicon challenge**: Solana binaries require AVX instructions → Rosetta 2 cannot emulate → Docker fails.

#### Startup Strategy

1. **Prefer local binary** (if found):

   - Search paths: `~/.local/share/solana/install/releases/2.0.20/bin`, active_release, etc.
   - Require Solana 2.x for full compatibility
   - Spawn `solana-test-validator` process with ledger dir

2. **Fallback to Docker** (if no local binary):

   - Use `anzaxyz/agave:v2.0.20` image
   - Platform override: `linux/amd64` on Apple Silicon
   - Override entrypoint to bypass `solana-genesis` (crashes under Rosetta)
   - Wait strategy: `Wait.forLogMessage(/Processed Slot:/, 1)`

3. **Apple Silicon without local binary**: Error (no Docker support)

#### Preloaded Programs

**Key optimization**: Preload program `.so` files via `--bpf-program` (bypasses slow deployment).

```typescript
startSolanaTestValidator({
  preloadedPrograms: [
    {
      programId: 'TestIsm...',
      soPath: '/path/to/hyperlane_sealevel_test_ism.so',
    },
    {
      programId: 'MultisigIsm...',
      soPath: '/path/to/hyperlane_sealevel_multisig_ism.so',
    },
  ],
});
```

**E2E test speedup**: ~5 minutes → ~30 seconds.

---

## ⚠️ CRITICAL: IDL Code Generation Gap

> **See [CODEGEN-GAP-ANALYSIS.md](./CODEGEN-GAP-ANALYSIS.md) for comprehensive analysis and solutions.**

**THE PROBLEM**: Shank IDL generation **cannot represent programs that process multiple instruction sets**. Programs implementing interfaces (MessageRecipientInstruction, InterchainSecurityModuleInstruction) have **missing instructions in generated IDLs and TypeScript clients**.

**IMPACT**:

- ❌ Token warp routes cannot process incoming messages (missing `Handle` instruction)
- ❌ ISM verification incomplete (missing `Verify`, `Type` instructions)
- ⚠️ Generated TypeScript clients only cover ~50% of program functionality

**AFFECTED PROGRAMS**:

- Token, Token-Native, Token-Collateral (missing MessageRecipient interface)
- HelloWorld, Test-ISM (missing interface instructions)
- **6 out of 12 programs affected**

**ROOT CAUSE**:

- Programs use cascading instruction decode (try interface → fall back to program instructions)
- Interface instructions use 8-byte hash-based discriminators
- Shank can only annotate ONE `#[derive(ShankInstruction)]` enum per program
- Interface enums in separate crates not scanned by Shank

**RECOMMENDED SOLUTION** (for Friday deadline):
**Hybrid Approach** - Keep Shank-generated code for program instructions, write manual TypeScript clients for interface instructions. Implementation timeline: 1.5-2 days.

See full analysis in [CODEGEN-GAP-ANALYSIS.md](./CODEGEN-GAP-ANALYSIS.md) for:

- Detailed problem scope
- All 5 solution options evaluated
- Implementation plan (3-day timeline)
- Testing checklist
- Long-term strategy

---

## Critical Footguns & Pitfalls

### 1. **Generated Code Must Never Be Edited**

❌ **Don't**:

```typescript
// src/generated/instructions/inboxProcess.ts
export function getInboxProcessInstruction(...) {
  // Added custom validation ← WILL BE OVERWRITTEN
}
```

✅ **Do**: Wrap generated code in custom abstractions.

### 2. **Codama Fork Dependency**

```json
"@codama/renderers-js": "github:antigremlin/renderers-js#contrib"
```

**Issue**: Using custom fork for import enhancements. Must track upstream changes.

**Footgun**: If fork diverges, may have merge conflicts or missing features.

### 3. **8-Byte Discriminators (IGP)**

Most Solana programs use 1-byte discriminators. IGP uses **8-byte discriminators** (Anchor-style).

```typescript
// Generated code handles this, but manual construction must match
const data = new Uint8Array(8 + dataLength);
const view = new DataView(data.buffer);
view.setBigUint64(0, discriminatorBigInt, true); // Not setUint32!
```

**Footgun**: Mixing discriminator sizes breaks instruction parsing.

### 4. **PDA Derivation Not Generated**

Codama does **not** generate PDA derivation helpers. Must implement manually:

```typescript
export async function deriveInboxPda(
  mailboxProgramId: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: mailboxProgramId,
    seeds: [Buffer.from('hyperlane_inbox'), Buffer.from([0])], // Matches Rust
  });
  return pda;
}
```

**Footgun**: Seed mismatches cause "account not found" errors. Must exactly match Rust `pda_seeds!()` macros.

### 5. **Multisig ISM Domain Enumeration**

Cannot enumerate configured domains from on-chain state:

```typescript
// This only works if you know domain ID
const domainData = await readDomain(1); // Ethereum mainnet
```

**Footgun**: Incomplete reads if caller doesn't know all domain IDs. Requires off-chain indexing or config file.

### 6. **Transaction Size Limits**

Max transaction size: **1232 bytes** (Solana network limit).

**Write chunk size calculation**:

```
1232 - signatures (64*N) - headers (~100) - instruction overhead (16) = ~880 bytes
```

**Footgun**: Increasing `WRITE_CHUNK_SIZE` above ~900 will cause `Transaction too large` errors.

### 7. **@solana/kit vs @solana/web3.js Incompatibility**

Cannot mix types:

```typescript
// ❌ Type error
const pubkey = new PublicKey(address); // address is Address (string)
const instruction = getInboxProcessInstruction({ payer: pubkey }); // Expects Address, not PublicKey
```

**Solution**: Use conversion helpers:

```typescript
function publicKeyToAddress(key: PublicKey): Address {
  return key.toBase58() as Address;
}
```

### 8. **Docker on Apple Silicon Fragility**

**Current workaround**: Override entrypoint to skip `solana-genesis`.

```typescript
.withEntrypoint(['solana-test-validator']) // Bypass solana-run.sh
```

**Footgun**: Image updates may change entrypoint behavior, breaking tests.

**Mitigation**: Tests detect Apple Silicon and error with install instructions if no local binary.

### 9. **Loader v3 Manual Implementation Risk**

No dependency on `@solana-program/loader-v3` means manual instruction building.

**Risk**: Solana upgrades Loader v3 protocol → manual implementation breaks.

**Mitigation**: Test against multiple Solana versions (2.0.x, 2.1.x).

### 10. **Compute Unit Estimation**

Hardcoded compute units:

```typescript
export const DEFAULT_COMPUTE_UNITS = 200_000;
// Deploy needs more
const deployReceipt = await signer.signAndSend(rpc, {
  instructions: [createProgramIx, deployIx],
  computeUnits: 400_000,
});
```

**Footgun**: Complex transactions may exceed limits → `Compute budget exceeded` error.

**Mitigation**: Use `simulateTransaction` for estimation (not yet implemented).

---

## Testing Strategy

### E2E Tests (`src/tests/*.e2e-test.ts`)

**Framework**: Mocha + Chai
**Timeout**: 60 seconds (includes validator startup)

#### ISM Tests (`ism.e2e-test.ts`)

1. Start Solana validator with preloaded ISM programs
2. Create test ISM (initialize)
3. Read back state
4. Create multisig ISM with domain configs
5. Verify validators/thresholds per domain

#### Hook Tests (`hook.e2e-test.ts`)

1. Start validator with preloaded mailbox/IGP programs
2. Deploy mailbox (initialize inbox/outbox)
3. Read merkle tree hook (built into mailbox)
4. Create IGP hook with gas oracle configs
5. Verify oracle rates per domain

**Coverage**: Happy path only. No error cases, no upgrade scenarios.

### Test Helpers (`testing/setup.ts`)

```typescript
export function getPreloadedPrograms(
  programs: ProgramName[],
): PreloadedProgram[] {
  // Maps program names to .so paths in rust/sealevel/target/deploy/
}

export async function airdropSol(
  rpc: Rpc,
  address: Address,
  lamports = 10_000_000_000,
) {
  // Request SOL from faucet
}
```

**Assumption**: Programs already built (`cargo build-sbf` in rust/sealevel).

---

## Dependencies & External Libraries

### Core Dependencies

```json
{
  "@solana/kit": "^2.3.0", // Web3.js v2 (functional API)
  "@solana/web3.js": "catalog:", // Legacy v1 (still used in some places?)
  "@solana/spl-token": "catalog:", // Token program (not yet used)
  "@solana-program/loader-v3": "catalog:", // Loader v3 IDL (not used for clients)
  "viem": "catalog:", // Ethereum lib (why? address utils?)
  "@hyperlane-xyz/provider-sdk": "workspace:*", // Artifact interfaces
  "@hyperlane-xyz/utils": "workspace:*" // strip0x, etc.
}
```

### Build-Time Dependencies

```json
{
  "codama": "^1.5.0", // IDL tree manipulation
  "@codama/nodes-from-anchor": "^1.3.8", // IDL parser
  "@codama/renderers-js": "github:antigremlin/renderers-js#contrib" // TS generator (fork!)
}
```

### Why viem?

```typescript
import { strip0x } from '@hyperlane-xyz/utils';
```

Likely used for hex utilities. **Could be removed** if `@hyperlane-xyz/utils` provides equivalent.

### @solana/web3.js v1 Still Present

**Issue**: `package.json` has both `@solana/kit` and `@solana/web3.js`.

**Risk**: Accidental v1 usage creates incompatibilities.

**Mitigation**: Lint rule or search for `import ... from '@solana/web3.js'`.

---

## Integration with Existing Systems

### Provider SDK Integration

**Goal**: Implement `IProvider<SvmTransaction>` interface (currently placeholder).

```typescript
// src/clients/provider.ts (currently empty)
export {};
```

**Expected**:

```typescript
export class SvmProvider implements IProvider<SvmTransaction> {
  async getBalance(address: string): Promise<bigint> { ... }
  async getBlockNumber(): Promise<number> { ... }
  async sendTransaction(tx: SvmTransaction): Promise<TxReceipt> { ... }
}
```

**Blocker**: `IProvider` interface may assume EVM patterns. Needs multi-VM abstraction review.

### Deploy SDK Integration

**Goal**: Artifact managers consumed by `@hyperlane-xyz/deploy-sdk`.

**Current state**: ISM/Hook artifact managers match interface but use `SvmSigner` instead of `ISigner`.

```typescript
// ism-artifact-manager.ts
export class SvmIsmArtifactManager {
  // Note: Doesn't implement IRawIsmArtifactManager because ISigner != SvmSigner
  createWriter<T>(type: T, signer: SvmSigner): ArtifactWriter<...> { ... }
}
```

**Risk**: Type incompatibility with deploy-sdk. May need adapter layer.

### Existing Sealevel Adapters (`typescript/sdk/src/providers/sealevel/`)

**NOT MIGRATED**. Old code uses:

- `@solana/web3.js` v1 (class-based)
- Manual Borsh serialization
- `TransactionInstruction` construction

**Migration path** (per `SEALEVEL_INTEGRATION.md`):

1. Start with `SealevelCoreAdapter` (mailbox)
2. Replace manual serialization with generated instruction builders
3. Update account decoding to generated codecs
4. Gradually migrate other adapters

**Timeline**: Not started. Blocked on design decision (migrate SDK to @solana/kit vs. compatibility layer).

---

## Gaps & Future Work

### 1. Token Warp Route Support

**Status**: ❌ Not implemented

**Requirements**:

- `@solana-program/token-2022` client for SPL Token operations
- Token warp route artifact managers (synthetic, native, collateral)
- Integration with Token Extensions (transfer fees, transfer hooks)

**Complexity**: Token-2022 has many extensions. Warp routes must handle:

- Associated token accounts (ATA) derivation
- Mint/burn authorities
- Transfer hook integration (for warp route logic)

### 2. Provider Implementation

**Status**: ❌ Placeholder only

**Needed**:

```typescript
export class SvmProvider implements IProvider<SvmTransaction> {
  constructor(rpc: Rpc<SolanaRpcApi>) { ... }

  async getBalance(address: string): Promise<bigint> { ... }
  async getBlockNumber(): Promise<number> { ... }
  async sendTransaction(tx: SvmTransaction): Promise<TxReceipt> { ... }
  async estimateGas(tx: SvmTransaction): Promise<bigint> { ... }
}
```

**Challenge**: `IProvider` interface may be EVM-centric. Solana has no gas estimation (compute units).

### 3. Loader v4 Support

**Current**: Only Loader v3 (upgradeable programs).

**Loader v4**: New on-chain loader with:

- Improved upgrade UX
- Better account management
- Enhanced security features

**Status**: Not implemented. Loader v3 sufficient for now.

### 4. Error Handling & Recovery

**Current**: Basic error propagation. No retries, no gas estimation failures.

**Needed**:

- Retry logic for transient RPC errors
- Compute budget exceeded → re-estimate and retry
- Nonce handling for high-frequency transactions
- Blockhash expiration detection

### 5. Program Binary Packaging

**Current**: Programs assumed at `rust/sealevel/target/deploy/*.so`.

**Future**: Package programs with npm package:

```json
{
  "files": ["/dist", "/programs"]
}
```

**Challenge**: Large binaries (~100KB each) increase package size.

### 6. Multi-Signature Support

**Current**: Single signer only.

**Future**: Multi-sig wallets, DAO-controlled upgrade authorities.

**Complexity**: Requires partial signing, signature aggregation.

### 7. Integration Tests with Real Chains

**Current**: Only local validator tests.

**Future**:

- Devnet deployment tests
- Testnet e2e message flow
- Mainnet read-only tests (verify deployed contracts)

### 8. CLI Integration

**Current**: Artifact managers standalone.

**Future**: Hyperlane CLI commands:

```bash
hyperlane svm deploy --chain solanadevnet
hyperlane svm core deploy --config core-config.yaml
hyperlane svm warp deploy --config warp-config.yaml
```

**Blocker**: Deploy SDK integration incomplete.

### 9. Observability & Debugging

**Needed**:

- Transaction simulation before send
- Detailed error messages (decode program errors)
- Logging/metrics for deployment operations
- Explorer link generation (Solscan, Solana Explorer)

### 10. Generated Code TODOs

All generated instructions have:

```typescript
// TODO: Coded error.
```

**Issue**: Codama doesn't generate error handling for instruction encoding failures.

**Impact**: Silent failures if encoding goes wrong (unlikely but possible).

---

## Design Decisions & Rationale

### Why Manual Loader v3 Instructions?

**Decision**: Manually build Loader v3 instructions instead of using `@solana-program/loader-v3`.

**Rationale**:

- `@solana-program/loader-v3` only has IDL, no generated TypeScript client
- Manual implementation gives full control over serialization
- Matches Rust CLI behavior exactly (proven deployment flow)

**Trade-off**: Must maintain if Solana changes Loader v3 protocol.

### Why @solana/kit (web3.js v2)?

**Decision**: Use @solana/kit instead of @solana/web3.js v1.

**Rationale**:

- Codama generates clients for @solana/kit (modern SDK)
- Better type safety (compile-time errors vs. runtime)
- Performance improvements (native WebCrypto)
- Functional composition (easier to test/compose)

**Trade-off**: Incompatible with existing Sealevel adapters (require migration).

### Why Codama Fork?

**Decision**: Use `github:antigremlin/renderers-js#contrib` fork.

**Rationale**:

- Upstream Codama missing import enhancements
- Fork adds ESM specifier support (`import ... from './foo.js'`)

**Trade-off**: Must track upstream, potential merge conflicts.

### Why Combined Codama Generation?

**Decision**: Generate all programs in one Codama tree (`codama-combined.mjs`).

**Rationale**:

- Enables cross-program type references
- Avoids duplicate type definitions
- More efficient tree traversal

**Alternative** (`codama-separate.mjs`): Generate each program separately. Used for debugging.

### Why Salt-Based IGP PDAs?

**Decision**: IGP accounts use salt-based PDA derivation (`sha256('default')`).

**Rationale**:

- Allows multiple IGP instances per program
- Context separation (e.g., 'default', 'testnet')

**Trade-off**: More complex PDA derivation, requires salt coordination.

### Why Preloaded Programs in Tests?

**Decision**: Use `--bpf-program` to preload programs in validator.

**Rationale**:

- Deployment takes ~5 minutes (write chunks, deploy)
- Preloading takes ~30 seconds (validator startup)
- E2E test speed critical for developer UX

**Trade-off**: Programs must be pre-built (`cargo build-sbf`).

### Why No ISigner Interface?

**Decision**: Use custom `SvmSigner` instead of provider-sdk `ISigner`.

**Rationale**:

- `ISigner` assumes EVM patterns (estimateGas, etc.)
- Solana has different signing flow (keypair vs. wallet)
- Function-based pattern matches cosmos-sdk/radix-sdk

**Trade-off**: Not directly compatible with deploy-sdk. Needs adapter.

---

## @solana/web3.js v1 vs v2 (@solana/kit) - Key Differences

### Why V2 Was Created

- **Bundle size reduction**: Modular tree-shakable design (Solana Explorer saw 26% reduction: 311KB → 226KB)
- **Performance**: ~200ms faster confirmation latency; signing/keypair generation 10x faster via native WebCrypto
- **Type safety**: Compile-time verification of transactions, instructions, and accounts; prevents runtime errors
- **Zero dependencies**: Removed all external dependencies; native Ed25519 and BigInt support
- **Developer experience**: Functional composition over class-based OOP

### Key Architectural Changes

| Aspect                | v1                                               | v2                                                                                                      |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Design Pattern**    | Class-based (OOP)                                | Functional composition with pipes                                                                       |
| **Modular Structure** | Monolithic library                               | Split into packages: `@solana/rpc`, `@solana/transactions`, `@solana/accounts`, `@solana/signers`, etc. |
| **Signing**           | `Keypair` class                                  | `KeyPairSigner` + `generateKeyPairSigner()` factory function                                            |
| **Addresses**         | `PublicKey` class                                | `Address` (string type)                                                                                 |
| **Amounts**           | Number                                           | Native `BigInt` (use `1n` syntax)                                                                       |
| **Transactions**      | `Transaction` and `VersionedTransaction` classes | Factory functions: `createTransactionMessage()`, `pipe()` composition                                   |
| **Error Handling**    | Runtime checks                                   | Compile-time type checking                                                                              |
| **Cryptography**      | External libraries                               | Native WebCrypto APIs                                                                                   |

### Transaction Building: Breaking Changes

**V1 Pattern (Class-based):**

```typescript
const tx = new Transaction();
tx.add(instruction);
tx.recentBlockhash = blockhash;
tx.feePayer = payer;
await tx.sign(signer);
```

**V2 Pattern (Functional pipes):**

```typescript
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) =>
    setTransactionMessageLifetimeUsingBlockhash({
      ...tx,
      recentBlockhash: blockhash,
    }),
  (tx) => setTransactionMessageFeePayerSigner(payer, tx),
  (tx) => appendTransactionMessageInstruction(instruction, tx),
);
const signedTx = signTransactionMessageWithSigners([signer], message);
```

**Key differences**:

- Transactions are immutable; pipe creates new versions at each step
- Factory functions (e.g., `sendAndConfirmTransactionFactory()`) for configurable behavior
- Signers passed as array to signing function, replacing previous `.sign()` method

---

## Recommendations for Onboarding

### 1. **Start with Tests**

Read `src/tests/ism.e2e-test.ts` and `src/tests/hook.e2e-test.ts`. Run locally:

```bash
cd typescript/svm-provider
pnpm test:ism
pnpm test:hook
```

**Why**: Tests show full deployment flow, easier to understand than code.

### 2. **Understand Toolchain**

Regenerate IDLs and TypeScript clients:

```bash
# Regenerate IDLs (requires Rust)
cd rust/sealevel
./generate-idls.sh

# Regenerate TypeScript clients
cd ../../typescript/svm-provider
pnpm codama:clean
```

**Why**: Seeing code generation helps understand what's manual vs. auto-generated.

### 3. **Read Program Deployer**

`src/deploy/program-deployer.ts` is self-contained. Study `deployProgram()` flow.

**Why**: Core primitive for all deployments. Understanding Loader v3 protocol critical.

### 4. **Trace ISM Deployment**

Pick one ISM (e.g., Test ISM) and trace:

1. Test: `src/tests/ism.e2e-test.ts`
2. Writer: `src/ism/test-ism.ts`
3. Generated instruction: `src/generated/instructions/initTestIsm.ts`
4. Rust program: `rust/sealevel/programs/test-ism/src/instruction.rs`

**Why**: Shows full stack from TypeScript → Rust.

### 5. **Compare with Existing Adapters**

Compare `src/ism/multisig-ism.ts` with `typescript/sdk/src/providers/sealevel/SealevelMultisigAdapter.ts`.

**Why**: Highlights differences between old (web3.js v1 + manual serialization) and new (web3.js v2 + Codama).

### 6. **Check Open Questions**

Review `SEALEVEL_INTEGRATION.md` "Open Questions" section.

**Why**: Understand blockers for full SDK integration.

---

## Summary of Footguns (Quick Reference)

| #   | Footgun                        | Impact                            | Mitigation                                    |
| --- | ------------------------------ | --------------------------------- | --------------------------------------------- |
| 1   | Editing generated code         | Changes overwritten on rebuild    | Never edit `src/generated/`                   |
| 2   | Codama fork divergence         | Missing features, merge conflicts | Track upstream releases                       |
| 3   | 8-byte discriminator mismatch  | Instruction parsing fails         | Use generated builders only                   |
| 4   | PDA seed mismatch              | Account not found errors          | Match Rust `pda_seeds!()` exactly             |
| 5   | Domain enumeration gap         | Incomplete multisig ISM reads     | Document required domain IDs                  |
| 6   | Transaction size exceeded      | Deployment fails                  | Keep `WRITE_CHUNK_SIZE ≤ 900`                 |
| 7   | Mixed @solana/kit + web3.js v1 | Type errors                       | Use conversion helpers                        |
| 8   | Docker on Apple Silicon        | Test failures                     | Require local binary, error with instructions |
| 9   | Manual Loader v3 outdated      | Protocol changes break deploy     | Test against multiple Solana versions         |
| 10  | Hardcoded compute units        | `Compute budget exceeded`         | Implement simulation-based estimation         |

---

## Investigation Metadata

**Branch**: `andrey/solana-port`
**Investigation Date**: 2026-02-19
**Total Lines of Code**: ~16,300 (excluding generated code)
**Files Analyzed**: 120+
**Key Commits**:

- `081828f0b` - Docker validator improvements
- `b509e97d7` - Program deployer implementation
- `7282e05ed` - Core/ISM/hook adjustments
- `2a1bc929a` - Test setup

**Status**: Implementation solid for ISM/Hook deployments. Token support and SDK integration remain TODO.

**Next Steps for Developer**:

1. Run e2e tests locally
2. Review program deployer implementation
3. Understand Codama generation pipeline
4. Plan token warp route implementation
5. Design provider-sdk integration strategy
