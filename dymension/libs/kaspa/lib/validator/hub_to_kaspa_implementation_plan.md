# Hub->Kaspa Validator Implementation Plan (G() Function)

## Overview

This document outlines the implementation plan for the G() function in the **hub->kaspa unescrow flow**, specifically step 5 in the validator workflow:

```
5. Validator call G(batch of PSKT<Signer>) to get Ok(true) [no validations]
6. Validator signs to get batch of PSKT<Combiner>, return to relayer
```

## Current State Analysis

### Existing Components

1. **Relayer F() Function**: Located in `dymension/libs/kaspa/lib/relayer/src/hub_to_kaspa.rs`
   - Function: `build_withdrawal_pskts()`
   - Returns: `Result<Option<PSKT<Signer>>>`
   - Purpose: Constructs PSKT for withdrawal transactions from hub withdrawal messages

2. **Validator Library**: Located in `dymension/libs/kaspa/lib/validator/src/`
   - Current modules: `withdraw.rs`, `deposit.rs`, `confirmation.rs`, `signer.rs`, `lib.rs`
   - Existing functionality: `sign_escrow_spend()` in `withdraw.rs` handles PSKT signing
   - The G() function is going to be located in `withdrawal.rs`. Method `validate_withdrawals`.

3. **Core Library**: Located in `dymension/libs/kaspa/lib/core/src/`
   - Shared entities: `Escrow`, `MessageIDs`, payload handling
   - Common utilities for PSKT manipulation

### Input/Output Analysis

**Input to G()**: 
- `WithdrawFXG`, i.e. `batch of PSKT<Signer>`, from relayer F() function
- `WithdrawFXG` contains a bundle with PSKTs with withdrawal transaction details and message IDs in proprietaries

**Expected Output from G()**:
- `Ok(true)` with no validations (as per task specification)
- Side effect: Sign PSKTs to produce `batch of PSKT<Combiner>`
- Further, it will be wired with the relayer

## Implementation Plan

### Phase 1: Create G() Function Signature -> already exists

The G() function is going to be located in `withdrawal.rs`. Method `validate_withdrawals`
```rust
pub async fn validate_withdrawals(fxg: &WithdrawFXG) -> Result<bool> {
    Ok(true)
}
```

### Phase 2: Core Implementation

In `validate_withdrawals`:

- Get the list of `WithdrawFXG.messages`. These messages should be reflected in `WithdrawFXG.bundle`
- For every message, check that it is delivered using the `CosmosGrpcClient.delivered` method: `rust/main/chains/hyperlane-cosmos-native/src/providers/grpc.rs`
- Query the last outpoint from the Hub. Use `CosmosGrpcClient.withdrawal_status`: `rust/main/chains/hyperlane-cosmos-native/src/providers/grpc.rs`. This fetches the last outpoint and checks statuses of the messages. All messages should have `WithdrawalStatus::Unprocessed` (ref: `dymension/libs/kaspa/lib/relayer/src/hub_to_kaspa.rs:442`).
- Iterate over all PSKT in this Bundle: `for pskt in fxg.bundle.iter()`
- Check that tx inputs contain the Hub outpoint.
- ?? Check that UTXO spends actully align with withdrawals. Which values to compare? Query messages from the Hub by their IDs?
- ?? The proposed kaspa generated TXs are a linked sequence – Now we assume that we have only one tx, but still need to impl this flow.

### Phase 3: Integration Points

- `validate_withdrawals` is called in `hyperlane-monorepo/rust/main/chains/dymension-kaspa/src/validator_server.rs` `respond_sign_pskts` method. Make adjustments in this method if needed.
- See if `sign_pskt` method needs any adjustments.
