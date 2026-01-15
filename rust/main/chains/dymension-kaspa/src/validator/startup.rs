//! Startup verification for Kaspa validators.
//!
//! Safety checks that run during validator initialization to detect
//! configuration mismatches that could lead to operational issues.

use crate::ops::withdraw::query_hub_anchor;
use crate::providers::KaspaHttpClient;
use crate::util::get_output_address;
use crate::validator::error::ValidationError;
use hyperlane_cosmos::native::ModuleQueryClient;
use kaspa_addresses::Address;
use tracing::info;

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
pub async fn verify_escrow_matches_hub_anchor(
    hub_rpc: &ModuleQueryClient,
    kaspa_client: &KaspaHttpClient,
    configured_escrow: &Address,
) -> Result<(), ValidationError> {
    let hub_anchor =
        query_hub_anchor(hub_rpc)
            .await
            .map_err(|e| ValidationError::HubQueryError {
                reason: format!("Query hub anchor: {}", e),
            })?;

    info!(
        tx_id = %hub_anchor.transaction_id,
        index = hub_anchor.index,
        "Startup verification: queried hub anchor"
    );

    let tx = kaspa_client
        .client
        .get_tx_by_id(&hub_anchor.transaction_id.to_string())
        .await
        .map_err(|e| ValidationError::KaspaNodeError {
            reason: format!("Query anchor TX: {}", e),
        })?;

    let anchor_address = get_output_address(&tx, hub_anchor.index as usize)?;
    let configured_escrow_str = configured_escrow.to_string();

    if anchor_address != configured_escrow_str {
        return Err(ValidationError::EscrowConfigMismatch {
            hub_anchor_address: anchor_address,
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

    #[test]
    fn escrow_mismatch_error_is_actionable() {
        let err = ValidationError::EscrowConfigMismatch {
            hub_anchor_address: "kaspatest:pznew123".to_string(),
            configured_escrow: "kaspatest:pzold456".to_string(),
        };
        let msg = err.to_string();

        assert!(
            msg.contains("kaspatest:pznew123"),
            "Error should show hub anchor address"
        );
        assert!(
            msg.contains("kaspatest:pzold456"),
            "Error should show configured escrow"
        );
        assert!(
            msg.contains("escrow migration"),
            "Error should mention escrow migration"
        );
        assert!(
            msg.contains("kaspaValidatorsEscrow"),
            "Error should mention config field to update"
        );
    }
}
