# Sealevel Generated Client Integration Guide

## Overview

This document describes how to integrate the Codama-generated TypeScript clients into the existing Sealevel adapters.

## Current State

### What's Complete (Phases 1-4)

1. ✅ **Rust programs annotated with Shank macros** (`rust/sealevel/programs/`)
2. ✅ **IDL generation working** (`rust/sealevel/generate-idls.sh`)
3. ✅ **9 IDL JSON files generated** (`rust/sealevel/programs/idl/*.json`)
4. ✅ **Codama installed and configured** (`typescript/sdk/codama.mjs`)
5. ✅ **TypeScript clients generated** (`typescript/sdk/src/providers/sealevel/generated/`)

### What Remains (Phase 5)

Integration of generated clients into existing adapters:

- `SealevelCoreAdapter.ts` - Mailbox interactions
- `SealevelIgpAdapter.ts` - IGP (Interchain Gas Paymaster) interactions
- `SealevelTokenAdapter.ts` - Token warp route interactions
- `SealevelMultisigAdapter.ts` - Multisig ISM interactions

## Technical Challenge

The existing adapters were written before Codama existed and use different libraries:

| Aspect               | Current Code                    | Generated Code                 |
| -------------------- | ------------------------------- | ------------------------------ |
| Library              | `@solana/web3.js`               | `@solana/kit`                  |
| Serialization        | Manual `borsh.serialize()`      | Generated codecs               |
| Instruction Building | Manual `TransactionInstruction` | Generated instruction builders |
| Account Decoding     | Manual Borsh schemas            | Generated decoders             |

## Migration Strategy

### Option 1: Incremental Adapter-by-Adapter (Recommended)

Migrate one adapter at a time, starting with the simplest:

1. **Start with `SealevelCoreAdapter`** (mailbox)

   - Import generated instruction builders
   - Replace manual `TransactionInstruction` construction
   - Update account decoding to use generated codecs
   - Keep existing tests passing

2. **Move to `SealevelIgpAdapter`** (IGP)

   - More complex due to gas payment logic
   - Verify discriminator handling (8-byte discriminators)

3. **Then `SealevelMultisigAdapter`** (ISM)

   - Relatively straightforward

4. **Finally `SealevelTokenAdapter`** (token warp routes)
   - Uses shared library, may need special handling

### Option 2: Parallel Implementation

Create new adapters alongside existing ones:

- Name them `SealevelCoreAdapterV2`, etc.
- Gradually migrate usage
- Remove old adapters once fully tested

## Integration Examples

### Before: Manual Transaction Building

```typescript
// SealevelCoreAdapter.ts (current)
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { serialize } from 'borsh';

const value = new SealevelInstructionWrapper({
  instruction: SealevelMailboxInstructionType.SetDefaultIsm,
  data: new SealevelMailboxSetDefaultIsmInstruction({
    new_default_ism: new PublicKey(ism),
  }),
});

const serialized = serialize(
  SealevelMailboxSetDefaultIsmInstructionSchema,
  value,
);

const instruction = new TransactionInstruction({
  keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: inbox, isSigner: false, isWritable: true },
  ],
  programId: new PublicKey(this.addresses.mailbox),
  data: Buffer.from(serialized),
});
```

### After: Generated Instruction Builder

```typescript
// SealevelCoreAdapter.ts (with generated clients)
import { getInboxSetDefaultIsmInstruction } from './generated/hyperlane_sealevel_mailbox/instructions';

const instruction = getInboxSetDefaultIsmInstruction({
  payer: payerAddress,
  inbox: inboxPda,
  newDefaultIsm: ismAddress,
});
```

### Account Decoding Example

**Before:**

```typescript
const accountInfo = await connection.getAccountInfo(pda);
const inbox = deserializeUnchecked(
  SealevelInboxSchema,
  Inbox,
  accountInfo.data,
);
```

**After:**

```typescript
import { fetchInbox } from './generated/hyperlane_sealevel_mailbox/accounts';

const inbox = await fetchInbox(rpc, pda);
// Or if you already have the account data:
const inbox = decodeInbox(encodedAccount);
```

## Testing Strategy

### Phase 5.1: Unit Tests

1. Create unit tests for generated instruction builders
2. Verify serialized data matches expected format
3. Test account codecs with real on-chain data

### Phase 5.2: Integration Tests

1. Update existing adapter tests to use new implementation
2. Run against devnet to verify instructions execute correctly
3. Compare transaction bytes with old implementation

### Phase 5.3: E2E Tests

1. Use existing CLI e2e tests: `pnpm -C typescript/cli test:sealevel:e2e`
2. Verify end-to-end message flow works
3. Test all adapter methods (dispatch, process, gas payment, etc.)

## Library Compatibility

### @solana/kit vs @solana/web3.js

The generated code uses `@solana/kit`, which is the modern Solana SDK. Key differences:

| Feature              | @solana/web3.js | @solana/kit               |
| -------------------- | --------------- | ------------------------- |
| Account Types        | `PublicKey`     | `Address` (base58 string) |
| Transaction Building | Imperative      | Functional/composable     |
| Serialization        | Manual borsh    | Generated codecs          |
| Type Safety          | Limited         | Extensive generics        |

### Bridging the Gap

Create utility functions to convert between libraries:

```typescript
// utils/solanaCompat.ts
import type { Address } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';

export function publicKeyToAddress(key: PublicKey): Address {
  return key.toBase58() as Address;
}

export function addressToPublicKey(addr: Address): PublicKey {
  return new PublicKey(addr);
}
```

## Dependencies to Add

The generated clients require `@solana/kit`:

```json
{
  "dependencies": {
    "@solana/kit": "^2.0.0"
  }
}
```

**Note:** `@solana/web3.js` can coexist with `@solana/kit` during migration.

## PDA Derivation

The generated clients do NOT include PDA derivation helpers (per plan decision to keep existing `pda_seeds!()` macros in Rust).

Existing PDA derivation logic in adapters should be kept:

```typescript
// Keep this existing code
static deriveMailboxInboxPda(mailboxPubkey: Address): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('hyperlane_inbox'), Buffer.from([0])],
    new PublicKey(mailboxPubkey)
  )[0];
}
```

## Open Questions for Implementation

1. **@solana/kit Migration Scope**: Should we migrate the entire SDK to `@solana/kit`, or create a compatibility layer?

2. **RPC Provider Abstraction**: How do generated `fetchAccount` functions integrate with existing `MultiProtocolProvider`?

3. **Error Handling**: Do generated error types need mapping to existing error handling patterns?

4. **Transaction Signing**: How do generated instructions work with existing signer abstractions?

5. **Backwards Compatibility**: Do we need to maintain the old API surface during migration?

## Next Steps

1. **Prototype Integration**: Create a branch and migrate `SealevelCoreAdapter` first
2. **Write Integration Tests**: Verify generated clients work with real chain data
3. **Document Breaking Changes**: Identify any API changes for downstream consumers
4. **Create Migration Plan**: Timeline for rolling out adapter changes
5. **Update Documentation**: TypeScript SDK docs to reference generated clients

## Reference Documentation

- [Codama Documentation](https://github.com/codama-idl/codama)
- [Solana Web3.js Documentation](https://solana-labs.github.io/solana-web3.js/)
- [@solana/kit Documentation](https://github.com/solana-program/kit)
- [Hyperlane Sealevel Programs](../../rust/sealevel/programs/)
- [Generated Clients](./src/providers/sealevel/generated/)
