# Draft Implementation: F() and G() for Hub -> Kaspa Unescrow Flow

This document outlines the draft implementation for the library functions `F()` (used by the Relayer) and `G()` (used by the Validator) in the context of the Hub to Kaspa unescrow (withdrawal) flow for the Kaspa-Hyperlane bridge.

## Function `F()` - Relayer Library

**Location (Suggested):** `dymension/libs/kaspa/lib/relayer/src/hub_to_kaspa_builder.rs` (new file) or extend `dymension/libs/kaspa/lib/relayer/src/withdraw.rs`.

**Purpose:**
To observe withdrawal messages dispatched on the Hub and construct the necessary Kaspa Partially Signed Kaspa Transactions (`PSKT<Signer>`) to fulfill these withdrawals from the Kaspa escrow.

**Conceptual Signature:**

```rust
// In dymension/libs/kaspa/lib/relayer/src/hub_to_kaspa_builder.rs
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_wallet_core::account::Account;
use kaspa_wallet_pskt::PSKT;
use kaspa_wallet_pskt::Signer;
use std::sync::Arc;
use anyhow::Result;
use core::escrow::EscrowPublic; // Corrected import
use kaspa_consensus_core::tx::TransactionOutpoint as KaspaUtxoOutpoint;


// Define these types based on your actual Hub interaction needs
pub type HubWithdrawalMessageId = String; // Or a more specific type
pub type HubQuerier = Arc<dyn Fn(HubWithdrawalMessageId) -> Result<HubWithdrawalDetails, anyhow::Error> + Send + Sync>; // Placeholder, ensure Send + Sync for async
// pub type EscrowPublic = crate::core::escrow::EscrowPublic; // Corrected type name - now imported above
// pub type KaspaUtxoOutpoint = kaspa_consensus_core::tx::TransactionOutpoint; // More specific type - aliased above

// Represents the state (O, L) fetched from the Hub's x/kas module
#[derive(Debug, Clone)]
pub struct HubKaspaState {
    pub current_anchor_outpoint: KaspaUtxoOutpoint, // O: Full outpoint (txid, index)
    pub last_processed_withdrawal_index: u64, // L
}

// Details of a withdrawal fetched from the Hub
#[derive(Debug, Clone)]
pub struct HubWithdrawalDetails {
    pub withdrawal_id: u64, // Corresponds to L'
    pub user_kaspa_address: kaspa_addresses::Address,
    pub amount_satoshi: u64,
}

#[allow(unused_variables)]
pub async fn build_kaspa_withdrawal_pskts(
    hub_withdrawal_ids: Vec<HubWithdrawalMessageId>, // Support batching from Hub side
    kaspa_rpc: &impl RpcApi,
    escrow_public: &EscrowPublic, // Corrected type name
    relayer_kaspa_account: &Arc<dyn Account>,
    current_hub_state: &HubKaspaState,
    hub_querier: HubQuerier, // To fetch withdrawal details from the Hub
) -> Result<Option<Vec<PSKT<Signer>>>> {
    // TODO: Implementation based on Core Logic described below
    // 1. Initialization
    // 2. Filter and Sort Hub Withdrawals
    // 3. Iterate and Build PSKTs (Batching Logic)
    //    - Leverage/Adapt dymension/libs/kaspa/lib/relayer/src/withdraw.rs::build_withdrawal_tx
    // 4. Return prepared_pskts or None
    Ok(None) // Placeholder
}
```

**Core Logic for `build_kaspa_withdrawal_pskts` (`F()`):**

1.  **Initialization:**
    *   Create an empty list `prepared_pskts: Vec<PSKT<Signer>>`.
    *   Keep track of the `current_kaspa_anchor_utxo_to_spend` (initially from `current_hub_state.current_anchor_outpoint`).
    *   Keep track of `last_processed_l_for_this_batch` (initially `current_hub_state.last_processed_withdrawal_index`).

2.  **Filter and Sort Hub Withdrawals:**
    *   For each `hub_withdrawal_id` in `hub_withdrawal_ids`:
        *   Use `hub_querier` to fetch `HubWithdrawalDetails`.
        *   Filter out withdrawals where `withdrawal_id <= current_hub_state.last_processed_withdrawal_index`.
    *   Sort the valid new withdrawals by their `withdrawal_id` (ascending) to process them in order.

3.  **Iterate and Build PSKTs (Batching Logic):**
    *   For each `withdrawal_detail` in the sorted list:
        *   **Check Anchor UTXO on Kaspa:**
            *   Query `kaspa_rpc` to ensure `current_kaspa_anchor_utxo_to_spend` is still unspent.
            *   *If spent by an unexpected transaction (not by a previous TX in this batch):* This indicates a potential state mismatch or race condition. The ADR theory suggests updating the Hub first. For `F()`, this might mean returning `Ok(None)` or an error, signaling the Relayer agent to handle the O/L update on the Hub. For POC, we might simplify and assume it's unspent or error out.
        *   **Construct Single PSKT (Leverage/Adapt `dymension/libs/kaspa/lib/relayer/src/withdraw.rs::build_withdrawal_tx`):**
            *   **Inputs:**
                *   The `current_kaspa_anchor_utxo_to_spend`.
                *   Additional UTXOs from the escrow if the anchor is insufficient (query `kaspa_rpc` for `escrow_public.addr`).
                *   A UTXO from `relayer_kaspa_account` for relayer-paid fees.
            *   **Outputs:**
                *   `withdrawal_detail.amount_satoshi` to `withdrawal_detail.user_kaspa_address`.
                *   A new change UTXO back to `escrow_public.addr`. This UTXO becomes the `current_kaspa_anchor_utxo_to_spend` for the *next* PSKT in the batch.
                *   Change UTXO to `relayer_kaspa_account`.
            *   **Payload:** The Kaspa transaction payload should encode `L_prime = withdrawal_detail.withdrawal_id`.
            *   The `build_withdrawal_tx` function needs modification to:
                *   Accept a specific anchor UTXO to spend.
                *   Accept the `L_prime` to put in the payload.
                *   Return the details of the new escrow change UTXO (which becomes the next anchor).
        *   If PSKT construction is successful:
            *   Add the `PSKT<Signer>` to `prepared_pskts`.
            *   Update `last_processed_l_for_this_batch = withdrawal_detail.withdrawal_id`.
            *   Update `current_kaspa_anchor_utxo_to_spend` to be the new change UTXO created for the escrow in the PSKT just built.
        *   If PSKT construction fails (e.g., insufficient funds even after trying to gather more UTXOs):
            *   Decide on error handling. Maybe stop batching and return what's prepared so far, or return an error.

4.  **Return:**
    *   If `prepared_pskts` is not empty, return `Ok(Some(prepared_pskts))`.
    *   Otherwise (no valid new withdrawals or an issue occurred), return `Ok(None)`.

**Notes for `F()`:**
*   The "business logic as described on epic in detail" is crucial here, especially around UTXO management, fee calculation, and how strictly to adhere to using the Hub's `O` if Kaspa's state has diverged.
*   Error handling for RPC calls and insufficient funds needs to be robust.
*   The exact format of the Kaspa transaction payload for `L'` needs to be defined.

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
