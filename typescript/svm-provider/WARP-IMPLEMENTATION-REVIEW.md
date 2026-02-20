# Solana Warp Token Implementation Review

**Date**: 2026-02-19
**Branch**: xeno/solana-warp-artifacts
**Status**: Implementation complete, has build errors

---

## What Was Implemented (1,525 lines)

### ✅ warp-query.ts (274 lines) - WORKING
- `HyperlaneTokenData<T>` type for decoded token accounts
- `fetchSyntheticToken()`, `fetchNativeToken()`, `fetchCollateralToken()`
- `detectWarpTokenType()` - Auto-detect token type from account data
- `getHyperlaneTokenPda()` - Derive token PDA with seeds `["hyperlane_token"]`
- Option unwrapping helpers for @solana/kit decoder output
- Router conversion: hex ↔ bytes
- **No build errors** ✅

### ✅ warp-tx.ts (194 lines) - WORKING
- `getEnrollRemoteRoutersIx()` - Enroll/update routers
- `getUnenrollRemoteRoutersIx()` - Remove routers
- `getSetDestinationGasConfigsIx()` - Set gas per domain
- `getSetIsmIx()` - Update ISM address
- `getTransferOwnershipIx()` - Transfer owner
- `computeWarpTokenUpdateInstructions()` - Diff current vs expected, generate update txs
- Uses generated instruction data encoders
- **No build errors** ✅

### ❌ synthetic-token.ts (318 lines) - HAS ERRORS
**Implementation:**
- `SvmSyntheticTokenReader` - Reads synthetic token config from chain
- `SvmSyntheticTokenWriter` - Full deployment:
  1. Check token PDA not initialized
  2. Call Init with InitProxy args (mailbox, ISM, IGP, decimals)
  3. Create SPL Token-2022 mint + metadata
  4. Enroll routers
  5. Set destination gas
  6. Set ISM
- `getSyntheticMintPda()` - Derive mint PDA
- `getInitSyntheticInstruction()` - Manually build Init instruction

**Issues:**
1. **Line 65**: `require()` instead of static import
2. **Line 11**: `TOKEN_2022_PROGRAM_ID` imported but unused
3. **Line 35**: `getHyperlaneTokenPda` imported but unused
4. **Line 54**: Wrong PDA seeds: `"hyperlane_message-recipient-mint"` should be `"hyperlane_token-mint"` (from Rust: `hyperlane_token_mint_pda_seeds!()`)
5. **Lines 194-227**: SPL Token-2022 operations incomplete/incorrect:
   - Uses `KeyPairSigner` type incorrectly (line 194-197)
   - Missing actual mint creation account setup
   - Missing metadata initialization instruction import

### ❌ native-token.ts (249 lines) - HAS ERRORS
**Implementation:**
- `SvmNativeTokenReader` - Reads native token config
- `SvmNativeTokenWriter` - Deployment:
  1. Check token PDA
  2. Call Init (no SPL token needed)
  3. Enroll routers
  4. Set gas
  5. Set ISM
- `getInitNativeInstruction()` - Build Init instruction

**Issues:**
1. **Line 46**: `require()` instead of static import
2. **Line 27**: `getHyperlaneTokenPda` imported but unused

### ❌ collateral-token.ts (335 lines) - HAS ERRORS
**Implementation:**
- `SvmCollateralTokenReader` - Reads collateral token + extracts mint from plugin
- `SvmCollateralTokenWriter` - Deployment:
  1. Check token PDA
  2. Determine SPL program (Token vs Token-2022)
  3. Call Init
  4. Create + initialize escrow token account
  5. Enroll routers
  6. Set gas
  7. Set ISM
- `getEscrowPda()` - Derive escrow PDA
- `determineSplProgram()` - Detect Token vs Token-2022 from mint owner

**Issues:**
1. **Line 10**: `TOKEN_PROGRAM_ADDRESS` doesn't exist → should be `TOKEN_PROGRAM_ID`
2. **Line 11**: `TOKEN_2022_PROGRAM_ADDRESS` doesn't exist → should be `TOKEN_2022_PROGRAM_ID`
3. **Line 13**: `getAccountSize` doesn't exist in @solana/spl-token
4. **Line 36**: `getHyperlaneTokenPda` imported but unused
5. **Line 50**: Wrong PDA seeds: `"hyperlane_message-recipient-escrow"` should be `"hyperlane_token-escrow"`
6. **Line 90**: `require()` instead of static import
7. **Line 226**: `.value` doesn't exist on lamports (type is branded BigInt)
8. **Line 244**: Passing `Address` where `PublicKey` expected (mixing @solana/web3.js with @solana/kit)
9. **Line 252**: `createInitializeAccountInstruction` returns web3.js `TransactionInstruction`, not @solana/kit `Instruction`
10. **Lines 220-253**: Escrow account creation mixes @solana/web3.js and @solana/kit incompatibly

### ❌ warp-artifact-manager.ts (119 lines) - INCOMPLETE
**Implementation:**
- `SvmWarpArtifactManager` class
- `detectType()` - Detects token type from chain
- `reader<K>(type)` - Factory for readers (uses type assertions)
- `writer<K>(type)` - Factory for writers (uses type assertions)
- `read()` - Convenience method

**Issues:**
1. **Type assertions**: Lines 60-76 use `as` to cast readers/writers
2. **Missing interface methods**: `IWarpArtifactManager` requires `createReader()` and `createWriter()` methods - not implemented
3. **Constructor**: Takes single programId but should take program addresses for all 3 types (synthetic, native, collateral have different program IDs)

### ✅ index.ts (36 lines) - WORKING
Clean exports of all types and functions.

---

## Analysis Summary

### What Worked Well

1. **Follows existing patterns**: Reader/Writer structure matches ISM/Hook implementations
2. **Comprehensive**: All 3 token types implemented
3. **Full deployment flow**: Not just config updates, includes Init + SPL token setup
4. **Proper separation**: Query, TX, and artifact files cleanly separated
5. **Update logic**: Reuses `computeWarpTokenUpdateInstructions` for updates

### Critical Issues

#### 1. **Mixed @solana/web3.js and @solana/kit** (collateral-token.ts)
**Root cause**: `@solana/spl-token` exports web3.js v1 types (`PublicKey`, `TransactionInstruction`)
**Impact**: Type incompatibility - can't mix web3.js classes with @solana/kit

**Two options:**
- **Option A**: Use `@solana-program/token` or `@solana-program/token-2022` instead (web3.js v2 compatible)
- **Option B**: Manual instruction building for token operations (like program-deployer.ts does for Loader v3)

#### 2. **Dynamic require() instead of static imports**
**Locations**: Lines 65/46/90 in synthetic/native/collateral-token.ts
**Issue**: `require('../generated/types/initProxy.js')` instead of `import`
**Fix**: Move to top-level import

#### 3. **Wrong PDA seeds**
- Synthetic mint: `"hyperlane_message-recipient-mint"` → should be `"hyperlane_token-mint"`
- Collateral escrow: `"hyperlane_message-recipient-escrow"` → should be `"hyperlane_token-escrow"`

**Reference** (from Rust):
```rust
#[macro_export]
macro_rules! hyperlane_token_mint_pda_seeds {
    () => {
        &[b"hyperlane_token", b"-", b"mint"]
    };
}

#[macro_export]
macro_rules! hyperlane_token_escrow_pda_seeds {
    () => {
        &[b"hyperlane_token", b"-", b"escrow"]
    };
}
```

#### 4. **Incomplete SPL Token-2022 implementation** (synthetic-token.ts)
**Current approach**: Tries to use `@solana/spl-token` functions
**Problems**:
- Missing actual account creation for mint PDA
- `createInitializeMetadataPointerInstruction` missing import
- `createInitializeTokenMetadataInstruction` doesn't exist (should be `createInitializeInstruction` from metadata extension)
- Metadata operations may not be needed if program handles internally

**Question**: Does the Solana token program create the mint internally during Init? Or do we need to create it first in TypeScript?

---

## Key Design Questions

### Q1: SPL Token-2022 Mint Creation - Who Does It?

**Rust CLI approach** (lines 324-340 of warp_route.rs):
```rust
// After Init instruction, Rust CLI calls:
spl-token create-token <mint> --enable-metadata -p spl_token_2022 --mint-authority <payer>
spl-token initialize-metadata <mint> --name "X" --symbol "Y" --uri "Z"
spl-token authorize <mint> mint <mint>
```

**This means**: TypeScript must create the mint account AFTER Init, not during. The Init instruction creates the token PDA, but the SPL mint is separate.

### Q2: Escrow Account Creation - Manual or Automatic?

**Rust collateral Init** (lines 361-381 of warp_route.rs):
```rust
// Init instruction is called first
let init_ix = init_instruction(program_id, payer, init, spl_program, mint);

// Then separately initialize the escrow account
let init_escrow_ix = initialize_account(escrow_pda, mint, escrow_pda, spl_program);
```

**This means**: TypeScript must create escrow account AFTER Init.

### Q3: Are We Using the Right Libraries?

**Current**:
- `@solana/spl-token` - Web3.js v1 compatible, returns `TransactionInstruction` and `PublicKey`

**Should be**:
- `@solana-program/token` or `@solana-program/token-2022` - Web3.js v2 compatible, returns @solana/kit types

**Package availability**: Check if `@solana-program/token-2022` is in dependencies.

---

## Recommendations

### Immediate Next Steps

1. **DON'T fix yet** - Need to answer design questions first
2. **Check Rust program behavior** - Does Init create mint internally or expect it pre-created?
3. **Verify library choices** - Should we use `@solana-program/token-2022` instead of `@solana/spl-token`?
4. **Simplify approach** - Maybe Init handles everything and we don't need SPL operations?

### Testing Strategy

Before fixing errors, we should:
1. Read the Rust token program Init handler to see what it creates
2. Check if there are existing Solana tokens deployed we can query
3. Write a minimal test that just calls Init and sees what happens

### Alternative Approach

**Simplest path** (if Init handles SPL internally):
1. Just call Init instruction
2. Enroll routers
3. Set gas/ISM
4. Skip all SPL token operations

**Verify by**: Checking rust/sealevel/programs/hyperlane-sealevel-token/src/processor.rs to see what Init instruction does.

---

## Error Summary by Category

| Category | Count | Severity |
|----------|-------|----------|
| Wrong import names (TOKEN_PROGRAM_ADDRESS) | 3 | High |
| Dynamic require() vs static import | 3 | Medium |
| Unused imports | 4 | Low |
| Type mixing (@solana/web3.js vs @solana/kit) | 3 | High |
| Wrong PDA seeds | 2 | Critical |
| Missing interface methods | 2 | High |
| Type assertions | 6 | Medium |

**Total**: 23 issues across 5 files

---

## Next Actions (Recommended Order)

1. **Read Rust Init processor** - Understand what Init actually creates
2. **Decide on library strategy** - @solana/spl-token vs @solana-program/token-2022 vs manual
3. **Fix critical issues**: PDA seeds, library incompatibility
4. **Simplify if possible**: Remove SPL operations if program handles them
5. **Add tests**: Create minimal e2e test
6. **Fix remaining errors**: Clean up imports, remove assertions
