use dymension_kaspa::relayer::execute_migration;
use dymension_kaspa::KaspaProvider;
use eyre::Result;
use hyperlane_core::{ChainResult, Signature};
use hyperlane_cosmos::native::CosmosNativeMailbox;
use std::time::Duration;
use tracing::{error, info};

use super::ensure_hub_synced;

const MAX_ATTEMPTS: u32 = 10;
const SYNC_DELAY_SECS: u64 = 10;
const RETRY_DELAY_SECS: u64 = 60;

/// Execute escrow key migration with retry loop and hub sync.
///
/// Handles two scenarios:
/// 1. Fresh migration: executes TX, waits for confirmation, syncs hub
/// 2. Resumed after prior migration: detects new escrow has funds, skips TX, syncs hub
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

    // Step 1: Attempt migration (may be skipped if already done)
    let tx_ids = execute_or_detect_migration(provider, &target_addr, &new_escrow).await?;

    // Step 2: Wait for TX confirmation then sync hub with retries
    info!(delay_secs = SYNC_DELAY_SECS, "Waiting for TX confirmation before hub sync");
    tokio::time::sleep(Duration::from_secs(SYNC_DELAY_SECS)).await;

    sync_hub_with_retries(provider, hub_mailbox, &old_escrow, &new_escrow, &format_signatures).await?;

    Ok(tx_ids)
}

/// Attempts migration. If old escrow is empty but new escrow has funds,
/// concludes migration already happened and returns success.
async fn execute_or_detect_migration(
    provider: &KaspaProvider,
    target_addr: &dymension_kaspa::KaspaAddress,
    new_escrow: &str,
) -> Result<Vec<String>> {
    for attempt in 1..=MAX_ATTEMPTS {
        info!(attempt, max_attempts = MAX_ATTEMPTS, "Migration attempt");

        match execute_migration(provider, target_addr).await {
            Ok(tx_ids) => {
                info!(tx_count = tx_ids.len(), "Migration transactions submitted");
                return Ok(tx_ids.into_iter().map(|h| h.to_string()).collect());
            }
            Err(e) => {
                // Check if migration already happened (old empty, new has funds)
                if new_escrow_has_funds(provider, new_escrow).await {
                    info!("Migration already completed (new escrow has funds), proceeding to sync");
                    return Ok(vec![]);
                }

                error!(error = ?e, attempt, "Migration failed, will retry");

                if attempt >= MAX_ATTEMPTS {
                    return Err(eyre::eyre!("Migration failed after {} attempts: {}", MAX_ATTEMPTS, e));
                }

                tokio::time::sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
            }
        }
    }
    unreachable!()
}

/// Retries hub sync until success or max attempts exhausted.
async fn sync_hub_with_retries<F>(
    provider: &KaspaProvider,
    hub_mailbox: &CosmosNativeMailbox,
    old_escrow: &str,
    new_escrow: &str,
    format_signatures: &F,
) -> Result<()>
where
    F: Fn(&mut Vec<Signature>) -> ChainResult<Vec<u8>>,
{
    for attempt in 1..=MAX_ATTEMPTS {
        match ensure_hub_synced(provider, hub_mailbox, old_escrow, new_escrow, format_signatures).await {
            Ok(_) => {
                info!("Post-migration hub sync completed");
                return Ok(());
            }
            Err(e) => {
                error!(error = ?e, attempt, "Post-migration sync failed");

                if attempt >= MAX_ATTEMPTS {
                    return Err(eyre::eyre!("Post-migration sync failed after {} attempts: {}", MAX_ATTEMPTS, e));
                }

                info!(delay_secs = RETRY_DELAY_SECS, "Waiting before sync retry");
                tokio::time::sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
            }
        }
    }
    unreachable!()
}

/// Check if the new escrow address has any UTXOs (indicating migration already happened).
async fn new_escrow_has_funds(provider: &KaspaProvider, new_escrow: &str) -> bool {
    let addr: dymension_kaspa::KaspaAddress = match new_escrow.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };

    let result = provider
        .wallet()
        .rpc_with_reconnect(|api| {
            let addr = addr.clone();
            async move {
                api.get_utxos_by_addresses(vec![addr])
                    .await
                    .map_err(|e| eyre::eyre!("check new escrow UTXOs: {}", e))
            }
        })
        .await;

    match result {
        Ok(utxos) => !utxos.is_empty(),
        Err(_) => false,
    }
}
