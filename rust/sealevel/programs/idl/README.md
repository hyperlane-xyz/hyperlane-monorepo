# Hyperlane Sealevel Program IDLs

This directory contains Interface Definition Language (IDL) files for all Hyperlane Sealevel programs, generated using [Shank](https://github.com/metaplex-foundation/shank).

## Generated IDLs

### Tier 1: Core Infrastructure
- **hyperlane_sealevel_mailbox.json** (13KB) - Central messaging hub with 12 instructions
- **hyperlane_sealevel_igp.json** (15KB) - Interchain Gas Paymaster with 11 instructions
- **hyperlane_sealevel_validator_announce.json** (4KB) - Validator registry with 2 instructions

### Tier 2: Application Layer
- **hyperlane_sealevel_hello_world.json** (7KB) - Example router with 4 instructions
- **hyperlane_sealevel_token.json** (588B) - Synthetic token warp route (plugin only)
- **hyperlane_sealevel_token_native.json** (433B) - Native token warp route (plugin only)
- **hyperlane_sealevel_token_collateral.json** (785B) - Collateral token warp route (plugin only)

### Tier 3: ISM Programs
- **hyperlane_sealevel_multisig_ism_message_id.json** (5.9KB) - Multisig ISM with 4 instructions
- **hyperlane_sealevel_test_ism.json** (1.4KB) - Test ISM with 2 instructions

## Regenerating IDLs

To regenerate all IDLs after code changes:

```bash
cd rust/sealevel
./generate-idls.sh
```

The script:
1. Runs `shank idl` for each program
2. Outputs IDLs to this directory
3. Uses declared program IDs from each program

## IDL Structure

Each IDL contains:
- **instructions**: All program instructions with account requirements and arguments
- **accounts**: Account data structures
- **types**: Custom data types used in instructions and accounts
- **errors**: Program error codes (where applicable)
- **metadata**: Program address and origin

## Custom Type Handling

- **H256/H160 fields**: Represented as `bytes` type in IDL (per plan decision)
- **Discriminators**: IGP and some account types use 8-byte discriminators
- **No seeds**: PDA seeds use existing `pda_seeds!()` macros, not IDL-based generation

## TypeScript Client Generation

TypeScript clients have been generated from these IDLs using [Codama](https://github.com/codama-idl/codama).

### Generated Clients

Location: `typescript/sdk/src/providers/sealevel/generated/`

Each program has its own directory containing:
- **instructions/** - Typed instruction builders
- **accounts/** - Account codecs for serialization/deserialization
- **types/** - Custom type definitions
- **programs/** - Program metadata and addresses
- **errors/** - Error code definitions

### Regenerating Clients

After updating Rust program code or regenerating IDLs:

```bash
# Regenerate IDLs
cd rust/sealevel
./generate-idls.sh

# Regenerate TypeScript clients
cd ../../typescript/sdk
pnpm codama

# Or clean and regenerate
pnpm codama:clean
```

### Using Generated Clients

```typescript
// Import instruction builders
import { getInboxProcessInstruction } from './providers/sealevel/generated/hyperlane_sealevel_mailbox/instructions';
import { getQuoteGasPaymentInstruction } from './providers/sealevel/generated/hyperlane_sealevel_igp/instructions';

// Import account codecs
import { decodeInbox } from './providers/sealevel/generated/hyperlane_sealevel_mailbox/accounts';

// Build instructions with type-safe parameters
const instruction = getInboxProcessInstruction({
  payer: payerAddress,
  inbox: inboxPda,
  processedMessage: processedMessagePda,
  // ... other accounts
  metadata: metadataBytes,
  message: messageBytes,
});

// Decode accounts
const inbox = decodeInbox(encodedAccount);
console.log(inbox.localDomain, inbox.processedCount);
```

### Integration Status

**Phase 4 (Codama Integration): ✅ Complete**
- Codama packages installed
- Generation script created (`typescript/sdk/codama.mjs`)
- All 9 programs have generated TypeScript clients

**Phase 5 (Adapter Integration): ⏳ Pending**
- Current adapters use `@solana/web3.js` + manual Borsh serialization
- Generated clients use `@solana/kit` (modern Solana library)
- Integration requires refactoring existing adapters to use generated instruction builders and account codecs

## Notes

- Token programs show small IDL sizes because they use shared library instructions
- The actual instruction definitions are in `hyperlane-sealevel-token-lib`
- Program IDs in IDLs are either mainnet addresses or placeholders for undeployed programs
