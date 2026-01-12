use crate::ops::migration::MigrationFXG;
use crate::ops::payload::MessageIDs;
use crate::ops::withdraw::query_hub_anchor;
use crate::validator::error::ValidationError;
use crate::validator::withdraw::{
    calculate_escrow_input_sum, escrow_input_selector, safe_bundle, sign_pskt_bundle,
};
use dym_kas_core::escrow::EscrowPublic;
use dym_kas_core::pskt::is_valid_sighash_type;
use eyre::Result;
use hyperlane_cosmos::native::ModuleQueryClient;
use kaspa_addresses::Address;
use kaspa_bip32::secp256k1::Keypair as SecpKeypair;
use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionOutpoint};
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_txscript::pay_to_address_script;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::pskt::{Signer, PSKT};
use tracing::info;

/// UTXO with outpoint and amount from Kaspa query.
#[derive(Debug, Clone)]
struct UtxoWithAmount {
    outpoint: TransactionOutpoint,
    amount: u64,
}

/// Validate and sign a migration PSKT.
///
/// Migration validation checks:
/// 1. Query hub for current anchor and verify PSKT spends it
/// 2. Query Kaspa for ALL escrow UTXOs and verify PSKT spends ALL of them with correct amounts
/// 3. Verify exactly ONE output goes to the configured migration target address
/// 4. Verify escrow funds are 100% preserved (escrow_input_sum == target_output)
/// 5. Verify payload is empty MessageIDs (no withdrawals processed)
/// 6. Allow relayer fee inputs (non-escrow inputs are permitted)
/// 7. Allow relayer change outputs (additional outputs beyond migration target)
pub async fn validate_sign_migration_fxg<F, Fut, R>(
    fxg: MigrationFXG,
    escrow_public: EscrowPublic,
    migration_target_address: &Address,
    hub_rpc: &ModuleQueryClient,
    kaspa_rpc: &R,
    load_key: F,
) -> Result<Bundle>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<SecpKeypair>>,
    R: RpcApi + ?Sized,
{
    let bundle = safe_bundle(&fxg.bundle)
        .map_err(|e| eyre::eyre!("Safe bundle validation failed: {e:?}"))?;

    validate_migration_bundle(
        &bundle,
        &escrow_public,
        migration_target_address,
        hub_rpc,
        kaspa_rpc,
    )
    .await?;

    info!("Validator: migration PSKT is valid");

    // Sign escrow inputs using the same selector as withdrawals
    let signed = sign_pskt_bundle(
        &bundle,
        load_key,
        Some(escrow_input_selector(&escrow_public)),
    )
    .await
    .map_err(|e| eyre::eyre!("Failed to sign migration: {e}"))?;

    Ok(signed)
}

async fn validate_migration_bundle<R>(
    bundle: &Bundle,
    escrow_public: &EscrowPublic,
    migration_target_address: &Address,
    hub_rpc: &ModuleQueryClient,
    kaspa_rpc: &R,
) -> Result<(), ValidationError>
where
    R: RpcApi + ?Sized,
{
    // Migration must be a single PSKT - no chaining needed for migration
    if bundle.0.len() != 1 {
        return Err(ValidationError::FailedGeneralVerification {
            reason: format!(
                "Migration bundle must contain exactly 1 PSKT, got {}",
                bundle.0.len()
            ),
        });
    }

    // Query hub for current anchor (uses withdrawal_status with empty list)
    let hub_anchor =
        query_hub_anchor(hub_rpc)
            .await
            .map_err(|e| ValidationError::HubQueryError {
                reason: e.to_string(),
            })?;
    info!(
        tx_id = %hub_anchor.transaction_id,
        index = hub_anchor.index,
        "Migration: got hub anchor"
    );

    // Query Kaspa for ALL escrow UTXOs (with amounts for verification)
    let escrow_utxos = query_escrow_utxos_with_amounts(kaspa_rpc, &escrow_public.addr).await?;
    info!(
        utxo_count = escrow_utxos.len(),
        "Migration: got escrow UTXOs"
    );

    if escrow_utxos.is_empty() {
        return Err(ValidationError::FailedGeneralVerification {
            reason: "No UTXOs found at escrow address".to_string(),
        });
    }

    let target_script = pay_to_address_script(migration_target_address);
    let pskt_inner =
        bundle
            .iter()
            .next()
            .ok_or_else(|| ValidationError::FailedGeneralVerification {
                reason: "Bundle was empty".to_string(),
            })?;
    let pskt = PSKT::<Signer>::from(pskt_inner.clone());

    validate_migration_pskt(
        &pskt,
        &hub_anchor,
        &escrow_utxos,
        escrow_public,
        &target_script,
    )?;

    Ok(())
}

async fn query_escrow_utxos_with_amounts<R>(
    kaspa_rpc: &R,
    escrow_addr: &Address,
) -> Result<Vec<UtxoWithAmount>, ValidationError>
where
    R: RpcApi + ?Sized,
{
    let utxos = kaspa_rpc
        .get_utxos_by_addresses(vec![escrow_addr.clone()])
        .await
        .map_err(|e| ValidationError::FailedGeneralVerification {
            reason: format!("Query Kaspa escrow UTXOs: {}", e),
        })?;

    Ok(utxos
        .into_iter()
        .map(|u| UtxoWithAmount {
            outpoint: TransactionOutpoint::from(u.outpoint),
            amount: u.utxo_entry.amount,
        })
        .collect())
}

fn validate_migration_pskt(
    pskt: &PSKT<Signer>,
    hub_anchor: &TransactionOutpoint,
    escrow_utxos: &[UtxoWithAmount],
    escrow_public: &EscrowPublic,
    target_script: &ScriptPublicKey,
) -> Result<(), ValidationError> {
    // Check sighash types
    if pskt
        .inputs
        .iter()
        .any(|input| !is_valid_sighash_type(input.sighash_type))
    {
        return Err(ValidationError::SigHashType);
    }

    // Verify hub anchor is spent
    let spends_hub_anchor = pskt
        .inputs
        .iter()
        .any(|i| &i.previous_outpoint == hub_anchor);

    if !spends_hub_anchor {
        return Err(ValidationError::AnchorNotFound { o: *hub_anchor });
    }

    // Verify ALL escrow UTXOs are spent with correct amounts
    for expected in escrow_utxos {
        let input = pskt
            .inputs
            .iter()
            .find(|i| i.previous_outpoint == expected.outpoint)
            .ok_or_else(|| ValidationError::FailedGeneralVerification {
                reason: format!(
                    "Migration PSKT missing escrow UTXO: {}:{}",
                    expected.outpoint.transaction_id, expected.outpoint.index
                ),
            })?;

        // Verify UTXO entry exists (don't silently default to 0)
        let utxo_entry = input.utxo_entry.as_ref().ok_or_else(|| {
            ValidationError::FailedGeneralVerification {
                reason: format!(
                    "Migration PSKT input {}:{} missing UTXO entry",
                    expected.outpoint.transaction_id, expected.outpoint.index
                ),
            }
        })?;

        // Verify amount matches what Kaspa reports
        if utxo_entry.amount != expected.amount {
            return Err(ValidationError::FailedGeneralVerification {
                reason: format!(
                    "Migration PSKT input {}:{} amount mismatch: PSKT={}, Kaspa={}",
                    expected.outpoint.transaction_id,
                    expected.outpoint.index,
                    utxo_entry.amount,
                    expected.amount
                ),
            });
        }
    }

    // Relayer fee inputs are allowed - we only need to verify:
    // 1. All escrow UTXOs are spent (checked above)
    // 2. Hub anchor is spent (checked above)
    // 3. Non-escrow inputs are permitted (relayer pays fees from their own UTXOs)

    // Verify payload is empty MessageIDs (migration TX processes no withdrawals)
    let expected_payload = MessageIDs::new(vec![]).to_bytes();
    let actual_payload = pskt.global.payload.clone().unwrap_or_default();

    if actual_payload != expected_payload {
        return Err(ValidationError::FailedGeneralVerification {
            reason: "Migration PSKT payload must be empty MessageIDs".to_string(),
        });
    }

    // Calculate escrow input sum
    let escrow_input_sum = calculate_escrow_input_sum(pskt, escrow_public);

    // Find exactly ONE output to migration target with correct amount
    // Additional outputs are allowed (relayer change from fee inputs)
    let target_outputs: Vec<_> = pskt
        .outputs
        .iter()
        .filter(|o| &o.script_public_key == target_script)
        .collect();

    if target_outputs.len() != 1 {
        return Err(ValidationError::FailedGeneralVerification {
            reason: format!(
                "Migration PSKT must have exactly 1 output to target address, got {}",
                target_outputs.len()
            ),
        });
    }

    let target_output_amount = target_outputs[0].amount;

    // Verify escrow funds are 100% preserved: escrow_input_sum == target_output
    // Relayer pays fees from their own inputs, so escrow funds should be fully transferred
    if escrow_input_sum != target_output_amount {
        return Err(ValidationError::EscrowAmountMismatch {
            input_amount: escrow_input_sum,
            output_amount: target_output_amount,
        });
    }

    // Calculate total for logging (includes relayer fee inputs)
    let total_inputs_sum: u64 = escrow_utxos.iter().map(|u| u.amount).sum();

    info!(
        escrow_input_sum,
        target_output_amount,
        total_inputs_sum,
        num_outputs = pskt.outputs.len(),
        "Migration PSKT validated: escrow funds fully preserved"
    );

    Ok(())
}
