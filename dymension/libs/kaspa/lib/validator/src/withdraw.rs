// We call the signers 'validators'

use corelib::escrow::*;
use std::collections::hash_map::Entry;

use kaspa_core;
use kaspa_wallet_core::error::Error;

use kaspa_wallet_pskt::prelude::*;
use secp256k1::Keypair as SecpKeypair;

use crate::error::ValidationError;
use corelib::payload::{MessageID, MessageIDs};
use corelib::util;
use corelib::util::{check_sighash_type, get_recipient_address, get_recipient_script_pubkey};
use corelib::wallet::EasyKaspaWallet;
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

#[derive(Clone)]
pub struct MustMatch {
    address_prefix: KaspaAddrPrefix,
    escrow_public: EscrowPublic,
    partial_message: HyperlaneMessage,
    hub_mailbox_id: String,
}

impl MustMatch {
    pub fn new(
        address_prefix: KaspaAddrPrefix,
        escrow_public: EscrowPublic,
        hub_domain: u32,
        hub_token_id: H256,
        kas_domain: u32,
        kas_token_placeholder: H256, // a fake value, since Kaspa does not have a 'token' smart contract. Howevert his value must be consistent with hub config.
        hub_mailbox_id: String,
    ) -> Self {
        Self {
            address_prefix,
            escrow_public,
            partial_message: HyperlaneMessage {
                version: 0,
                nonce: 0,
                origin: hub_domain,
                sender: hub_token_id,
                destination: kas_domain,
                recipient: kas_token_placeholder,
                body: vec![],
            },
            hub_mailbox_id,
        }
    }

    fn is_match(&self, other: &HyperlaneMessage) -> bool {
        self.partial_message.origin == other.origin
            && self.partial_message.sender == other.sender
            && self.partial_message.destination == other.destination
            && self.partial_message.recipient == other.recipient
    }
}

/// Validate WithdrawFXG received from the relayer against Kaspa and Hub.
/// It verifies that:
/// (1)  No double spending allowed. All messages must be unique.
/// (2)  Each message is actually dispatched on the Hub. Achieved by `CosmosGrpcClient.delivered`.
///      Consequence: `delivered` ensures that the HL message hash in known on the Hub,
///      which verifies the correctness of all the HL message fields.
/// (3)  The messages are not yet marked as processed on the Hub.
/// (4)  The anchor UTXO provided by the relayer is actually still the anchor on the Hub.
/// (5)  The Kaspa TXs are a linked sequence. The first PSKT contains Hub anchor in inputs.
/// (6)  Check PSKT:
///      - The Kaspa TXs have corresponding message IDs in their payload (msg ID == msg hash).
///        Consequence: Each message actually hashes to the hash stored in the payload.
///      - Correct sighash type in inputs
///      - No lock time
///      - TX version
/// (7)  TX UTXO spends actually correspond to the message content.
/// (8)  No message use escrow as a recipient.
/// (9)  Each PSKT has exactly one anchor.
///
/// CONTRACT: the first anchor of `fxg.anchors` is the Hub anchor.
pub async fn validate_withdrawal_batch(
    fxg: &WithdrawFXG,
    cosmos_client: &CosmosGrpcClient,
    must_match: MustMatch,
) -> Result<(), ValidationError> {
    let messages: Vec<HyperlaneMessage> = fxg.messages.clone().into_iter().flatten().collect();
    let num_msgs = messages.len();

    debug!("Starting withdrawal validation for {} messages", num_msgs);

    // Step 1: check double spending, and that message is for relevant token
    let msg_ids: Vec<H256> = messages.iter().map(|m| m.id()).collect();
    if let Some(duplicate) = util::find_duplicate(&msg_ids) {
        let message_id = duplicate.encode_hex();
        return Err(ValidationError::DoubleSpending { message_id });
    }

    for msg in messages.iter() {
        if !must_match.is_match(&msg) {
            return Err(ValidationError::MessageWrongBridge {
                message_id: msg.id().encode_hex(),
            });
        }
    }

    // Steps 2: Check that all messages are *dispatched* from the Hub.
    for id in msg_ids {
        let res = cosmos_client
            .delivered(must_match.hub_mailbox_id.clone(), id.encode_hex())
            .await
            .map_err(|e| ValidationError::SystemError(Report::from(e)))?;

        // Delivered is a confusing name. `delivered` is just the name of the network query.
        let was_dispatched_on_hub = res.delivered;
        info!("was_dispatched_on_hub: {}", was_dispatched_on_hub);
        if !was_dispatched_on_hub {
            let message_id = id.encode_hex();
            return Err(ValidationError::MessageNotDispatched { message_id });
        }
    }

    debug!("All messages are dispatched");

    // Step 3: All messages should be unprocessed (pending) on the Hub
    let (hub_anchor, pending_messages) = filter_pending_withdrawals(messages, cosmos_client, None)
        .await
        .map_err(|e| eyre::eyre!("Get pending withdrawals: {}", e))?;

    if num_msgs != pending_messages.len() {
        return Err(ValidationError::MessagesNotUnprocessed);
    }

    validate_pskts(fxg, hub_anchor, must_match)
        .map_err(|e| eyre::eyre!("WithdrawFXG validation failed: {}", e))?;

    info!(
        "Withdrawal validation completed successfully for {} withdrawals",
        num_msgs
    );

    Ok(())
}

pub fn validate_pskts(
    fxg: &WithdrawFXG,
    hub_anchor: TransactionOutpoint,
    must_match: MustMatch,
) -> Result<(), ValidationError> {
    // Step 4: Validate that the Hub anchor in WithdrawFXG is still the actual Hub anchor

    // By convention, the first anchor of `fxg.anchors` is the Hub anchor
    let relayer_hub_outpoint = fxg.anchors.first().unwrap();
    if relayer_hub_outpoint.index != hub_anchor.index
        || relayer_hub_outpoint.transaction_id != hub_anchor.transaction_id
    {
        return Err(ValidationError::HubAnchorMismatch {
            hub_anchor,
            relayer_anchor: relayer_hub_outpoint.clone(),
        });
    }

    // Step 5: Validate the correct UTXO chaining.
    // Batch transactoins should follow this approach:
    //
    //   TX1   input: `hub_anchor`      TX1   output: `tx1_anchor`
    //   TX2   input: `tx1_anchor`      TX2   output: `tx2_anchor`
    //      ...                                    ...
    //   TX(N) input: `tx(N-1)_anchor`  TX(N) output: `tx(N)_anchor`

    // The first anchor is the hub anchor
    let mut prev_anchor = hub_anchor;

    // Iterate through all PSKTs in the bundle and verify that the chaining
    // is satisfied.
    for (idx, pskt) in fxg.bundle.iter().enumerate() {
        // Get messages that are covered by the corresponding PSKT
        let messages = fxg.messages.get(idx).unwrap();

        // Compute the next anchor UTXO
        let expected_next_outpoint = validate_pskt(
            PSKT::<Signer>::from(pskt.clone()),
            prev_anchor,
            messages,
            must_match.clone(),
        )
        .map_err(|e| eyre::eyre!("Single PSKT validation failed: {}", e))?;

        // Validate that the computed anchor is the same as the one
        // provided in WithdrawFXG

        // +1 bc the first anchor is the hub anchor
        let fxg_anchor = fxg.anchors.get(idx + 1).unwrap();

        // Compare field-by-field to avoid copying
        if expected_next_outpoint.index != fxg_anchor.index
            || expected_next_outpoint.transaction_id != fxg_anchor.transaction_id
        {
            return Err(ValidationError::AnchorMismatch { o: hub_anchor });
        }

        // The previous anchor for the *next* PSKT is the next anchor of
        // the *previous* PSKT.
        prev_anchor = expected_next_outpoint;
    }

    Ok(())
}

pub fn validate_pskt(
    pskt: PSKT<Signer>,
    prev_anchor: TransactionOutpoint,
    pending_messages: &Vec<HyperlaneMessage>,
    must_match: MustMatch,
) -> Result<TransactionOutpoint, ValidationError> {
    // Step 5 continuing: Check that PSKT contains the previous anchor as input
    let prev_outpoint_found = pskt.inputs.iter().any(|input| {
        input.previous_outpoint.transaction_id == prev_anchor.transaction_id
            && input.previous_outpoint.index == prev_anchor.index
    });
    if !prev_outpoint_found {
        return Err(ValidationError::AnchorNotFound { o: prev_anchor });
    }

    // Step 6: Check PSKT:

    // - Check if any input has incorrect sighash
    let incorrect_sig_hash = pskt
        .inputs
        .iter()
        .any(|input| !check_sighash_type(input.sighash_type));
    if incorrect_sig_hash {
        return Err(ValidationError::IncorrectSigHashType);
    }

    // - No lock time
    if let Some(_) = pskt.global.fallback_lock_time {
        return Err(ValidationError::UnexpectedLockTime);
    }

    // - Payload covers corresponding HL messages
    let payload = MessageIDs(pending_messages.iter().map(|m| MessageID(m.id())).collect())
        .to_bytes()
        .map_err(|e| eyre::eyre!("Failed to serialize MessageIDs: {}", e))?;

    let pskt_payload = pskt.global.payload.clone().unwrap_or(vec![]);

    if pskt_payload != payload {
        return Err(ValidationError::PayloadMismatch);
    }

    // - TX version
    if pskt.global.tx_version != kaspa_consensus_core::constants::TX_VERSION {
        return Err(ValidationError::TxVersionMismatch);
    }

    // Step 7: Check that UTXO outputs align with withdrawals
    // Find escrow input amount
    let escrow_input_amount = pskt.inputs.iter().fold(0, |acc, i| {
        // redeem_script is None for relayer input
        let rs = i.redeem_script.clone().unwrap_or_default();
        return if rs == must_match.escrow_public.redeem_script {
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

        let recipient = get_recipient_script_pubkey(tm.recipient(), must_match.address_prefix);

        // Step 8: Check that there are no withdrawals where escrow is set
        // as recepient. It would drastically complicate the confirmation flow.
        if recipient == must_match.escrow_public.p2sh {
            let message_id = m.id().encode_hex();
            return Err(ValidationError::EscrowWithdrawalNotAllowed { message_id });
        }

        let key = (tm.amount().as_u64(), recipient);
        *expected_outputs.entry(key).or_default() += 1;
    }

    // Ensure that all HL messages have outputs.
    // Also, calculate the total output amount of withdrawals + escrow change,
    // it should match the input escrow amount.
    let mut escrow_output_amount = 0;
    let mut next_anchor_idx: Option<u32> = None;
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

        // Check that output is an anchor
        if output.script_public_key == must_match.escrow_public.p2sh {
            // Step 9: Abort if there is more than one anchor candidate
            if next_anchor_idx.is_some() {
                return Err(ValidationError::MultipleAnchors);
            }

            escrow_output_amount += output.amount;
            next_anchor_idx = Some(idx as u32);
        }
    }

    // Step 9: There should be exactly one anchor
    let idx = next_anchor_idx.ok_or(ValidationError::NextAnchorNotFound)?;

    // expected_outputs contains the number of occurrences of (recipiend; amount) pairs.
    // If it is empty, then all the occurrences are covered by the Kaspa TX.
    if !expected_outputs.is_empty() {
        return Err(ValidationError::MissingOutputs);
    }

    // Verify that the input of escrow funds equals to the output of escrow funds:
    // Input == output == escrow change + sum(withdrawals)
    if escrow_input_amount != escrow_output_amount {
        return Err(ValidationError::EscrowAmountMismatch {
            input_amount: escrow_input_amount,
            output_amount: escrow_output_amount,
        });
    }

    Ok(TransactionOutpoint::new(pskt.calculate_id(), idx))
}

pub fn sign_withdrawal_fxg(fxg: &WithdrawFXG, keypair: &SecpKeypair) -> Result<Bundle> {
    let mut signed = Vec::new();
    for (pskt) in fxg.bundle.iter() {
        let pskt = PSKT::<Signer>::from(pskt.clone());

        let signed_pskt = corelib::pskt::sign_pskt(pskt, keypair, None)?;

        signed.push(signed_pskt);
    }
    info!("Validator: signed pskts");
    let bundle = Bundle::from(signed);
    Ok(bundle)
}
