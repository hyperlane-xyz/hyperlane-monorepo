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

## Next Steps for TypeScript Integration

To generate TypeScript clients from these IDLs:

1. **Install Codama** in `typescript/sdk`:
   ```bash
   cd typescript/sdk
   pnpm add -D codama
   ```

2. **Create Codama config** (`typescript/sdk/codama.config.js`):
   ```javascript
   const { Codama } = require('codama');

   const codama = new Codama({
     idls: [
       '../../rust/sealevel/programs/idl/hyperlane_sealevel_mailbox.json',
       '../../rust/sealevel/programs/idl/hyperlane_sealevel_igp.json',
       // ... rest of IDLs
     ],
     outputDir: 'src/providers/sealevel/generated',
   });

   codama.render();
   ```

3. **Generate TypeScript clients**:
   ```bash
   node codama.config.js
   ```

4. **Integrate with existing Sealevel providers**:
   - Import generated instruction builders in `SealevelCoreAdapter.ts`
   - Replace manual transaction building with generated builders
   - Use generated account codecs for deserialization

## Notes

- Token programs show small IDL sizes because they use shared library instructions
- The actual instruction definitions are in `hyperlane-sealevel-token-lib`
- Program IDs in IDLs are either mainnet addresses or placeholders for undeployed programs
