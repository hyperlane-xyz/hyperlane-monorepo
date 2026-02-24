# Findings: `@solana/codecs` usage for Pubkey-typed fields in `typescript/svm-provider`

Scope:

- `typescript/svm-provider/src/codecs/*`
- `typescript/svm-provider/src/accounts/*`
- `typescript/svm-provider/src/instructions/*`
- call sites doing manual bytes<->address conversion (notably hooks/ISM)

## Short answer

Yes, for fields that are Rust `Pubkey` semantically, TS types should be address strings (`Address` from `@solana/kit`, or `string` at external boundaries where required), and encoding/decoding should happen in codec helpers.

Do **not** blindly convert all 32-byte fields to Solana addresses: some are `H256`/cross-chain payloads and should remain byte/hex types.

## Current state

## Good

- Code already uses `@solana/kit` codec primitives heavily (`getStructEncoder/Decoder`, `fixCodecSize`, `getNullableCodec`, `addCodecSizePrefix`), especially in `codecs/shared.ts`, `instructions/igp.ts`, `instructions/token.ts`.
- Address conversion utilities are already used in some places (`getAddressEncoder`, `getAddressDecoder`, `address(...)`).

## Gaps

- Many Rust `Pubkey` fields are modeled as `Uint8Array` in account and instruction interfaces, then converted manually at call sites.
- Conversion logic is duplicated and spread across features (reader/writer + instruction builders), increasing drift risk.

## Evidence of Pubkey fields modeled as raw bytes

### Account models

- `accounts/token.ts`:
  - `HyperlaneTokenAccountData.mailbox: Uint8Array`
  - `mailboxProcessAuthority: Uint8Array`
  - `owner: Uint8Array | null`
  - `interchainSecurityModule: Uint8Array | null`
  - `interchainGasPaymaster.programId: Uint8Array`
  - `interchainGasPaymaster.igpType.account: Uint8Array`
  - `IgpAccountData.owner: Uint8Array | null`, `beneficiary: Uint8Array`
  - `OverheadIgpAccountData.owner: Uint8Array | null`, `inner: Uint8Array`
- `accounts/multisig-ism-message-id.ts`:
  - `AccessControlData.owner: Uint8Array | null`

### Instruction payload models

- `instructions/igp.ts`:
  - `InitIgpData.owner/beneficiary` are byte arrays
  - `InitOverheadIgpData.owner/inner` are byte arrays
  - ownership/beneficiary update variants use byte arrays
- `instructions/token.ts`:
  - init and update payloads use byte arrays for mailbox/ISM/IGP program ids
- `instructions/multisig-ism-message-id.ts`:
  - `transferOwnership.newOwner: Uint8Array | null`

### Manual conversion already present (symptom)

- `hook/igp-hook.ts` decodes account byte fields to address strings via `getAddressDecoder`, then re-encodes via `getAddressEncoder` before instruction construction.
- This is exactly the conversion that should mostly live in codecs/types rather than feature handlers.

## Should types be strings?

For **Pubkey semantics**: yes, prefer semantic address types (`Address`) in TS data models and APIs.

Reasoning:

- Aligns with Kit API shape: RPC/instruction APIs are address-first.
- Removes repetitive `Uint8Array <-> base58` mapping code.
- Moves validation to boundaries (`address(...)`) and codec layer.
- Improves readability in artifact/config flows that are already string-address based.

Important nuance:

- Use `Address` internally where possible.
- Keep `string` only where upstream interfaces require it (e.g. provider-sdk config), and normalize with `address(...)` at boundary.

## What should remain bytes (or hex), not `Address`

Not all 32-byte fields are Solana pubkeys.

Keep byte/hex-oriented types for:

- `H256` router/sender/recipient payload values (`codecs/shared.ts`) used for cross-chain identities/messages.
- Arbitrary message metadata and instruction payload blobs.
- Ethereum validator addresses (`H160`) in multisig domain data (currently hex-like semantics, not Solana addresses).

## Recommended codec pattern

For Pubkey fields, define and reuse a dedicated codec set:

- `getAddressCodec()` / `getAddressEncoder()` / `getAddressDecoder()`
- `getNullableCodec(getAddressCodec())` for optional pubkeys
- struct codecs that directly expose `Address` (or `Address | null`) in decoded output

This centralizes conversion and avoids per-feature `parseAddress` + manual bytes juggling.

## Where this would simplify current code most

1. `accounts/token.ts`

- Decode pubkey fields directly to `Address` (optional where needed).
- Avoid downstream decode in `hook/igp-hook.ts` for owner/beneficiary.

2. `accounts/multisig-ism-message-id.ts`

- `AccessControlData.owner` as `Address | null`.

3. `instructions/igp.ts` and `instructions/token.ts`

- Accept semantic address fields in instruction data interfaces.
- Encode to bytes inside instruction codec functions.

4. `instructions/multisig-ism-message-id.ts`

- Ownership transfer inputs as `Address | null` (or boundary string), encode internally.

## Net assessment

- Current usage of `@solana/codecs` primitives is solid.
- Main issue is **type-level semantics** for pubkeys, not lack of codec infrastructure.
- Shifting Pubkey fields from raw `Uint8Array` to semantic address types in TS models, with conversion in codec layer, is the right direction and should reduce complexity and bugs.
