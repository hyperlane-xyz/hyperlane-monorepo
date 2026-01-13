use dymension_kaspa::relayer::execute_migration;
use dymension_kaspa::KaspaProvider;
use eyre::Result;
use hyperlane_core::{ChainResult, Signature};
use hyperlane_cosmos::native::CosmosNativeMailbox;
use std::time::Duration;
use tracing::{error, info};

use super::ensure_hub_synced;

/// Execute escrow key migration with retry loop and hub sync.
///
/// This function:
/// 1. Optionally syncs hub before migration (handles edge case where anchor is already spent)
/// 2. Executes the migration transaction
/// 3. Syncs hub after migration (required to update anchor to new escrow)
/// 4. Retries on failure with fixed 1 minute delay
///
/// # Arguments
/// * `provider` - Kaspa provider
/// * `hub_mailbox` - Hub mailbox for sync operations
/// * `new_escrow_address` - Target escrow address for migration
/// * `format_signatures` - Closure to format signatures for hub submission
pub async fn run_migration_with_sync<F>(
    provider: &KaspaProvider,
    hub_mailbox: &CosmosNativeMailbox,
    new_escrow_address: &str,
    format_signatures: F,
) -> Result<Vec<String>>
where
    F: Fn(&mut Vec<Signature>) -> ChainResult<Vec<u8>>,
{
    let target_addr: dymension_kaspa::KaspaAddress = new_escrow_address
        .try_into()
        .map_err(|e| eyre::eyre!("Invalid target address '{}': {}", new_escrow_address, e))?;

    let old_escrow = provider.escrow_address().to_string();
    let new_escrow = new_escrow_address.to_string();

    const MAX_ATTEMPTS: u32 = 10;
    let mut attempt = 0;

    loop {
        attempt += 1;
        info!(attempt, max_attempts = MAX_ATTEMPTS, "Migration attempt");

        // Step 1: Optional sync before migration
        // Handles edge case where hub anchor is already spent but not yet confirmed
        if let Err(e) = ensure_hub_synced(
            provider,
            hub_mailbox,
            &old_escrow,
            &old_escrow,
            &format_signatures,
        )
        .await
        {
            // Non-fatal: hub may already be synced or anchor may not be spent yet
            info!(error = ?e, "Pre-migration sync check (non-fatal)");
        }

        // Step 2: Execute migration
        let migration_result = execute_migration(provider, &target_addr).await;

        match migration_result {
            Ok(tx_ids) => {
                info!(tx_count = tx_ids.len(), "Migration transactions submitted");

                // Step 3: Required sync after migration to update hub anchor
                // Uses src=old_escrow, dst=new_escrow to trace across migration boundary
                match ensure_hub_synced(
                    provider,
                    hub_mailbox,
                    &old_escrow,
                    &new_escrow,
                    &format_signatures,
                )
                .await
                {
                    Ok(_) => {
                        info!("Post-migration hub sync completed");
                        return Ok(tx_ids.into_iter().map(|h| h.to_string()).collect());
                    }
                    Err(e) => {
                        error!(error = ?e, attempt, "Post-migration sync failed, will retry");
                    }
                }
            }
            Err(e) => {
                error!(error = ?e, attempt, "Migration failed, will retry");
            }
        }

        if attempt >= MAX_ATTEMPTS {
            return Err(eyre::eyre!(
                "Migration failed after {} attempts",
                MAX_ATTEMPTS
            ));
        }

        let delay = Duration::from_secs(60);
        info!(delay_secs = delay.as_secs(), "Waiting before retry");
        tokio::time::sleep(delay).await;
    }
}
