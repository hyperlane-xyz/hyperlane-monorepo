# Draft Implementation: F() and G() for Hub -> Kaspa Unescrow Flow

_GPT-created and modified manually_

This document outlines the draft implementation for the library functions `F()` (used by the Relayer) and `G()` (used by the Validator) in the context of the Hub to Kaspa unescrow (withdrawal) flow for the Kaspa-Hyperlane bridge.

## Function `F()` - Relayer Library

**Location (Suggested):** `dymension/libs/kaspa/lib/relayer/src/hub_to_kaspa_builder.rs` (new file).

**Purpose:**
To observe withdrawal messages dispatched on the Hub and construct the necessary Kaspa Partially Signed Kaspa Transactions (`PSKT<Signer>`) to fulfill these withdrawals from the Kaspa escrow.

**Conceptual Signature:**

```rust
// In dymension/libs/kaspa/lib/relayer/src/hub_to_kaspa_builder.rs
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_wallet_core::account::Account;
use kaspa_wallet_pskt::{PSKT, Signer};
use std::sync::Arc;
use anyhow::Result;

use core::escrow::EscrowPublic;
use kaspa_consensus_core::tx::TransactionOutpoint as KaspaUtxoOutpoint;
use hyperlane_core::EventDispatch; // Generated from Hyperlane bindings

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

/// Querier that speaks to Hub's x/kas query service **at a given height**. This is a mock, use a real provider from CosmosNativeProvider.
pub type HubQuerier = Arc<
    dyn Fn(u64 /* hub_height */, u64 /* withdrawal_id */)
        -> Result<HubWithdrawalDetails, anyhow::Error>
        + Send
        + Sync,
>;

/// State (O, L) that we cache locally from the Hub. This should live in libs/core or in some CosmosNativeProvider.
#[derive(Debug, Clone)]
pub struct HubKaspaState {
    pub current_anchor_outpoint: KaspaUtxoOutpoint, // O
    pub last_processed_withdrawal_index: u64,       // L
}

/// Build a **batch** of PSKTs that un-escrow from Kaspa.
/// Invoked **inside the main relayer loop** every time we
/// receive fresh Hyperlane events.
#[allow(unused_variables)]
pub async fn build_kaspa_withdrawal_pskts(
    hub_events: Vec<EventDispatch>,           // Fresh events from loop
    hub_height: u64,                          // Height at which events were observed
    kaspa_rpc: &impl RpcApi,
    escrow_public: &EscrowPublic,
    relayer_kaspa_account: &Arc<dyn Account>,
    hub_querier: HubQuerier,                  // gRPC/REST client into Hub x/kas
) -> Result<Option<Vec<PSKT<Signer>>>> {
    // TODO: Implementation based on Core Logic described below
    Ok(None)
}
```

**Prerequisites**

1. Update rust proto codegen to support x/kas from the Hub. We need it to query the last Ourpost and Widthdrawal statuses from the Hub: https://github.com/dymensionxyz/hyperlane-cosmos-rs
2. Create new queries for the Hub at `rust/main/chains/hyperlane-cosmos-native/src/providers/cosmos.rs`

**Core Logic for `build_kaspa_withdrawal_pskts` (`F()`):**

1.  **Initialization:**
    *   Create an empty list `prepared_pskts: Vec<PSKT<Signer>>`.
    *   Create a list of `WithdrawalID`s based on the `EventDispatch` vector. The mechanism already exists in native Cosmos handler: https://github.com/dymensionxyz/hyperlane-monorepo/blob/4b54f2aee147868bc1136e55239979c2c718813b/rust/main/chains/hyperlane-cosmos-native/src/indexers/dispatch.rs#L46-L76. We can re-use it if possible. `HyperlaneMessage` struct: https://github.com/dymensionxyz/hyperlane-monorepo/blob/5b6c65daa184ed7a98a6056c2ea0f4265a820971/rust/main/hyperlane-core/src/types/message.rs#L25-L42.
    *   Make a call to [the Hub](https://github.com/dymensionxyz/dymension/blob/main/proto/dymensionxyz/dymension/kas/query.proto#L13-L18) method `WithdrawalStatus`. Use the `WithdrawalID` list and the Hub height as argumetns.
    *   `WithdrawalStatus` returns a current outport with O and L values: keep track of the `current_kaspa_anchor_utxo_to_spend` and `last_processed_l_for_this_batch`.

1.  **Collect & Sort Hub Withdrawals:**
    *  We assume that there is no any batching right now, and we always get one single `EventDisparth`.

2.  **Construct Single PSKT** For each withdrawal:
      *   Create a new method similar to `dymension/libs/kaspa/lib/relayer/src/withdraw.rs::build_withdrawal_tx`). It should use the specified UTXO as input. The UTXO is `current_kaspa_anchor_utxo_to_spend`. The `build_withdrawal_tx` function needs modification to:
          *   Accept a specific anchor UTXO to spend.
          *   Accept the `L_next_hub` to put in the payload.
          *   Return the details of the new escrow change UTXO (which becomes the next anchor).
      *   **Inputs:**
          *   The `current_kaspa_anchor_utxo_to_spend`.
          *   Additional UTXOs from the escrow if the anchor is insufficient (query `kaspa_rpc` for `escrow_public.addr`)
          *   ~~A UTXO from `relayer_kaspa_account` for relayer-paid fees.~~ Who pays the fee here?
      *   **Outputs:**
          *   The recipiend address from `HyperlaneMessage`.
          *   A new change UTXO back to `escrow_public.addr`. This UTXO becomes the `current_kaspa_anchor_utxo_to_spend` for the *next* PSKT in the batch. The last UTXO in the chain should be returned as an updated parameter in the Hub.
          *   Change UTXO to `relayer_kaspa_account`.
      *   **Payload:** The tx payload should encode `L_next_hub = HyperlaneMessage.???`. Where to find a transaction index? What is a transaction index?
      *   If PSKT construction is successful:
          *   Add the `PSKT<Signer>` to `prepared_pskts`.
          *   Update `last_processed_l_for_this_batch = withdrawal_detail.withdrawal_id`.
          *   Update `current_kaspa_anchor_utxo_to_spend` to be the new change UTXO created for the escrow in the PSKT just built.
      *   If PSKT construction fails (e.g., insufficient funds even after trying to gather more UTXOs):
          *   Decide on error handling. Maybe stop batching and return what's prepared so far, or return an error.

3.  **Return:**
    *   If `prepared_pskts` is not empty, return `Ok(Some(prepared_pskts))`.
    *   Otherwise (no valid new withdrawals or an issue occurred), return `Ok(None)`.

**Notes for `F()`:**
*   Error handling for RPC calls and insufficient funds needs to be robust.
*   The exact format of the Kaspa transaction and its payload to be defined.
*   Where to find a transaction index for `L`? What is a transaction index?
*   We might need to filter `EventDispatch` by the destination domain. The list of currrent mainnet domains is the following: https://docs.hyperlane.xyz/docs/reference/domains.

> **Why the `hub_height` parameter?** Hub query endpoints (see `x/kas/query.proto`); passing the height from the relayer loop guarantees we query a stable view.

## Function `G()` - Validator Library

**Location (Suggested):** `dymension/libs/kaspa/lib/validator/src/validate_unescrow.rs` (new file).

**Purpose:**
To validate a batch of `PSKT<Signer>` objects proposed by the Relayer for an unescrow operation. For the POC, this function will be a passthrough.

**Conceptual Signature:**

```rust
// In dymension/libs/kaspa/lib/validator/src/validate_unescrow.rs
use kaspa_wallet_pskt::PSKT;
use kaspa_wallet_pskt::Signer;
use anyhow::Result;

// Define these types based on your actual Hub interaction needs
// Re-using HubKaspaState from F() for consistency, if needed for full validation.
// use crate::relayer_types::{HubKaspaState, HubQuerier}; // Example, adjust path

#[allow(unused_variables)]
pub async fn validate_kaspa_unescrow_pskts(
    pskts_from_relayer: &Vec<PSKT<Signer>>,
    // current_hub_state: &HubKaspaState, // Needed for full validation
    // hub_querier: HubQuerier, // Needed for full validation
) -> Result<bool> {
    // POC Implementation:
    if pskts_from_relayer.is_empty() {
        // Or handle as an error, depending on expected behavior
        // For POC, if there's nothing to validate, it's not "Ok(true)" for signing.
        return Ok(false);
    }
    // For POC, always return true if there's at least one PSKT.
    Ok(true)
}
```

**Core Logic for `validate_kaspa_unescrow_pskts` (`G()`):**

1.  **POC Implementation:**
    *   As per the workflow: `Validator call G(batch of PSKT<Signer>) to get Ok(true) [no validations]`.
    *   The function simply returns `Ok(true)` if `pskts_from_relayer` is not empty, or `Ok(false)` if it is, to indicate there's nothing to sign.

2.  **Full Implementation (Future - For Context):**
    *   Iterate through each `pskt` in `pskts_from_relayer`.
    *   **Verify Anchor (`O`):**
        *   For the first PSKT in a batch (or every PSKT if not strictly chained by relayer), ensure one of its inputs spends the `current_hub_state.current_anchor_outpoint`.
    *   **Verify `L'` Progression:**
        *   Extract `L_prime` from the PSKT's payload.
        *   Ensure `L_prime > current_hub_state.last_processed_withdrawal_index` (and also `L_prime > L_prime_from_previous_pskt_in_batch`).
    *   **Verify Hub Withdrawal Message:**
        *   Use `L_prime` (or another identifier from PSKT if available) to query the Hub via `hub_querier`.
        *   Confirm the withdrawal exists, is for the correct user and amount as reflected in the PSKT outputs.
        *   Confirm the withdrawal is not yet marked as processed on the Hub.
    *   **Verify PSKT Outputs:**
        *   User receives the correct amount.
        *   A new change UTXO is created for the escrow address (this will be the next `O`).
    *   **Verify PSKT Inputs:**
        *   Sufficient value is provided.
        *   Signatures required match the escrow's multisig setup (though actual signing is later).
    *   **Batch Chaining:** If multiple PSKTs, ensure the escrow change output of `PSKT_i` is an input to `PSKT_i+1`.
    *   If any validation fails, return `Err(...)` or `Ok(false)`.
    *   If all validations pass, return `Ok(true)`.

**Notes for `G()`:**
*   The POC is trivial. The complexity lies in the future full validation.
*   Access to Hub state (`O`, `L`) and a Hub querier is essential for full validation.
*   The validator needs to understand the structure of the PSKTs created by `F()`, especially the payload containing `L'`.
