// We call the signers 'validators'

use crate::kas_bridge::payload::MessageIDs;
use crate::kas_bridge::util;
use crate::kas_bridge::util::get_recipient_script_pubkey;
use crate::kas_bridge::withdraw::{filter_pending_withdrawals, WithdrawFXG};
use crate::kas_validator::error::ValidationError;
use dym_kas_core::escrow::*;
use dym_kas_core::pskt::is_valid_sighash_type;
use dymension_kaspa_hl_constants::ALLOWED_HL_MESSAGE_VERSION;
use eyre::Result;
use hex::ToHex;
use hyperlane_core::{Decode, HyperlaneMessage, H256};
use hyperlane_cosmos::native::ModuleQueryClient;
use hyperlane_warp_route::TokenMessage;
use kaspa_addresses::Prefix as KaspaAddrPrefix;
use kaspa_bip32::secp256k1::Keypair as SecpKeypair;
use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionOutpoint};
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::pskt::{Inner, Input, Signer, PSKT};
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::io::Cursor;
use tracing::{debug, info};

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
                version: ALLOWED_HL_MESSAGE_VERSION,
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

    fn is_match(&self, other: &HyperlaneMessage) -> Result<()> {
        if self.partial_message.version != other.version {
            return Err(eyre::eyre!(
                "version is incorrect, expected: {}, got: {}",
                self.partial_message.version,
                other.version
            ));
        }
        if self.partial_message.origin != other.origin {
            return Err(eyre::eyre!(
                "origin is incorrect, expected: {}, got: {}",
                self.partial_message.origin,
                other.origin
            ));
        }
        if self.partial_message.sender != other.sender {
            return Err(eyre::eyre!(
                "sender is incorrect, expected: {}, got: {}",
                self.partial_message.sender,
                other.sender
            ));
        }
        if self.partial_message.destination != other.destination {
            return Err(eyre::eyre!(
                "destination is incorrect, expected: {}, got: {}",
                self.partial_message.destination,
                other.destination
            ));
        }
        if self.partial_message.recipient != other.recipient {
            return Err(eyre::eyre!(
                "recipient is incorrect, expected: {}, got: {}",
                self.partial_message.recipient,
                other.recipient
            ));
        }
        Ok(())
    }
}

pub async fn validate_sign_withdrawal_fxg<F, Fut>(
    fxg: WithdrawFXG,
    validation_enabled: bool,
    cosmos: &ModuleQueryClient,
    escrow_public: EscrowPublic,
    load_key: F,
    must_match: MustMatch,
) -> Result<Bundle>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<SecpKeypair>>,
{
    // !! Safe bundle can be considered part of the validation, strictly speaking
    let b = safe_bundle(&fxg.bundle)
        .map_err(|e| eyre::eyre!("Safe bundle validation failed: {e:?}"))?;

    // Call to validator.G()
    if validation_enabled {
        validate_withdrawal_batch(&b, &fxg.messages, cosmos, must_match)
            .await
            .map_err(|e| eyre::eyre!("Withdrawal validation failed: {:?}", e))?;

        info!("Validator: pskts are valid");
    }

    // Only sign escrow inputs
    let input_selector = move |i: &Input| match i.redeem_script.as_ref() {
        Some(rs) => rs == &escrow_public.redeem_script,
        None => false,
    };

    let bundle = sign_withdrawal_fxg(&b, load_key, Some(input_selector))
        .await
        .map_err(|e| eyre::eyre!("Failed to sign withdrawal: {e}"))?;

    Ok(bundle)
}

/// Validate WithdrawFXG received from the relayer against Kaspa and Hub.
/// It verifies that:
/// (0)  All messages should have Kaspa domain.
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
///      - We validate agains the safe bundle (see `safe_bundle`), so assume that
///        the relayer must use no lock time and a default TX version
/// (7)  TX UTXO spends actually correspond to the message content.
/// (8)  No message use escrow as a recipient.
/// (9)  Each PSKT has exactly one anchor.
///
/// CONTRACT: the first anchor of `fxg.anchors` is the Hub anchor.
pub async fn validate_withdrawal_batch(
    bundle: &Bundle,
    messages: &[Vec<HyperlaneMessage>],
    cosmos: &ModuleQueryClient,
    must_match: MustMatch,
) -> Result<(), ValidationError> {
    let hub_anchor = validate_messages(messages, cosmos, &must_match).await?;

    // At this point we know
    // - The set of messages is unique
    // - All the messages are dispatched on the hub
    // - None of the messages are already confirmed on the hub

    validate_pskts(
        bundle,
        messages,
        hub_anchor,
        must_match.escrow_public,
        must_match.address_prefix,
    )?;

    info!("Withdrawal validation completed successfully for withdrawals");

    Ok(())
}

async fn validate_messages(
    messages: &[Vec<HyperlaneMessage>],
    cosmos: &ModuleQueryClient,
    must_match: &MustMatch,
) -> Result<TransactionOutpoint, ValidationError> {
    let messages: Vec<HyperlaneMessage> = messages.iter().flatten().cloned().collect();
    let num_msgs = messages.len();
    debug!(
        "Starting withdrawal validation for messages, num_msgs: {}",
        num_msgs
    );
    let msg_ids: Vec<H256> = messages.iter().map(|m| m.id()).collect();
    if let Some(duplicate) = util::find_duplicate(&msg_ids) {
        let message_id = duplicate.encode_hex();
        return Err(ValidationError::DoubleSpending { message_id });
    }
    for msg in messages.iter() {
        if let Err(e) = must_match.is_match(msg) {
            return Err(ValidationError::FailedGeneralVerification {
                reason: e.to_string(),
            });
        }
    }
    for id in msg_ids {
        let res = cosmos
            .delivered(must_match.hub_mailbox_id.clone(), id.encode_hex())
            .await
            .map_err(|e| ValidationError::HubQueryError {
                reason: e.to_string(),
            })?;

        // Delivered is a confusing name. `delivered` is just the name of the network query.
        let was_dispatched_on_hub = res.delivered;
        if !was_dispatched_on_hub {
            let message_id = id.encode_hex();
            return Err(ValidationError::MessageNotDispatched { message_id });
        }
    }
    debug!("All withdrawal fxg messages are dispatched on hub");
    let (hub_anchor, pending_messages) = filter_pending_withdrawals(messages, cosmos)
        .await
        .map_err(|e| ValidationError::HubQueryError {
            reason: format!("Failed to get pending withdrawals: {}", e),
        })?;
    if num_msgs != pending_messages.len() {
        return Err(ValidationError::MessagesNotUnprocessed);
    }
    debug!("All withdrawal fxg messages are unprocessed on hub");
    Ok(hub_anchor)
}

pub fn validate_pskts(
    bundle: &Bundle,
    expected_messages: &[Vec<HyperlaneMessage>],
    hub_anchor: TransactionOutpoint,
    escrow_public: EscrowPublic,
    address_prefix: KaspaAddrPrefix,
) -> Result<(), ValidationError> {
    if bundle.0.len() != expected_messages.len() {
        return Err(ValidationError::MessageCacheLengthMismatch {
            expected: bundle.0.len(),
            actual: expected_messages.len(),
        });
    }

    // PSKTs must be linked by anchor, starting with the current hub anchor
    let mut anchor_to_spend = hub_anchor;
    for (idx, pskt) in bundle.iter().enumerate() {
        let messages = expected_messages.get(idx).unwrap();

        anchor_to_spend = validate_pskt(
            PSKT::<Signer>::from(pskt.clone()),
            anchor_to_spend,
            messages,
            &escrow_public,
            address_prefix,
        )?;
    }

    Ok(())
}

pub fn validate_pskt(
    pskt: PSKT<Signer>,
    must_spend: TransactionOutpoint,
    expected_messages: &Vec<HyperlaneMessage>,
    escrow_public: &EscrowPublic,
    address_prefix: KaspaAddrPrefix,
) -> Result<TransactionOutpoint, ValidationError> {
    validate_pskt_impl_details(&pskt)?;

    let tx_id = pskt.calculate_id();

    // If there are no messages and payload is empty, then the PSKT
    // is a sweeping tx which does not spend the anchor
    let tx_type = if expected_messages.is_empty() {
        info!("PSKT is a sweeping tx: {tx_id}");
        TxType::Sweeping
    } else {
        info!("PSKT is a withdrawal tx: {tx_id}");
        TxType::Withdrawal
    };

    let ix = validate_pskt_application_semantics(
        &pskt,
        must_spend,
        tx_type,
        expected_messages,
        escrow_public,
        address_prefix,
    )?;

    match tx_type {
        // In case of the sweeping tx, try to spend the anchor in the next PSKT
        TxType::Sweeping => Ok(must_spend),
        TxType::Withdrawal => Ok(TransactionOutpoint::new(pskt.calculate_id(), ix)),
    }
}

fn validate_pskt_impl_details(pskt: &PSKT<Signer>) -> Result<(), ValidationError> {
    if pskt
        .inputs
        .iter()
        .any(|input| !is_valid_sighash_type(input.sighash_type))
    {
        return Err(ValidationError::SigHashType);
    }

    Ok(())
}

#[derive(Clone, Copy)]
enum TxType {
    Sweeping,
    Withdrawal,
}

fn validate_pskt_application_semantics(
    pskt: &PSKT<Signer>,
    current_anchor: TransactionOutpoint,
    tx_type: TxType,
    expected_messages: &Vec<HyperlaneMessage>,
    escrow_public: &EscrowPublic,
    address_prefix: KaspaAddrPrefix,
) -> Result<u32, ValidationError> {
    let anchor_found = pskt
        .inputs
        .iter()
        .any(|input| input.previous_outpoint == current_anchor);

    // Check that the PSKT is a sweeping tx or a withdrawal tx.
    // If it is a sweeping tx, then the anchor must not be spent.
    // If it is a withdrawal tx, then the anchor must be spent.
    match (tx_type, anchor_found) {
        (TxType::Sweeping, true) => {
            return Err(ValidationError::AnchorSpent { o: current_anchor });
        }
        (TxType::Withdrawal, false) => {
            return Err(ValidationError::AnchorNotFound { o: current_anchor });
        }
        _ => {}
    }

    let payload_expect = MessageIDs::from(expected_messages).to_bytes();

    let payload_actual = pskt.global.payload.clone().unwrap_or_default();

    if payload_actual != payload_expect {
        return Err(ValidationError::PayloadMismatch);
    }

    // Check that UTXO outputs align with withdrawals
    // Find escrow input amount
    let escrow_inputs_sum = pskt.inputs.iter().fold(0, |acc, i| {
        // redeem_script is None for relayer input
        let rs = i.redeem_script.clone().unwrap_or_default();
        if rs == escrow_public.redeem_script {
            acc + i.utxo_entry.as_ref().unwrap().amount
        } else {
            acc
        }
    });

    // Construct a multiset of expected outputs from HL messages.
    // Key:   recipiend + amount
    // Value: number of entries
    //
    // Such structure accounts for cases where one address might send several transfers
    // with the same amount.
    let mut expected_outputs: HashMap<(u64, ScriptPublicKey), i32> = HashMap::new();

    for m in expected_messages {
        let tm = TokenMessage::read_from(&mut Cursor::new(&m.body)).map_err(|e| {
            ValidationError::PayloadParseError {
                reason: format!("Failed to parse TokenMessage from message body: {}", e),
            }
        })?;

        let recipient = get_recipient_script_pubkey(tm.recipient(), address_prefix);

        // There are no withdrawals where escrow is set
        // as recepient. It would drastically complicate the confirmation flow.
        if recipient == escrow_public.p2sh {
            let message_id = m.id().encode_hex();
            return Err(ValidationError::EscrowWithdrawalNotAllowed { message_id });
        }

        let key = (tm.amount().as_u64(), recipient);
        *expected_outputs.entry(key).or_default() += 1;
    }

    // Ensure that all HL messages have outputs.
    // Also, calculate the total output amount of withdrawals + escrow change,
    // it should match the input escrow amount.
    let mut escrow_outputs_sum = 0;
    let mut next_anchor_idx: Option<u32> = None;
    for (idx, output) in pskt.outputs.iter().enumerate() {
        let key = (output.amount, output.script_public_key.clone());

        let e = expected_outputs.entry(key).and_modify(|v| *v -= 1);
        if let Entry::Occupied(e) = e {
            escrow_outputs_sum += output.amount;
            if *e.get() == 0 {
                e.remove();
            }
            continue;
        }

        // Check that output is an anchor
        if output.script_public_key == escrow_public.p2sh {
            // Abort if there is more than one anchor candidate
            if next_anchor_idx.is_some() {
                return Err(ValidationError::MultipleAnchors);
            }

            escrow_outputs_sum += output.amount;
            next_anchor_idx = Some(idx as u32);
        }
    }

    // expected_outputs contains the number of occurrences of (recipiend; amount) pairs.
    // If it is empty, then all the occurrences are covered by the Kaspa TX.
    if !expected_outputs.is_empty() {
        return Err(ValidationError::MissingOutputs);
    }

    // Verify that the input of escrow funds equals to the output of escrow funds:
    // Input == output == escrow change + sum(withdrawals)
    if escrow_inputs_sum != escrow_outputs_sum {
        return Err(ValidationError::EscrowAmountMismatch {
            input_amount: escrow_inputs_sum,
            output_amount: escrow_outputs_sum,
        });
    }

    // In case of the sweeping tx, next_anchor_idx is not an anchor,
    // but a swept output. It shouldn't necessarily be spent on the next iteration.
    // But it still should be present in the PSKT.
    next_anchor_idx.ok_or(ValidationError::NextAnchorNotFound)
}

pub async fn sign_withdrawal_fxg<F, Fut>(
    bundle: &Bundle,
    load_key: F,
    input_filter: Option<impl Fn(&Input) -> bool>,
) -> Result<Bundle>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<SecpKeypair>>,
{
    let keypair = load_key()
        .await
        .map_err(|e| eyre::eyre!("load keypair for signing: {}", e))?;

    let mut signed = Vec::new();
    for pskt in bundle.iter() {
        let pskt = PSKT::<Signer>::from(pskt.clone());

        let signed_pskt =
            dym_kas_core::pskt::sign_pskt(pskt, &keypair, None, input_filter.as_ref())?;

        signed.push(signed_pskt);
    }
    info!("Validator: signed pskts");
    let bundle = Bundle::from(signed);
    Ok(bundle)
}

/// Load only the interesting fields of the PSKT which should be there
/// This means we don't have to validate all the other uninteresting fields one by one
/// The relayer should use no lock time and a default TX version
fn safe_pskt(unstrusted_inner: Inner) -> Result<PSKT<Signer>> {
    let mut inner = Inner::default();
    inner.global.input_count = unstrusted_inner.inputs.len();
    inner.global.output_count = unstrusted_inner.outputs.len();
    inner.global.payload = unstrusted_inner.global.payload;
    inner.global.version = unstrusted_inner.global.version;

    for input in unstrusted_inner.inputs.iter() {
        let mut b = InputBuilder::default();
        if let Some(utxo_entry) = &input.utxo_entry {
            b.utxo_entry(utxo_entry.clone());
        }
        b.previous_outpoint(input.previous_outpoint);
        if let Some(sig_op_count) = input.sig_op_count {
            b.sig_op_count(sig_op_count);
        }
        b.sighash_type(input.sighash_type);
        if let Some(redeem_script) = &input.redeem_script {
            b.redeem_script(redeem_script.clone());
        }
        inner.inputs.push(b.build()?);
    }

    for output in unstrusted_inner.outputs.iter() {
        let mut b = OutputBuilder::default();
        b.amount(output.amount);
        b.script_public_key(output.script_public_key.clone());
        inner.outputs.push(b.build()?);
    }

    Ok(PSKT::<Signer>::from(inner))
}

pub fn safe_bundle(unstrusted_bundle: &Bundle) -> Result<Bundle> {
    let mut items = Vec::new();
    for pskt in unstrusted_bundle.iter() {
        items.push(safe_pskt(pskt.clone())?);
    }
    Ok(Bundle::from(items))
}
