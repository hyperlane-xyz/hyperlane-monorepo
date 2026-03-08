# Cross-VM E2E Test: Sealevel MultiCollateral ↔ EVM Collateral

## Context

This branch adds MultiCollateral support to the Sealevel client and a test script to verify cross-chain compatibility between Sealevel (SVM) and EVM. See `PLAN.md` at repo root for the full MultiCollateral implementation plan — this work covers Phase 5 (cross-protocol e2e testing) and the client/build portions needed to support it.

The MC program itself (`rust/sealevel/programs/hyperlane-sealevel-token-multicollateral/`) already exists with 10 functional Rust tests. The TS SDK adapter changes also exist on this branch. This test verifies the cross-chain message path works end-to-end.

## What's Done

### Sealevel Client MultiCollateral Support (COMPLETE, compiles clean)
- **`rust/sealevel/client/Cargo.toml`** — Added `hyperlane-sealevel-token-multicollateral` dep
- **`rust/sealevel/client/src/warp_route.rs`** — `MultiCollateral(CollateralInfo)` variant: init logic calls `multicollateral::instruction::init_instruction()`, program name `hyperlane_sealevel_token_multicollateral`, gas overhead 68k, ATA payer support
- **`rust/sealevel/client/src/main.rs`** — `MultiCollateral` in `FlatTokenType`, all 3 match statements updated (query accounts, query display, transfer-remote)

### Build List (COMPLETE)
- **`rust/main/utils/run-locally/src/sealevel/solana.rs`** — `"hyperlane-sealevel-token-multicollateral"` added to `SOLANA_HYPERLANE_PROGRAMS`

### Test Script (DRAFT — dispatch works, relay is TODO)
- **`rust/sealevel/scripts/test-cross-vm.sh`** — Orchestrates both chains, deploys everything, runs `transfer-remote` in both directions. Relay (actually delivering the message on the destination chain) is stubbed with TODOs.

## What's Needed to Complete the E2E

### Blocker: `cargo-build-sbf` Version

Installed `cargo-build-sbf` is v1.18.18 (Rust 1.75) but `Cargo.lock` is version 4 (needs newer toolchain). The e2e CI uses **agave v3.0.14**.

```bash
# Install agave 3.0.14 (macOS ARM):
curl -LO https://github.com/anza-xyz/agave/releases/download/v3.0.14/solana-release-aarch64-apple-darwin.tar.bz2
tar xf solana-release-aarch64-apple-darwin.tar.bz2
export PATH="$(pwd)/solana-release/bin:$PATH"
cargo-build-sbf --version  # should show 3.x
```

Or update the system solana install: `solana-install init 3.0.14`

### Relay: Sealevel → EVM (primary goal)

After `transfer-remote` on Sealevel dispatches a message, relay it to EVM's `mailbox.process()`.

**Getting the message bytes from Sealevel:**

The dispatched message lives in a PDA. Data layout (Borsh):
```
8B discriminator ("DISPATCH") | 4B nonce (u32 LE) | 8B slot (u64 LE) |
32B unique_message_pubkey | 4B msg_len (u32 LE) | NB encoded_message
```

Options to extract:
1. **Parse transaction logs**: `solana confirm -v <tx_sig>` shows program logs and account keys. Find the dispatched message PDA (newly created writable account), then `solana account <pda> --output json | jq -r '.data[0]' | base64 -d` and skip 52 bytes header.
2. **Construct manually**: All fields are known at test time:
   - version=3, nonce=0, origin=13375(BE), sender=MC_program_32B, dest=31337(BE), recipient=EVM_collateral_padded_32B
   - body = `recipient_h256(32B) || amount_u256(32B)` — amount in remote decimals (18)

**Relaying to EVM:**
```bash
cast send $EVM_MAILBOX "process(bytes,bytes)" "0x" "0x<message_hex>" \
  --rpc-url http://127.0.0.1:8545 --private-key $ANVIL_PRIVATE_KEY
```
- First arg: metadata (empty — TestIsm accepts anything)
- Second arg: raw Hyperlane message bytes

**Verification:**
```bash
cast call $EVM_ERC20 "balanceOf(address)(uint256)" $RECIPIENT --rpc-url http://127.0.0.1:8545
# Should be > 0
```

### Relay: EVM → Sealevel (harder, can defer)

The Sealevel `InboxProcess` instruction needs many accounts that depend on the ISM type and recipient program. Best approach: add a `mailbox inbox-process` subcommand to the sealevel client. See `rust/main/chains/hyperlane-sealevel/src/mailbox.rs` for how the relayer constructs process transactions.

Required accounts for InboxProcess:
- Payer (signer, writable)
- Mailbox inbox PDA
- Recipient program (MC warp route)
- Process authority PDA (`seeds: ["hyperlane","-","process_authority","-",recipient_pubkey]`)
- Processed message PDA (`seeds: ["hyperlane","-","processed_message","-",message_id_bytes]`)
- System program
- ISM program + ISM-specific accounts
- SPL Noop program
- Recipient-specific accounts (token PDA, escrow, mint, SPL token program, recipient ATA, etc.)

## Key Info

| Entity | Value |
|--------|-------|
| Sealevel domain | 13375 |
| EVM domain | 31337 |
| Sealevel RPC | http://127.0.0.1:8899 |
| EVM RPC | http://127.0.0.1:8545 |
| Anvil private key | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| Anvil address | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| Sealevel deployer keypair | `environments/local-e2e/accounts/test_deployer-keypair.json` |
| Sealevel core IDs | `environments/local-e2e/sealeveltest1/core/program-ids.json` |
| MC warp route IDs | `environments/local-e2e/warp-routes/mctest/program-ids.json` (after deploy) |
| Dispatch event topic | `0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814` |

## EVM Contracts

| Contract | Solidity Path | Constructor |
|----------|--------------|-------------|
| Mailbox | `contracts/Mailbox.sol:Mailbox` | `(uint32 localDomain)` |
| TestIsm | `contracts/test/TestIsm.sol:TestIsm` | none |
| TestPostDispatchHook | `contracts/test/TestPostDispatchHook.sol:TestPostDispatchHook` | none |
| ERC20Test | `contracts/test/ERC20Test.sol:ERC20Test` | `(string,string,uint256,uint8)` |
| HypERC20Collateral | `contracts/token/HypERC20Collateral.sol:HypERC20Collateral` | `(address erc20, uint256 scaleNum, uint256 scaleDenom, address mailbox)` |

Post-deploy initialization:
- `Mailbox.initialize(owner, defaultIsm, defaultHook, requiredHook)`
- `HypERC20Collateral.initialize(hook, ism, owner)`
- `HypERC20Collateral.enrollRemoteRouter(uint32 domain, bytes32 router)`

## File Reference

| File | Purpose |
|------|---------|
| `PLAN.md` | Full MC implementation plan (all phases) |
| `rust/sealevel/scripts/test-cross-vm.sh` | Test orchestrator |
| `rust/sealevel/scripts/CROSS_VM_TEST_INSTRUCTIONS.md` | This file |
| `rust/sealevel/client/src/warp_route.rs` | MC warp route deployer |
| `rust/sealevel/client/src/main.rs` | CLI token type enum |
| `rust/sealevel/programs/hyperlane-sealevel-token-multicollateral/` | MC program source |
| `rust/sealevel/programs/hyperlane-sealevel-token-multicollateral/src/instruction.rs` | `init_instruction()` |
| `rust/sealevel/programs/hyperlane-sealevel-token-multicollateral/src/processor.rs` | `MultiCollateralState`, handle logic |
| `solidity/contracts/token/HypERC20Collateral.sol` | EVM collateral token |
| `solidity/contracts/Mailbox.sol` | EVM mailbox |
| `rust/sealevel/programs/mailbox/src/processor.rs` | Sealevel mailbox (`inbox_process` at line 189) |
| `rust/sealevel/programs/mailbox/src/accounts.rs` | `DispatchedMessage` struct (line 164) |
