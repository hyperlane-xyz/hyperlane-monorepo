// We call the signers 'validators'

use corelib::escrow::*;
use std::collections::hash_map::Entry;

use kaspa_core;
use kaspa_wallet_core::error::Error;

use kaspa_wallet_pskt::prelude::*;
use secp256k1::Keypair as SecpKeypair;

use crate::error::ValidationError;
use corelib::payload::{MessageID, MessageIDs};
use corelib::util::{get_recipient_address, get_recipient_script_pubkey};
use corelib::wallet::{EasyKaspaWallet, NetworkInfo};
use corelib::withdraw::{filter_pending_withdrawals, WithdrawFXG};
use eyre::{Report, Result};
use hex::ToHex;
use hyperlane_core::{Decode, HyperlaneMessage, H256, U256};
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{WithdrawalId, WithdrawalStatus};
use hyperlane_warp_route::TokenMessage;
use kaspa_addresses::{Address as KaspaAddress, Prefix as KaspaAddrPrefix};
use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};
use kaspa_consensus_core::mass::transaction_output_estimated_serialized_size;
use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionOutpoint, TransactionOutput};
use kaspa_hashes;
use kaspa_txscript::pay_to_address_script;
use kaspa_wallet_core::utxo::NetworkParams;
use std::collections::HashMap;
use std::io::Cursor;
use tracing::{debug, error, info, warn};

pub async fn validate_withdrawal_batch(
    fxg: &WithdrawFXG,
    cosmos_client: &CosmosGrpcClient,
    mailbox_id: String,
    address_prefix: KaspaAddrPrefix,
    escrow_public: EscrowPublic,
) -> Result<(), ValidationError> {
    let messages: Vec<HyperlaneMessage> = fxg.messages.clone().into_iter().flatten().collect();

    debug!(
        "Starting withdrawal validation for {} messages",
        messages.len()
    );

    // Step 1: Check that all messages are delivered
    for message in &messages {
        let delivered_response = cosmos_client
            .delivered(mailbox_id.clone(), message.id().encode_hex())
            .await
            .map_err(|e| ValidationError::SystemError(Report::from(e)))?;

        if !delivered_response.delivered {
            let message_id = message.id().encode_hex();
            return Err(ValidationError::MessageNotDelivered { message_id });
        }
    }

    debug!("All messages are delivered");

    let num_msgs = messages.len();

    // Step 2: All messages should be not processed on the Hub
    let (hub_outpoint, pending_messages) =
        filter_pending_withdrawals(messages, cosmos_client, None)
            .await
            .map_err(|e| eyre::eyre!("Get pending withdrawals: {}", e))?;

    // All given messages should be pending!
    if num_msgs != pending_messages.len() {
        return Err(ValidationError::MessagesNotUnprocessed);
    }

    validate_pskts(fxg, hub_outpoint, address_prefix, escrow_public)
        .map_err(|e| eyre::eyre!("PSKT validation failed: {}", e))?;

    info!(
        "Withdrawal validation completed successfully for {} withdrawals",
        num_msgs
    );

    Ok(())
}

pub fn validate_pskts(
    fxg: &WithdrawFXG,
    hub_outpoint: TransactionOutpoint,
    address_prefix: KaspaAddrPrefix,
    escrow_public: EscrowPublic,
) -> Result<(), ValidationError> {
    let relayer_hub_outpoint = fxg.anchors.first().unwrap();
    if relayer_hub_outpoint.index != hub_outpoint.index
        || relayer_hub_outpoint.transaction_id != hub_outpoint.transaction_id
    {
        return Err(ValidationError::HubOutpointNotFound { o: hub_outpoint });
    }

    let mut prev_outpoint = hub_outpoint;
    for (idx, pskt) in fxg.bundle.iter().enumerate() {
        let messages = fxg.messages.get(idx).unwrap();
        // +1 bc the first anchor is the hub anchor
        let outpoint = fxg.anchors.get(idx + 1).unwrap();

        // Get the next anchor UTXO
        let next_outpoint = validate_pskt(
            PSKT::<Signer>::from(pskt.clone()),
            prev_outpoint,
            messages,
            address_prefix,
            escrow_public.clone(),
        )?;

        // Compare field-by-field to avoid copying
        if next_outpoint.index != outpoint.index
            || next_outpoint.transaction_id != outpoint.transaction_id
        {
            return Err(ValidationError::AnchorMismatch { o: hub_outpoint });
        }

        // The next anchor UTXO is the prev anchor for the next transaction
        prev_outpoint = next_outpoint;
    }

    Ok(())
}

pub fn validate_pskt(
    pskt: PSKT<Signer>,
    hub_outpoint: TransactionOutpoint,
    pending_messages: &Vec<HyperlaneMessage>,
    address_prefix: KaspaAddrPrefix,
    escrow_public: EscrowPublic,
) -> Result<TransactionOutpoint, ValidationError> {
    // Step 3: Check PSKT payload
    let payload = MessageIDs(pending_messages.iter().map(|m| MessageID(m.id())).collect())
        .to_bytes()
        .map_err(|e| {
            ValidationError::SystemError(eyre::eyre!("Failed to serialize MessageIDs: {}", e))
        })?;

    let pskt_payload = pskt.global.payload.clone().unwrap_or(vec![]);

    if pskt_payload != payload {
        return Err(ValidationError::PayloadMismatch);
    }

    // Step 4: Check that PSKT contains the Hub outpoint as input
    let hub_outpoint_found = pskt.inputs.iter().any(|input| {
        input.previous_outpoint.transaction_id == hub_outpoint.transaction_id
            && input.previous_outpoint.index == hub_outpoint.index
    });

    if !hub_outpoint_found {
        return Err(ValidationError::HubOutpointNotFound { o: hub_outpoint });
    }

    // Step 5: Check that UTXO outputs align with withdrawals
    // Find escrow input amount
    let escrow_input_amount = pskt.inputs.iter().fold(0, |acc, i| {
        // redeem_script is None for relayer input
        let rs = i.redeem_script.clone().unwrap_or_default();
        return if rs == escrow_public.redeem_script {
            acc + i.utxo_entry.as_ref().unwrap().amount
        } else {
            acc
        };
    });

    // Construct a multiset of expected outputs from HL messages.
    // Key:   recipiend + amount
    // Value: number of entries
    //
    // Such structure accounts for cases where one address might send several transfers
    // with the same amount.
    let mut expected_outputs: HashMap<(u64, ScriptPublicKey), i32> = HashMap::new();

    for m in pending_messages {
        let tm = TokenMessage::read_from(&mut Cursor::new(&m.body))
            .map_err(|e| eyre::eyre!("Failed to parse TokenMessage from message body: {}", e))?;

        let recipient = get_recipient_script_pubkey(tm.recipient(), address_prefix);

        let key = (tm.amount().as_u64(), recipient);
        *expected_outputs.entry(key).or_default() += 1;
    }

    // Ensure that all HL messages have outputs.
    // Also, calculate the total output amount of withdrawals + escrow change,
    // it should match the input escrow amount.
    let mut escrow_output_amount = 0;
    let mut next_outpoint_idx: u32 = 0;
    for (idx, output) in pskt.outputs.iter().enumerate() {
        let key = (output.amount, output.script_public_key.clone());

        let e = expected_outputs.entry(key).and_modify(|v| *v -= 1);
        if let Entry::Occupied(e) = e {
            escrow_output_amount += output.amount;
            if *e.get() == 0 {
                e.remove();
            }
            continue;
        }

        if output.script_public_key == escrow_public.p2sh {
            escrow_output_amount += output.amount;
            next_outpoint_idx = idx as u32;
        }
    }

    if !expected_outputs.is_empty() {
        return Err(ValidationError::MissingOutputs);
    }

    if escrow_input_amount != escrow_output_amount {
        return Err(ValidationError::EscrowAmountMismatch {
            input_amount: escrow_input_amount,
            output_amount: escrow_output_amount,
        });
    }

    Ok(TransactionOutpoint::new(
        pskt.calculate_id(),
        next_outpoint_idx,
    ))
}

pub fn sign_withdrawal_fxg(fxg: &WithdrawFXG, keypair: &SecpKeypair) -> Result<Bundle> {
    let mut signed = Vec::new();
    // Iterate over (PSKT; associated HL messages) pairs
    for (pskt, hl_messages) in fxg.bundle.iter().zip(fxg.messages.clone().into_iter()) {
        let pskt = PSKT::<Signer>::from(pskt.clone());

        let signed_pskt = corelib::pskt::sign_pskt(pskt, keypair, None)?;

        signed.push(signed_pskt);
    }
    info!("Validator: signed pskts");
    let bundle = Bundle::from(signed);
    Ok(bundle)
}
