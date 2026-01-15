//! Startup verification for Kaspa validators.
//!
//! This module provides safety checks that run during validator initialization
//! to detect configuration mismatches that could lead to operational issues.

use crate::ops::withdraw::query_hub_anchor;
use dym_kas_core::api::client::HttpClient;
use eyre::Result;
use hyperlane_cosmos::native::ModuleQueryClient;
use kaspa_addresses::Address;
use tracing::{info, warn};

/// Error returned when validator escrow configuration doesn't match the hub anchor.
#[derive(Debug, thiserror::Error)]
pub enum StartupVerificationError {
    #[error(
        "Escrow configuration mismatch: Hub anchor is at address {hub_anchor_address}, \
         but validator is configured with escrow {configured_escrow}. \
         This likely means the validator config was not updated after an escrow migration. \
         Please update kaspaValidatorsEscrow configuration to match the current escrow."
    )]
    EscrowConfigMismatch {
        hub_anchor_address: String,
        configured_escrow: String,
    },

    #[error("Hub query error: {reason}")]
    HubQueryError { reason: String },

    #[error("Kaspa query error: {reason}")]
    KaspaQueryError { reason: String },

    #[error("Anchor output not found at index {index} in transaction {tx_id}")]
    AnchorOutputNotFound { tx_id: String, index: u32 },
}

/// Verifies that the validator's configured escrow address matches the hub's
/// current anchor address.
///
/// This check prevents a common misconfiguration after escrow migration:
/// 1. Validator enters migration mode and signs migration TX
/// 2. Migration completes, funds move to new escrow
/// 3. Validator restarts but forgets to update escrow config
/// 4. Without this check, validator would operate with stale config
///
/// The hub anchor is the source of truth - it always points to a UTXO in the
/// current escrow. If our configured escrow doesn't match where the anchor is,
/// our configuration is stale.
///
/// # Arguments
/// * `hub_rpc` - Client to query the Dymension hub
/// * `kaspa_rest` - Client to query Kaspa REST API
/// * `configured_escrow` - The escrow address from validator config
///
/// # Returns
/// * `Ok(())` - Configuration is valid
/// * `Err(StartupVerificationError::EscrowConfigMismatch)` - Configuration is stale
/// * `Err(_)` - Query failed (hub not reachable, etc.)
///
/// # Behavior when hub is not bootstrapped
/// If the hub's x/kas module is not yet bootstrapped (no anchor exists),
/// this check is skipped with a warning. This allows validators to start
/// before the bridge is initialized.
pub async fn verify_escrow_matches_hub_anchor(
    hub_rpc: &ModuleQueryClient,
    kaspa_rest: &HttpClient,
    configured_escrow: &Address,
) -> Result<(), StartupVerificationError> {
    // Check if hub is bootstrapped (has an anchor)
    let hub_bootstrapped =
        hub_rpc
            .hub_bootstrapped()
            .await
            .map_err(|e| StartupVerificationError::HubQueryError {
                reason: e.to_string(),
            })?;

    if !hub_bootstrapped {
        warn!(
            "Hub x/kas module not bootstrapped yet, skipping escrow configuration verification. \
             This is expected during initial bridge setup."
        );
        return Ok(());
    }

    // Query hub for current anchor
    let hub_anchor =
        query_hub_anchor(hub_rpc)
            .await
            .map_err(|e| StartupVerificationError::HubQueryError {
                reason: e.to_string(),
            })?;

    info!(
        tx_id = %hub_anchor.transaction_id,
        index = hub_anchor.index,
        "Startup verification: queried hub anchor"
    );

    // Fetch the transaction that created this anchor from Kaspa
    let tx = kaspa_rest
        .get_tx_by_id(&hub_anchor.transaction_id.to_string())
        .await
        .map_err(|e| StartupVerificationError::KaspaQueryError {
            reason: format!("Query anchor TX: {}", e),
        })?;

    // Get the output at the anchor index
    let outputs = tx
        .outputs
        .ok_or_else(|| StartupVerificationError::KaspaQueryError {
            reason: "Anchor TX has no outputs field".to_string(),
        })?;

    let anchor_output = outputs.get(hub_anchor.index as usize).ok_or_else(|| {
        StartupVerificationError::AnchorOutputNotFound {
            tx_id: hub_anchor.transaction_id.to_string(),
            index: hub_anchor.index,
        }
    })?;

    // Extract address from the anchor output
    let anchor_address = anchor_output
        .script_public_key_address
        .as_ref()
        .ok_or_else(|| StartupVerificationError::KaspaQueryError {
            reason: "Anchor output missing script_public_key_address".to_string(),
        })?;

    let configured_escrow_str = configured_escrow.to_string();

    // Compare addresses
    if anchor_address != &configured_escrow_str {
        return Err(StartupVerificationError::EscrowConfigMismatch {
            hub_anchor_address: anchor_address.clone(),
            configured_escrow: configured_escrow_str,
        });
    }

    info!(
        escrow_address = %configured_escrow_str,
        "Startup verification passed: escrow config matches hub anchor"
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: Integration tests would require mocking the hub and kaspa clients.
    // The verification logic is straightforward address comparison, so we focus
    // on testing the error messages are clear and actionable.

    #[test]
    fn test_escrow_mismatch_error_message_is_actionable() {
        let err = StartupVerificationError::EscrowConfigMismatch {
            hub_anchor_address: "kaspatest:pznew123".to_string(),
            configured_escrow: "kaspatest:pzold456".to_string(),
        };

        let msg = err.to_string();

        // Error message should mention the key facts
        assert!(msg.contains("kaspatest:pznew123"));
        assert!(msg.contains("kaspatest:pzold456"));
        assert!(msg.contains("escrow migration"));
        assert!(msg.contains("kaspaValidatorsEscrow"));
    }
}
