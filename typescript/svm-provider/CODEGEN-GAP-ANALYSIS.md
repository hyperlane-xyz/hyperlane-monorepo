# Critical Gap in Solana IDL Code Generation

**Date**: 2026-02-19
**Severity**: HIGH - Blocks warp route deployments
**Deadline**: Friday (3 days)

---

## Executive Summary

**The Problem**: Hyperlane Solana programs process **multiple instruction sets with different discriminators**, but Shank IDL generation can only represent **one instruction enum per program**. Interface instructions (MessageRecipientInstruction, InterchainSecurityModuleInstruction) are completely missing from generated IDLs and TypeScript clients.

**Impact**:

- ❌ Token warp routes cannot be deployed (missing Handle, InterchainSecurityModule instructions)
- ❌ ISM programs incomplete (missing Verify, Type instructions)
- ⚠️ Generated TypeScript clients only work for ~50% of program functionality

**Current State**:

- Programs affected: 6 out of 12 (Token, Token-Native, Token-Collateral, HelloWorld, Test-ISM, Test-Send-Receiver)
- Instructions missing: ~15 interface instructions across 2 interfaces
- Custom discriminators: Not representable in Shank annotations

---

## Problem Deep Dive

### 1. Programs with Multiple Instruction Sets

| Program              | Own Instructions               | Interface Instructions         | Status               |
| -------------------- | ------------------------------ | ------------------------------ | -------------------- |
| **Token**            | 8 (Init, TransferRemote, etc.) | 4 (MessageRecipient interface) | ❌ Interface missing |
| **Token-Native**     | 8                              | 4 (MessageRecipient interface) | ❌ Interface missing |
| **Token-Collateral** | 8                              | 4 (MessageRecipient interface) | ❌ Interface missing |
| **HelloWorld**       | 4 (Init, SendHelloWorld, etc.) | 4 (MessageRecipient interface) | ❌ Interface missing |
| **Test-ISM**         | 2 (Init, SetAccept)            | 3 (ISM interface)              | ❌ Interface missing |
| **Mailbox**          | 12                             | 0 (none)                       | ✅ Complete          |
| **IGP**              | 11                             | 0 (none)                       | ✅ Complete          |
| **Multisig-ISM**     | 4                              | 0 (none)                       | ✅ Complete          |

**Total Missing**: 15+ interface instructions across 6 programs

### 2. Interface Instructions Missing from IDLs

#### MessageRecipientInstruction Interface

**Discriminators** (8-byte hash-based):

- `InterchainSecurityModule`: `[45, 18, 245, 87, 234, 46, 246, 15]`
- `InterchainSecurityModuleAccountMetas`: `[190, 214, 218, 129, 67, 97, 4, 76]`
- `Handle(HandleInstruction)`: `[33, 210, 5, 66, 196, 212, 239, 142]`
- `HandleAccountMetas(HandleInstruction)`: `[194, 141, 30, 82, 241, 41, 169, 52]`

**Used by**: Token, Token-Native, Token-Collateral, HelloWorld

**Critical for warp routes**: `Handle` instruction processes incoming messages from Mailbox.

#### InterchainSecurityModuleInstruction Interface

**Discriminators** (8-byte hash-based):

- `Type`: `[105, 97, 97, 88, 63, 124, 106, 18]`
- `Verify(VerifyInstruction)`: `[243, 53, 214, 0, 208, 18, 231, 67]`
- `VerifyAccountMetas(VerifyInstruction)`: `[200, 65, 157, 12, 89, 255, 131, 216]`

**Used by**: Test-ISM (and would be used by Multisig-ISM if it implemented interface properly)

### 3. Why Shank Cannot Represent This

**Shank Limitation**: Can only annotate ONE `#[derive(ShankInstruction)]` enum per program.

**What happens in token program**:

```rust
// ❌ Shank only sees this enum (generates IDL)
#[derive(ShankInstruction)]
pub enum Instruction {
    Init(Init),
    TransferRemote(TransferRemote),
    // ... 8 variants total
}

// ❌ Shank CANNOT see this (processor uses it but not annotated)
pub enum MessageRecipientInstruction {
    Handle(HandleInstruction),
    InterchainSecurityModule,
    // ... 4 variants total
}
```

**Processor Code** (what actually runs):

```rust
pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Try MessageRecipientInstruction first (uses interface discriminators)
    if let Ok(instruction) = MessageRecipientInstruction::decode(data) {
        return match instruction { ... };
    }

    // Fall back to program-specific instructions
    match Instruction::decode(data)? { ... }
}
```

**The Gap**: Shank generates IDL for `Instruction`, but processor uses TWO enums with different discriminators.

### 4. Custom Discriminator Problem

**Two Discriminator Schemes**:

| Scheme                 | Used By                | Format              | Example                                         |
| ---------------------- | ---------------------- | ------------------- | ----------------------------------------------- |
| **Borsh enum variant** | Program instructions   | `u8` (0-255)        | Token::Init = 0                                 |
| **Hash-based 8-byte**  | Interface instructions | `[u8; 8]` from hash | Handle = `[33, 210, 5, 66, 196, 212, 239, 142]` |

**Shank Assumption**: Single discriminator scheme per program. Cannot represent hash-based discriminators.

**Generated IDL** (from token program):

```json
{
  "instructions": [
    { "name": "Init", "discriminant": { "type": "u8", "value": 0 } },
    { "name": "TransferRemote", "discriminant": { "type": "u8", "value": 1 } }
  ]
}
```

**Missing from IDL**:

```json
// This SHOULD exist but doesn't
{
  "instructions": [
    // ... program instructions above
    {
      "name": "Handle",
      "discriminant": {
        "type": "[u8; 8]",
        "value": [33, 210, 5, 66, 196, 212, 239, 142]
      }
    }
  ]
}
```

### 5. Account Wrapper Gap

**Current Code** (in token programs):

```rust
pub type HypTokenAccount = AccountData<HypToken>;
```

**What Shank generates**:

- ✅ `HypToken` struct
- ❌ `AccountData<T>` wrapper (generic wrapper from library)

**Why it matters**: TypeScript clients need to understand account initialization flags and serialization wrappers.

---

## Root Cause Analysis

### Why This Architecture Exists

**1. Solana Interface Pattern**

- Programs implement interfaces via instruction routing
- Interfaces defined in shared libraries (`message-recipient-interface`, `ism-interface`)
- Each interface has unique discriminators to avoid collisions

**2. Historical Context**

- Hyperlane Solana programs predate Shank/Codama
- Built as native Solana programs (not Anchor)
- Interface pattern established in production (mainnet)
- Cannot rewrite programs without breaking deployments

**3. Shank Design**

- Built for simple programs with single instruction enum
- Assumes Anchor-style discriminators (single byte or hash-based, but not mixed)
- Cannot introspect across crate boundaries (interfaces in separate crates)

### Why Codama Cannot Fix This

**Codama Input**: Shank-generated IDL (Anchor-compatible JSON)

**Codama Limitation**: If the interface instructions aren't in the IDL, Codama cannot generate TypeScript clients for them.

**Anchor's Solution**: `#[interface]` macro (requires Anchor framework, not available for native programs)

---

## Impact on Warp Route Deployments

### Critical Path for Friday Deadline

**Required for Token Warp Routes**:

1. ✅ Deploy token program (works with current code)
2. ✅ Initialize token program via `Init` instruction (generated client works)
3. ❌ **Handle incoming messages** via `Handle` instruction (NO CLIENT)
4. ❌ **Query ISM** via `InterchainSecurityModule` instruction (NO CLIENT)
5. ✅ Configure gas settings via `SetDestinationGasConfigs` (generated client works)

**Blocked Operations**:

- Processing inbound token transfers (Handle instruction)
- ISM verification for security (InterchainSecurityModule, Verify instructions)
- Account meta queries for dynamic account resolution

**Workaround Viability**: Can deploy and configure, but cannot process messages end-to-end.

---

## Solution Options

### Option 1: Manual TypeScript Clients (FASTEST)

**Timeline**: 1-2 days
**Effort**: Medium

**Approach**:

1. Write manual instruction builders for interface instructions
2. Keep generated clients for program-specific instructions
3. Create hybrid artifact managers that use both

**Pros**:

- ✅ Fastest solution (can hit Friday deadline)
- ✅ Full control over discriminator handling
- ✅ No dependency on Shank/Codama fixes

**Cons**:

- ❌ No type generation benefits for interface instructions
- ❌ Manual maintenance burden (keep in sync with Rust)
- ❌ Duplicates logic from Rust interface definitions

**Implementation**:

```typescript
// typescript/svm-provider/src/interfaces/message-recipient.ts
export function getHandleInstruction(params: {
  payer: Address;
  mailbox: Address;
  recipient: Address;
  message: Uint8Array;
}): IInstruction {
  const discriminator = new Uint8Array([33, 210, 5, 66, 196, 212, 239, 142]);
  const data = new Uint8Array(discriminator.length + message.length);
  data.set(discriminator, 0);
  data.set(encodeHandleInstruction(params), discriminator.length);

  return {
    programAddress: params.recipient,
    accounts: [
      /* ... manual account list */
    ],
    data,
  };
}
```

**Files to create**: ~6 files (one per interface) × ~100 lines each = ~600 lines

---

### Option 2: Manually Write Comprehensive IDLs (MEDIUM)

**Timeline**: 2-3 days
**Effort**: Medium-High

**Approach**:

1. Manually author IDL JSON files with ALL instructions (program + interface)
2. Use Codama to generate TypeScript clients from manual IDLs
3. Maintain manual IDLs alongside Rust code

**Pros**:

- ✅ Maintains code generation benefits
- ✅ Type safety from Codama-generated clients
- ✅ Single source of truth (IDL)

**Cons**:

- ❌ Manual IDL authoring error-prone
- ❌ Must keep IDLs in sync with Rust (2x maintenance)
- ❌ Loses automated Shank generation for program instructions
- ❌ Discriminator format may not be expressible in Anchor IDL JSON

**Blocker**: Anchor IDL format may not support 8-byte array discriminators (spec uses `"u8"` type). Need to verify if Codama can parse custom discriminator formats.

**Example Manual IDL** (hypothetical):

```json
{
  "instructions": [
    {
      "name": "Init",
      "discriminant": { "type": "u8", "value": 0 }
    },
    {
      "name": "Handle",
      "discriminant": {
        "type": "custom",
        "value": [33, 210, 5, 66, 196, 212, 239, 142]
      }
    }
  ]
}
```

**Risk**: Unknown if Codama supports this discriminator format.

---

### Option 3: Hybrid Approach (RECOMMENDED)

**Timeline**: 1.5-2 days
**Effort**: Medium

**Approach**:

1. **Keep Shank-generated IDLs** for program-specific instructions
2. **Manual TypeScript clients** for interface instructions (reusable across programs)
3. **Unified artifact managers** that orchestrate both

**Pros**:

- ✅ Preserves type generation for program instructions
- ✅ Fast implementation (interface clients reusable)
- ✅ Clear separation: generated vs manual
- ✅ Can incrementally improve (replace manual with generated later)

**Cons**:

- ⚠️ Mixed codegen strategy (documentation overhead)
- ⚠️ Manual interface clients need maintenance

**Architecture**:

```
typescript/svm-provider/src/
├── generated/              # Codama-generated (program instructions)
│   ├── instructions/
│   │   ├── init.ts
│   │   └── transferRemote.ts
│   └── accounts/
├── interfaces/             # Manual (interface instructions)
│   ├── message-recipient.ts
│   └── ism.ts
└── token/                  # Artifact managers
    ├── token-reader.ts     # Uses generated + manual
    └── token-writer.ts     # Uses generated + manual
```

**Code Example**:

```typescript
// token/token-writer.ts (HYBRID)
import { getTransferRemoteInstruction } from '../generated/instructions/transferRemote.js';
import { getHandleInstruction } from '../interfaces/message-recipient.js';

// interfaces/message-recipient.ts (MANUAL)
export const MESSAGE_RECIPIENT_DISCRIMINATORS = {
  Handle: new Uint8Array([33, 210, 5, 66, 196, 212, 239, 142]),
  InterchainSecurityModule: new Uint8Array([45, 18, 245, 87, 234, 46, 246, 15]),
} as const;

export function getHandleInstruction(
  params: HandleInstructionParams,
): IInstruction {
  const data = new Uint8Array(8 + params.message.length);
  data.set(MESSAGE_RECIPIENT_DISCRIMINATORS.Handle, 0);
  // ... encode instruction data

  return {
    programAddress: params.recipient,
    accounts: deriveHandleAccounts(params),
    data,
  };
}

export class SvmTokenWriter {
  async transferRemote(config: TransferConfig): Promise<SvmReceipt> {
    // Use GENERATED client for program instruction
    const transferIx = getTransferRemoteInstruction({
      sender: this.signer.address,
      recipient: config.recipient,
      amount: config.amount,
    });

    return this.signer.signAndSend(this.rpc, { instructions: [transferIx] });
  }

  async handleIncomingMessage(message: HyperlaneMessage): Promise<SvmReceipt> {
    // Use MANUAL client for interface instruction
    const handleIx = getHandleInstruction({
      payer: this.signer.address,
      mailbox: this.programAddresses.mailbox,
      recipient: this.programAddresses.token,
      message: message.encode(),
    });

    return this.signer.signAndSend(this.rpc, { instructions: [handleIx] });
  }
}
```

**Implementation Checklist**:

- [ ] Create `interfaces/message-recipient.ts` (~150 lines)
  - [ ] Define discriminator constants
  - [ ] Implement `getHandleInstruction`
  - [ ] Implement `getInterchainSecurityModuleInstruction`
  - [ ] Implement account derivation helpers
- [ ] Create `interfaces/ism.ts` (~100 lines)
  - [ ] Define discriminator constants
  - [ ] Implement `getVerifyInstruction`
  - [ ] Implement `getTypeInstruction`
- [ ] Update token artifact managers to use hybrid approach (~200 lines)
- [ ] Write unit tests for manual instruction builders (~100 lines)
- [ ] Document the hybrid strategy in README

**Total**: ~550 lines of manual code

---

### Option 4: Switch to Anchor Framework (REJECTED)

**Timeline**: 2-3 weeks
**Effort**: Very High

**Approach**: Rewrite all programs using Anchor framework, use `#[interface]` macro

**Pros**:

- ✅ Anchor natively supports interface instructions
- ✅ Full IDL generation with `#[interface]` macro
- ✅ Modern Solana development patterns

**Cons**:

- ❌ **BREAKS PRODUCTION** - Programs deployed on mainnet
- ❌ Requires complete program rewrites
- ❌ Incompatible with existing deployments
- ❌ Far exceeds Friday deadline (weeks of work)
- ❌ Anchor programs have different account management patterns

**Decision**: REJECTED - Not viable for production protocol

---

### Option 5: Extend Shank/Codama (FUTURE WORK)

**Timeline**: 3-4 weeks
**Effort**: Very High

**Approach**: Contribute to Shank to support multiple instruction enums

**Required Changes**:

1. Extend Shank to annotate multiple instruction enums
2. Modify IDL format to represent multiple instruction groups
3. Update Codama to generate clients from multi-enum IDLs

**Pros**:

- ✅ Long-term sustainable solution
- ✅ Benefits entire Solana ecosystem
- ✅ Maintains automated code generation

**Cons**:

- ❌ **FAR TOO SLOW** - Cannot hit Friday deadline
- ❌ Requires upstream contributions (not in our control)
- ❌ Breaking changes to IDL format
- ❌ Codama may not accept discriminator format changes

**Decision**: Good long-term goal, not viable for immediate need

---

## Recommendation: Hybrid Approach (Option 3)

### Why This Is Best for Friday Deadline

**1. Timeline**:

- Day 1 (Wed): Implement interface instruction builders (~4-6 hours)
- Day 2 (Thu): Update artifact managers, write tests (~4-6 hours)
- Day 3 (Fri): Integration testing, bug fixes (~4 hours)

**2. Risk Assessment**:

- Low risk: Manual instruction builders well-understood (existing Rust code as reference)
- Medium risk: Account derivation logic may have edge cases
- Mitigation: Comprehensive unit tests against known good transactions

**3. Incremental Path**:

- Short-term: Manual interface clients (unblocks Friday)
- Medium-term: Investigate Codama custom discriminators
- Long-term: Contribute Shank multi-enum support

### Implementation Priority

**Critical Path** (must have for warp routes):

1. ✅ `MessageRecipientInstruction::Handle` - Process incoming messages
2. ✅ `MessageRecipientInstruction::InterchainSecurityModule` - Get ISM address
3. ⚠️ `InterchainSecurityModuleInstruction::Verify` - Verify message (used by ISMs)

**Nice-to-have** (can defer):

- `MessageRecipientInstruction::HandleAccountMetas` - Dynamic account resolution
- `InterchainSecurityModuleInstruction::VerifyAccountMetas` - Dynamic account resolution
- `InterchainSecurityModuleInstruction::Type` - Query ISM type

**Start with**: `Handle` instruction only (unblocks token transfers). Add others as needed.

---

## Action Plan

### Wednesday (Day 1)

**Morning (4 hours)**:

1. Create `typescript/svm-provider/src/interfaces/message-recipient.ts`
2. Implement `getHandleInstruction` builder
3. Implement account derivation for Handle instruction
4. Reference: `rust/sealevel/libraries/message-recipient-interface/src/lib.rs`

**Afternoon (3 hours)**: 5. Write unit tests for Handle instruction encoding 6. Test against known good transaction from devnet/testnet 7. Document discriminator constants and their source (hash values)

### Thursday (Day 2)

**Morning (4 hours)**:

1. Update `SvmTokenWriter` to use `getHandleInstruction`
2. Implement `SvmTokenReader` methods for querying ISM
3. Add helper methods for deriving token program PDAs

**Afternoon (3 hours)**: 4. Write e2e test: deploy token → transfer → handle incoming message 5. Test against local validator with preloaded programs 6. Fix bugs discovered during testing

### Friday (Day 3)

**Morning (3 hours)**:

1. Integration testing with full warp route deployment
2. Test message roundtrip: chain A → chain B → Handle on B
3. Performance testing (ensure transactions under size limit)

**Afternoon (2 hours)**: 4. Documentation: Hybrid strategy explanation in README 5. Code review with team 6. Final bug fixes and polish

---

## Validation Criteria

**Success Metrics**:

- ✅ Can deploy token warp route on local validator
- ✅ Can process incoming messages via Handle instruction
- ✅ Transaction builds successfully (under 1232 byte limit)
- ✅ Discriminators match Rust constants exactly
- ✅ E2E test passes: EVM → Solana token transfer

**Testing Checklist**:

- [ ] Unit test: Handle instruction encoding matches Rust
- [ ] Unit test: Account list matches processor expectations
- [ ] E2E test: Deploy token program
- [ ] E2E test: Initialize with mailbox
- [ ] E2E test: Transfer tokens remotely
- [ ] E2E test: Handle incoming message
- [ ] E2E test: Query ISM address
- [ ] Integration test: Full message roundtrip

---

## Long-Term Strategy

**Phase 1** (This Week): Manual interface clients for Handle instruction
**Phase 2** (Next Sprint): Complete interface coverage (Verify, Type, etc.)
**Phase 3** (Future): Investigate Codama custom discriminator support
**Phase 4** (Long-term): Contribute multi-enum support to Shank

**Maintenance Plan**:

- Keep manual clients in `interfaces/` directory
- Document "DO NOT EDIT" warnings in generated code
- Add CI check: discriminator constants match Rust
- Quarterly review: Check if Shank/Codama have new features

---

## Risks & Mitigations

| Risk                                | Impact | Likelihood | Mitigation                        |
| ----------------------------------- | ------ | ---------- | --------------------------------- |
| Discriminator mismatch              | HIGH   | Medium     | Unit tests against known good txs |
| Account list wrong                  | HIGH   | Medium     | Compare with Rust processor code  |
| Transaction size exceeded           | Medium | Low        | Test with max-size messages       |
| Manual code drift from Rust         | Medium | High       | CI checks + documentation         |
| Team unfamiliar with hybrid pattern | Low    | Medium     | Clear documentation + code review |

---

## Alternatives Considered and Rejected

**Why not pure manual clients?**

- Wastes Shank/Codama work already done
- Loses type safety for program instructions
- More maintenance burden

**Why not pure IDL authoring?**

- Anchor IDL format may not support 8-byte discriminators
- Loses automated Shank generation
- Higher error risk (manual JSON editing)

**Why not wait for Shank fix?**

- Timeline too long (weeks)
- Not in our control
- May never be accepted upstream

**Why not Anchor rewrite?**

- Breaks production deployments
- Complete program rewrites
- Incompatible with existing infrastructure

---

## Conclusion

The **Hybrid Approach** (Option 3) is the only viable solution for the Friday deadline. It balances speed (1.5-2 days), risk (low-medium), and maintainability (clear separation of concerns).

**Key Success Factors**:

1. Start immediately (Wednesday morning)
2. Focus on Handle instruction first (critical path)
3. Comprehensive testing (unit + e2e)
4. Clear documentation of hybrid strategy

**Recommended Action**: Proceed with Hybrid Approach implementation starting Wednesday morning.
