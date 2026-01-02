use crate::ops::payload::MessageIDs;
use crate::validator::error::ValidationError;
use crate::validator::withdraw::{safe_bundle, sign_withdrawal_fxg};
use dym_kas_core::escrow::EscrowPublic;
use dym_kas_core::pskt::is_valid_sighash_type;
use eyre::Result;
use hyperlane_cosmos::native::ModuleQueryClient;
use kaspa_bip32::secp256k1::Keypair as SecpKeypair;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_hashes::Hash as KaspaHash;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::pskt::{Input, Signer, PSKT};
use tracing::info;

/// Validate and sign a migration PSKT.
///
/// Migration TX requirements:
/// - Must spend the current Hub anchor
/// - Must have empty payload (no message IDs)
/// - Must output to new_escrow address
/// - Rotation must be configured and switch_timestamp must have passed
pub async fn validate_sign_migration<F, Fut>(
    bundle: Bundle,
    cosmos: &ModuleQueryClient,
    old_escrow: EscrowPublic,
    new_escrow: EscrowPublic,
    is_rotation_active: bool,
    load_key: F,
) -> Result<Bundle>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<SecpKeypair>>,
{
    // Rotation must be active
    if !is_rotation_active {
        return Err(eyre::eyre!(
            "Migration not allowed: switch_timestamp has not passed"
        ));
    }

    // Bundle should contain exactly one PSKT for migration
    if bundle.0.len() != 1 {
        return Err(eyre::eyre!(
            "Migration bundle must contain exactly one PSKT, got {}",
            bundle.0.len()
        ));
    }

    let b =
        safe_bundle(&bundle).map_err(|e| eyre::eyre!("Safe bundle validation failed: {e:?}"))?;

    // Get current hub anchor
    let hub_anchor = get_hub_anchor(cosmos).await?;

    // Validate the migration PSKT
    validate_migration_pskt(
        PSKT::<Signer>::from(b.0[0].clone()),
        hub_anchor,
        &old_escrow,
        &new_escrow,
    )?;

    info!("Migration validation passed, signing with old escrow");

    // Sign using OLD escrow redeem script (since funds are still at old escrow)
    let input_selector = move |i: &Input| match i.redeem_script.as_ref() {
        Some(rs) => rs == &old_escrow.redeem_script,
        None => false,
    };

    let signed_bundle = sign_withdrawal_fxg(&b, load_key, Some(input_selector))
        .await
        .map_err(|e| eyre::eyre!("sign migration PSKT: {e}"))?;

    Ok(signed_bundle)
}

async fn get_hub_anchor(cosmos: &ModuleQueryClient) -> Result<TransactionOutpoint> {
    // Query with empty withdrawal list to get current anchor
    let response = cosmos
        .withdrawal_status(vec![], None)
        .await
        .map_err(|e| eyre::eyre!("query hub anchor: {}", e))?;

    let outpoint = response
        .outpoint
        .ok_or_else(|| eyre::eyre!("Hub anchor not set (no outpoint in response)"))?;

    if outpoint.transaction_id.len() != 32 {
        return Err(eyre::eyre!(
            "Invalid anchor tx_id length: expected 32, got {}",
            outpoint.transaction_id.len()
        ));
    }

    let tx_id_bytes: [u8; 32] = outpoint
        .transaction_id
        .try_into()
        .map_err(|_| eyre::eyre!("Invalid anchor tx_id conversion"))?;

    let kaspa_tx_id = KaspaHash::from_bytes(tx_id_bytes);

    Ok(TransactionOutpoint::new(kaspa_tx_id, outpoint.index))
}

fn validate_migration_pskt(
    pskt: PSKT<Signer>,
    hub_anchor: TransactionOutpoint,
    old_escrow: &EscrowPublic,
    new_escrow: &EscrowPublic,
) -> Result<(), ValidationError> {
    // Validate sighash types
    if pskt
        .inputs
        .iter()
        .any(|input| !is_valid_sighash_type(input.sighash_type))
    {
        return Err(ValidationError::SigHashType);
    }

    // Must spend the hub anchor
    let anchor_found = pskt
        .inputs
        .iter()
        .any(|input| input.previous_outpoint == hub_anchor);

    if !anchor_found {
        return Err(ValidationError::AnchorNotFound { o: hub_anchor });
    }

    // Must have empty payload (no messages)
    let payload = pskt.global.payload.clone().unwrap_or_default();
    let expected_payload = MessageIDs::new(vec![]).to_bytes();

    if payload != expected_payload {
        return Err(ValidationError::PayloadMismatch);
    }

    // All escrow inputs must be from old escrow
    for input in &pskt.inputs {
        if let Some(rs) = &input.redeem_script {
            if rs != &old_escrow.redeem_script && rs != &new_escrow.redeem_script {
                // This is not an escrow input (probably relayer fee input), skip
                continue;
            }
            if rs == &new_escrow.redeem_script {
                return Err(ValidationError::FailedGeneralVerification {
                    reason: "Migration TX cannot spend from new escrow".to_string(),
                });
            }
        }
    }

    // Must have output to new escrow
    let has_new_escrow_output = pskt
        .outputs
        .iter()
        .any(|output| output.script_public_key == new_escrow.p2sh);

    if !has_new_escrow_output {
        return Err(ValidationError::FailedGeneralVerification {
            reason: "Migration TX must have output to new escrow address".to_string(),
        });
    }

    // Must NOT have output to old escrow (all funds should move to new escrow)
    let has_old_escrow_output = pskt
        .outputs
        .iter()
        .any(|output| output.script_public_key == old_escrow.p2sh);

    if has_old_escrow_output {
        return Err(ValidationError::FailedGeneralVerification {
            reason: "Migration TX must not have output to old escrow address".to_string(),
        });
    }

    info!(
        tx_id = %pskt.calculate_id(),
        "Migration PSKT validated successfully"
    );

    Ok(())
}
