# Rust Token Init Implementation - Complete Analysis

**Date**: 2026-02-19
**Critical**: This analysis reveals the agent's implementation has MAJOR issues

---

## CRITICAL FINDING #1: Wrong Token PDA Seeds

**Agent implementation used:**
```typescript
seeds: [getUtf8Encoder().encode('hyperlane_token')]
```

**Actual Rust seeds** (from `rust/sealevel/libraries/hyperlane-sealevel-token/src/processor.rs` lines 46-55):
```rust
macro_rules! hyperlane_token_pda_seeds {
    () => {{
        &[
            b"hyperlane_message_recipient",
            b"-",
            b"handle",
            b"-",
            b"account_metas",
        ]
    }};
}
```

**Impact**: ALL token queries will fail - wrong PDA address derivation!

---

## CRITICAL FINDING #2: Init Creates Empty Accounts, SPL Instructions Required

### Synthetic Token Init Flow

**What Init DOES:**
1. Creates token PDA account (with HyperlaneToken data)
2. Creates dispatch authority PDA
3. Creates EMPTY mint PDA account (owned by spl_token_2022, size 234 bytes)
4. Creates ATA payer PDA (empty, owned by system program)

**What Init DOES NOT DO:**
- ❌ Does NOT initialize the mint
- ❌ Does NOT create metadata
- ❌ Does NOT set mint authority

**From SyntheticPlugin::initialize** (lines 129-131):
> "Note this will create a PDA account that will serve as the mint, so the transaction calling this instruction must include a **subsequent instruction initializing the mint** with the SPL token 2022 program."

**This means TypeScript must send ONE transaction with MULTIPLE instructions:**
```typescript
const tx = {
  instructions: [
    initTokenInstruction,        // Creates empty mint PDA
    initializeMintInstruction,   // SPL: Initialize the mint
    initializeMetadataInstruction, // SPL: Set name/symbol (optional)
  ]
};
```

### Native Token Init Flow

**What Init DOES:**
1. Creates token PDA account
2. Creates dispatch authority PDA
3. Creates native collateral PDA (empty, owned by system program)

**What TypeScript needs:** Just Init instruction - no SPL operations needed.

### Collateral Token Init Flow

**What Init DOES:**
1. Creates token PDA account
2. Creates dispatch authority PDA
3. Calls `get_account_data_size` to determine escrow size
4. Creates escrow PDA account (owned by SPL program)
5. Calls `initialize_account` to initialize escrow as token account
6. Creates ATA payer PDA

**What TypeScript needs:**
- Init instruction (program handles escrow creation internally via CPI)
- NO additional SPL operations needed

---

## Correct PDA Seeds (from Rust macros)

### Token PDA
**Seeds**: `["hyperlane_message_recipient", "-", "handle", "-", "account_metas"]`
**Source**: `hyperlane_token_pda_seeds!()` macro
**Why this name**: Doubles as handle account metas PDA for message recipient interface

### Synthetic Mint PDA
**Seeds**: `["hyperlane_token", "-", "mint"]`
**Source**: `hyperlane_token_mint_pda_seeds!()` macro (line 33-40)
**Owner**: spl_token_2022 program

### Synthetic ATA Payer PDA
**Seeds**: `["hyperlane_token", "-", "ata_payer"]`
**Source**: `hyperlane_token_ata_payer_pda_seeds!()` macro (line 43-52)
**Owner**: system program

### Native Collateral PDA
**Seeds**: `["hyperlane_token", "-", "native_collateral"]`
**Source**: `hyperlane_token_native_collateral_pda_seeds!()` macro
**Owner**: system program

### Collateral Escrow PDA
**Seeds**: `["hyperlane_token", "-", "escrow"]`
**Source**: `hyperlane_token_escrow_pda_seeds!()` macro (line 29-36)
**Owner**: spl_token or spl_token_2022 program

### Collateral ATA Payer PDA
**Seeds**: `["hyperlane_token", "-", "ata_payer"]`
**Source**: Same macro as synthetic
**Owner**: system program

---

## Init Instruction Account Structure

**From `init_instruction()` builder** (rust/sealevel/libraries/hyperlane-sealevel-token/src/instruction.rs):

**Base accounts (all token types):**
```
0. [executable] System program
1. [writable] Token PDA
2. [writable] Dispatch authority PDA
3. [signer] Payer (becomes initial owner)
```

**Plugin-specific accounts (4..N):**

**Synthetic:**
```
4. [writable] Mint PDA (will be created by Init)
5. [writable] ATA payer PDA (will be created by Init)
```

**Native:**
```
4. [writable] Native collateral PDA (will be created by Init)
```

**Collateral:**
```
4. [executable] SPL token program (Token or Token-2022)
5. [] Mint (existing, not created)
6. [executable] Rent sysvar
7. [writable] Escrow PDA (will be created by Init)
8. [writable] ATA payer PDA (will be created by Init)
```

**Key insight**: Init instruction builder in Rust returns instruction with ONLY accounts 0-3. Plugin-specific accounts must be added by the calling code.

---

## What TypeScript Must Do

### For Synthetic Token

**Transaction 1: Init + SPL Mint Initialize**
```typescript
// Derive PDAs
const tokenPda = derivePda(programId, ["hyperlane_message_recipient", "-", "handle", "-", "account_metas"]);
const dispatchAuthPda = derivePda(programId, mailbox dispatch seeds);
const mintPda = derivePda(programId, ["hyperlane_token", "-", "mint"]);
const ataPayerPda = derivePda(programId, ["hyperlane_token", "-", "ata_payer"]);

// Build Init instruction
const initIx = {
  programAddress: programId,
  accounts: [
    { address: SYSTEM_PROGRAM, role: 0 },      // executable
    { address: tokenPda, role: 1 },            // writable
    { address: dispatchAuthPda, role: 1 },     // writable
    { address: payer, role: 3 },               // writable signer
    { address: mintPda, role: 1 },             // writable (plugin account)
    { address: ataPayerPda, role: 1 },         // writable (plugin account)
  ],
  data: [0, ...encodeInitProxy(initArgs)]
};

// Build SPL Token-2022 InitializeMint instruction
const initMintIx = createInitializeMintInstruction(
  mintPda,
  decimals,
  mintPda,  // Mint authority is the mint PDA itself
  null,     // No freeze authority
  TOKEN_2022_PROGRAM_ID
);

// Optional: Initialize metadata
const initMetadataIx = ...;

// Send in ONE transaction
await signer.signAndSend(rpc, {
  instructions: [initIx, initMintIx, initMetadataIx]
});
```

**Transaction 2-N: Configuration**
```
- Enroll routers
- Set destination gas
- Set ISM
```

### For Native Token

**Transaction 1: Init**
```typescript
const tokenPda = derivePda(...);  // Same seeds
const dispatchAuthPda = derivePda(...);
const nativeCollateralPda = derivePda(programId, ["hyperlane_token", "-", "native_collateral"]);

const initIx = {
  programAddress: programId,
  accounts: [
    { address: SYSTEM_PROGRAM, role: 0 },
    { address: tokenPda, role: 1 },
    { address: dispatchAuthPda, role: 1 },
    { address: payer, role: 3 },
    { address: nativeCollateralPda, role: 1 },  // Plugin account
  ],
  data: [0, ...encodeInitProxy(initArgs)]
};
```

### For Collateral Token

**Transaction 1: Init (program handles escrow via CPI)**
```typescript
const tokenPda = derivePda(...);
const dispatchAuthPda = derivePda(...);
const escrowPda = derivePda(programId, ["hyperlane_token", "-", "escrow"]);
const ataPayerPda = derivePda(programId, ["hyperlane_token", "-", "ata_payer"]);

const initIx = {
  programAddress: programId,
  accounts: [
    { address: SYSTEM_PROGRAM, role: 0 },
    { address: tokenPda, role: 1 },
    { address: dispatchAuthPda, role: 1 },
    { address: payer, role: 3 },
    { address: splProgramId, role: 0 },        // Token or Token-2022
    { address: mint, role: 0 },                 // Existing mint (readonly)
    { address: RENT_SYSVAR, role: 0 },         // Rent sysvar
    { address: escrowPda, role: 1 },           // Will be created
    { address: ataPayerPda, role: 1 },         // Will be created
  ],
  data: [0, ...encodeInitProxy(initArgs)]
};

// Program handles escrow initialization via CPI - no additional instructions needed
```

---

## Account Roles (@solana/kit)

```
0 = readonly
1 = writable
2 = signer (readonly)
3 = writable + signer
```

---

## Comparison: Agent vs Correct Implementation

| Aspect | Agent Implementation | Correct Implementation |
|--------|---------------------|------------------------|
| **Token PDA seeds** | `["hyperlane_token"]` | `["hyperlane_message_recipient", "-", "handle", "-", "account_metas"]` ❌ |
| **Mint PDA seeds** | `["hyperlane_message-recipient-mint"]` | `["hyperlane_token", "-", "mint"]` ❌ |
| **Escrow PDA seeds** | `["hyperlane_message-recipient-escrow"]` | `["hyperlane_token", "-", "escrow"]` ❌ |
| **Init accounts** | Empty `[]` | Must include 6 accounts for synthetic ❌ |
| **SPL operations** | Separate transactions | Same transaction as Init ❌ |
| **Library used** | `@solana/spl-token` (web3.js v1) | Should use `@solana-program/token-2022` ✅ or manual |

**Score**: 0/6 - Complete rewrite needed

---

## Correct TypeScript Implementation Strategy

### Option A: Use @solana-program/token-2022 (Recommended)

**Check if available:**
```bash
grep "@solana-program/token-2022" typescript/svm-provider/package.json
```

**If available:** Use it for SPL operations (returns @solana/kit compatible types)

### Option B: Manual SPL Instructions (Fallback)

Build SPL instructions manually like program-deployer.ts does for Loader v3:
- InitializeMint discriminator: 20
- InitializeAccount discriminator: 1
- Use `@solana/kit` account roles

### Option C: Minimal Approach (MVP)

**For MVP testing:**
1. Fix PDA seeds
2. Build Init instruction with correct accounts
3. Skip SPL metadata operations (use Rust CLI to initialize mint externally)
4. Test just Init + config operations

---

## Implementation Priority

**MUST FIX (Critical):**
1. ✅ Token PDA seeds - WRONG in all files
2. ✅ Mint PDA seeds - WRONG in synthetic-token.ts
3. ✅ Escrow PDA seeds - WRONG in collateral-token.ts
4. ✅ Init instruction accounts - Missing in all files
5. ✅ Account roles - Must use correct roles (0/1/2/3)

**SHOULD FIX (Important):**
6. ✅ SPL library - Use @solana-program/token-2022 or manual
7. ✅ Transaction bundling - Init + SPL in same tx for synthetic
8. ✅ Remove dynamic require() - Use static imports
9. ✅ Remove unused imports

**NICE TO HAVE:**
10. Metadata initialization (can be done externally for MVP)
11. Proper error messages
12. Logging/debugging

---

## Recommended Action Plan

**Step 1: Stop and Rewrite** (2-3 hours)
- Current implementation fundamentally flawed (wrong PDA seeds)
- Fix warp-query.ts PDA derivation
- Rewrite token writers with correct account structures

**Step 2: Simplify for MVP** (1-2 hours)
- Focus on Native token first (simplest - no SPL operations)
- Build Init with correct 5 accounts
- Test Init + config operations

**Step 3: Add Synthetic** (2-3 hours)
- Build Init with 6 accounts
- Add SPL InitializeMint instruction (same transaction)
- Test

**Step 4: Add Collateral** (2-3 hours)
- Build Init with 9 accounts
- Test (program handles escrow via CPI)

**Total estimated**: 8-11 hours to fully working implementation

---

## Files That Need Rewriting

1. **warp-query.ts** - Fix `getHyperlaneTokenPda()` seeds ❌
2. **synthetic-token.ts** - Fix PDA seeds, Init accounts, SPL bundling ❌
3. **native-token.ts** - Fix Init accounts ❌
4. **collateral-token.ts** - Fix PDA seeds, Init accounts ❌
5. **warp-tx.ts** - OK as-is ✅
6. **warp-artifact-manager.ts** - Minor fixes ⚠️
7. **index.ts** - OK as-is ✅

**Files to rewrite**: 4 out of 7 (60%)

---

## Next Steps

Should we:
1. **Fix immediately** - Rewrite the 4 broken files with correct implementation?
2. **Document first** - Create detailed spec of correct implementation, then implement?
3. **Incremental** - Fix PDA seeds first, test queries, then fix Init?

**Recommendation**: Option 3 (Incremental) - Fix PDA seeds first and verify we can read existing tokens, then tackle Init implementation.
