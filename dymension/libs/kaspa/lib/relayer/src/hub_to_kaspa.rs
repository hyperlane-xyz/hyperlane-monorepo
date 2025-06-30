use anyhow::Result;
use corelib::escrow::EscrowPublic;
use corelib::consts::KEY_MESSAGE_IDS;
use corelib::payload::{MessageID, MessageIDs};
use hyperlane_core::{Decode, HyperlaneMessage, H256};
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{WithdrawalId, WithdrawalStatus};
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::config::params::Params;
use kaspa_consensus_core::constants::TX_VERSION;
use kaspa_consensus_core::hashing::sighash_type::{
    SigHashType, SIG_HASH_ALL, SIG_HASH_ANY_ONE_CAN_PAY,
};
use kaspa_consensus_core::mass;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{PopulatedTransaction, ScriptPublicKey, UtxoEntry};
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutpoint, TransactionOutput,
};
use kaspa_hashes;
use kaspa_rpc_core::{RpcUtxoEntry, RpcUtxosByAddressesEntry};
use kaspa_txscript;
use kaspa_txscript::standard::pay_to_address_script;
use kaspa_wallet_core::account::Account;
use kaspa_wallet_core::prelude::DynRpcApi;
use kaspa_wallet_core::utxo::NetworkParams;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::prelude::{Signer, PSKT};
use std::collections::BTreeMap;
use std::io::Cursor;
use std::sync::Arc;
use corelib::wallet::NetworkInfo;

/// Details of a withdrawal extracted from HyperlaneMessage
#[derive(Debug, Clone)]
struct WithdrawalDetails {
    #[allow(dead_code)]
    pub message_id: H256, // MessageID from HyperlaneMessage.id() TODO: where to use it?
    pub recipient: kaspa_addresses::Address,
    pub amount_sompi: u64,
}

/// Builds a single withdrawal PSKT.
///
/// Example:
///
/// The user sends 10 KAS. Multisig addr has 100 KAS. Due to the Hyperlane approach, the user
/// needs to get the whole amount they transferred, so they must get 10 KAS. However, there is
/// the transaction fee, which must be covered by the relayer. Let's say it's 1 KAS.
///
/// For that, we fetch ALL UTXOs from the multisig address and them as inputs. This will also
/// work as automatic sweeping. The change is returned as an output which is also used as
/// a new anchor.
///
/// The relayer fee is tricky. Relayer should provide some UTXOs to cover the fee. However,
/// each input increases the transaction fee, so we can't compute the concrete fee beforehand.
///
/// We have two options:
///
/// --- 1 ---
/// 1. Calculate the tx fee without relayer's UTXOs.
/// 2. Get the UTXOs that cover the fee.
/// 3. Add them as inputs.
/// 4. Calculate the fee again.
/// 5. Add additional UTXOs if needed and repeat 2-4.
///
/// Pros: As low fee as possible.
/// Cons: The relayer account is fragmented (sweeping is needed); complex flow.
///
/// --- 2 --- (Implemented)
/// Get ALL UTXOs and also use them as inputs. The change is returned as output.
///
/// Pros: Simple to handle.
/// Cons: Potentially bigger fee because of the increased number of inputs. However, it's in
/// relayer's interest to pay min fees and thus keep its account with as few UTXOs as possible.
pub async fn build_withdrawal_pskts(
    messages: Vec<HyperlaneMessage>,
    hub_height: Option<u32>,
    cosmos: &CosmosGrpcClient,
    kaspa_rpc: &Arc<DynRpcApi>,
    escrow: &EscrowPublic,
    relayer: &Arc<dyn Account>,
    network_info: NetworkInfo,
) -> Result<Option<PSKT<Signer>>> {
    let (outpoint, pending_messages) =
        get_pending_withdrawals(messages, cosmos, hub_height).await?;

    let withdrawal_details: Vec<_> = pending_messages
        .into_iter()
        .filter_map(|m| {
            match TokenMessage::read_from(&mut Cursor::new(&m.body)) {
                Ok(msg) => {
                    let kaspa_recipient = kaspa_addresses::Address::new(
                        network_info.address_prefix,
                        kaspa_addresses::Version::PubKey, // should always be PubKey
                        m.recipient.as_bytes(),
                    );

                    Some(WithdrawalDetails {
                        message_id: m.id(),
                        recipient: kaspa_recipient,
                        amount_sompi: msg.amount().as_u64(),
                    })
                }
                Err(e) => {
                    eprintln!(
                        "Failed to parse TokenMessage for message_id {:?}: {}",
                        m.id(),
                        e
                    );
                    None
                }
            }
        })
        .collect();

    if withdrawal_details.is_empty() {
        return Ok(None);
    }

    internal_build_withdrawal_pskt(
        withdrawal_details,
        kaspa_rpc,
        escrow,
        relayer,
        &outpoint,
        network_info.network_id,
    )
        .await
        .map(Some)
}

async fn internal_build_withdrawal_pskt(
    withdrawal_details: Vec<WithdrawalDetails>,
    kaspa_rpc: &Arc<DynRpcApi>,
    escrow: &EscrowPublic,
    relayer: &Arc<dyn Account>,
    current_anchor: &TransactionOutpoint,
    network_id: NetworkId,
) -> Result<PSKT<Signer>> {
    //////////////////
    //     UTXO     //
    //////////////////

    // Get all available UTXOs from multisig
    let escrow_utxos = get_utxo_to_spend(escrow.addr.clone(), kaspa_rpc, network_id).await?;

    // Check if the current anchor is withing the list of multisig UTXOs
    if !escrow_utxos.iter().any(|u| {
        u.outpoint.transaction_id == current_anchor.transaction_id
            && u.outpoint.index == current_anchor.index
    }) {
        return Err(anyhow::anyhow!(
            "No UTXOs found for current anchor: {:?}",
            current_anchor
        ));
    }

    let relayer_utxos = get_utxo_to_spend(
        // TODO: receive_address or change_address??
        relayer.receive_address()?.clone(),
        kaspa_rpc,
        network_id,
    )
        .await?;

    //////////////////
    //   Balances   //
    //////////////////

    // TODO: Confirm if we can have an overflow here
    // 1 KAS = 10^8 (dust denom).
    // 10^19 < 2^26 < 10^20
    // This means the multisig must hold at most 10^19 (dust denom) => 10^11 KAS
    // Given that 1 KAS = $10^-2, the max balance is $1B, but this might change
    // in case of hyperinflation

    let escrow_balance = escrow_utxos
        .iter()
        .fold(0, |acc, u| acc + u.utxo_entry.amount);

    let withdrawal_balance = withdrawal_details
        .iter()
        .fold(0, |acc, w| acc + w.amount_sompi);

    if escrow_balance < withdrawal_balance {
        return Err(anyhow::anyhow!(
            "Insufficient funds in escrow: {} < {}",
            escrow_balance,
            withdrawal_balance
        ));
    }

    let relayer_balance = relayer_utxos
        .iter()
        .fold(0, |acc, u| acc + u.utxo_entry.amount);

    ////////////////////
    // Input & Output //
    ////////////////////

    // Iterate through escrow and relayer UTXO – they would be transaction inputs.
    // Create a vector of "populated" inputs: TransactionInput and UtxoEntry.

    let populated_inputs_escrow: Vec<(TransactionInput, UtxoEntry)> = escrow_utxos
        .into_iter()
        .map(|utxo| {
            (
                TransactionInput::new(
                    kaspa_consensus_core::tx::TransactionOutpoint::from(utxo.outpoint),
                    escrow.redeem_script.clone(),
                    0, // sequence does not matter
                    escrow.n() as u8,
                ),
                UtxoEntry::from(utxo.utxo_entry),
            )
        })
        .collect();

    let populated_inputs_relayer: Vec<(TransactionInput, UtxoEntry)> = relayer_utxos
        .into_iter()
        .map(|utxo| {
            (
                TransactionInput::new(
                    kaspa_consensus_core::tx::TransactionOutpoint::from(utxo.outpoint),
                    vec![],
                    0,                                     // sequence does not matter
                    corelib::consts::RELAYER_SIG_OP_COUNT, // only one signature from relayer is needed
                ),
                UtxoEntry::from(utxo.utxo_entry),
            )
        })
        .collect();

    let msg_ids: Vec<_> = withdrawal_details.iter().map(|w| w.message_id).collect();

    let outputs: Vec<TransactionOutput> = withdrawal_details
        .into_iter()
        .map(|w| {
            TransactionOutput::new(
                w.amount_sompi,
                ScriptPublicKey::from(pay_to_address_script(&w.recipient)),
            )
        })
        .collect();

    //////////////////
    //     Fee      //
    //////////////////

    let combined_inputs: Vec<(TransactionInput, UtxoEntry)> = populated_inputs_escrow
        .iter()
        .cloned()
        .chain(populated_inputs_relayer.iter().cloned())
        .collect();

    // Multiply the fee by 1.1 to give some space for adding change UTXOs.
    // TODO: use feerate.
    let tx_fee = estimate_fee(combined_inputs, outputs.clone(), Vec::new(), network_id) * 11 / 10;

    if relayer_balance < tx_fee {
        return Err(anyhow::anyhow!(
            "Insufficient relayer funds to cover tx fee: {} < {}",
            relayer_balance,
            tx_fee
        ));
    }

    //////////////////
    //     PSKT     //
    //////////////////

    let msg_ids_raw = MessageIDs::new(msg_ids.into_iter().map(MessageID).collect::<Vec<MessageID>>())
    .into_value()
    .map_err(|e| anyhow::anyhow!("Serialize message IDs: {}", e))?;

    // Save msg_ids_raw in the proprietaries for later retrieval by validators
    let global = GlobalBuilder::default()
        .proprietaries(BTreeMap::from([(
            KEY_MESSAGE_IDS.to_string(),
            msg_ids_raw,
        )]))
        .build()
        .map_err(|e| anyhow::anyhow!("Build message IDs payload: {}", e))?;

    // Create default Inner and inject global that contains message IDs
    let mut inner: Inner = Default::default();
    inner.global = global;

    let mut pskt = PSKT::<Creator>::from(inner).constructor();

    // Add escrow inputs
    for (input, entry) in populated_inputs_escrow {
        let pskt_input = InputBuilder::default()
            .utxo_entry(entry)
            .previous_outpoint(input.previous_outpoint)
            .sig_op_count(input.sig_op_count)
            .redeem_script(input.signature_script)
            .sighash_type(
                SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8())
                    .unwrap(),
            )
            .build()
            .map_err(|e| anyhow::anyhow!("Build pskt input for escrow: {}", e))?;

        pskt = pskt.input(pskt_input);
    }

    // Add relayer inputs
    for (input, entry) in populated_inputs_relayer {
        let pskt_input = InputBuilder::default()
            .utxo_entry(entry)
            .previous_outpoint(input.previous_outpoint)
            .sig_op_count(1) // TODO: needed if using p2pk?
            .sighash_type(
                SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8())
                    .unwrap(),
            )
            .build()
            .map_err(|e| anyhow::anyhow!("Build pskt input for relayer: {}", e))?;

        pskt = pskt.input(pskt_input);
    }

    // Add outputs
    for output in outputs {
        let pskt_output = OutputBuilder::default()
            .amount(output.value)
            .script_public_key(output.script_public_key)
            .build()
            .map_err(|e| anyhow::anyhow!("Build pskt output for withdrawal: {}", e))?;

        pskt = pskt.output(pskt_output);
    }

    // escrow_balance - withdrawal_balance > 0 as checked above
    let escrow_change = OutputBuilder::default()
        .amount(escrow_balance - withdrawal_balance)
        .script_public_key(escrow.p2sh.clone())
        .build()
        .map_err(|e| anyhow::anyhow!("Build pskt output for escrow change: {}", e))?;

    // relayer_balance - tx_fee as checked above
    let relayer_change = OutputBuilder::default()
        .amount(relayer_balance - tx_fee)
        .script_public_key(ScriptPublicKey::from(pay_to_address_script(
            &relayer.change_address()?,
        )))
        .build()
        .map_err(|e| anyhow::anyhow!("Build pskt output for relayer change: {}", e))?;

    // escrow_change should always be present even if it's dust
    pskt = pskt.output(escrow_change);

    // if !is_transaction_output_dust(&relayer_change) {
    pskt = pskt.output(relayer_change);
    // }

    Ok(pskt.no_more_inputs().no_more_outputs().signer())
}

async fn get_utxo_to_spend(
    addr: kaspa_addresses::Address,
    kaspa_rpc: &Arc<DynRpcApi>,
    network_id: NetworkId,
) -> Result<Vec<RpcUtxosByAddressesEntry>> {
    let mut utxos = kaspa_rpc
        .get_utxos_by_addresses(vec![addr.clone()])
        .await
        .map_err(|e| anyhow::anyhow!("Get escrow UTXOs: {}", e))?;

    let block = kaspa_rpc
        .get_block_dag_info()
        .await
        .map_err(|e| anyhow::anyhow!("Get block DAG info: {}", e))?;
    let current_daa_score = block.virtual_daa_score;

    // Descending order – older UTXOs first
    utxos.sort_by_key(|u| std::cmp::Reverse(u.utxo_entry.block_daa_score));
    utxos.retain(|u| is_mature(&u.utxo_entry, current_daa_score, network_id));

    Ok(utxos)
}

fn is_mature(utxo: &RpcUtxoEntry, current_daa_score: u64, network_id: NetworkId) -> bool {
    match maturity_progress(utxo, current_daa_score, network_id) {
        Some(_) => false,
        None => true,
    }
}

// Copy https://github.com/kaspanet/rusty-kaspa/blob/v1.0.0/wallet/core/src/storage/transaction/record.rs
fn maturity_progress(
    utxo: &RpcUtxoEntry,
    current_daa_score: u64,
    network_id: NetworkId,
) -> Option<f64> {
    let params = NetworkParams::from(network_id);
    let maturity = if utxo.is_coinbase {
        params.coinbase_transaction_maturity_period_daa()
    } else {
        params.user_transaction_maturity_period_daa()
    };

    if current_daa_score < utxo.block_daa_score + maturity {
        Some((current_daa_score - utxo.block_daa_score) as f64 / maturity as f64)
    } else {
        None
    }
}

fn estimate_fee(
    populated_inputs: Vec<(TransactionInput, UtxoEntry)>,
    outputs: Vec<TransactionOutput>,
    payload: Vec<u8>,
    network_id: NetworkId,
) -> u64 {
    let inputs = populated_inputs
        .iter()
        .map(|(input, _)| input.clone().into())
        .collect();
    let utxo_entries = populated_inputs
        .iter()
        .map(|(_, entry)| entry.clone().into())
        .collect();

    let tx = Transaction::new(
        TX_VERSION,
        inputs,
        outputs.clone(),
        0, // no tx lock time
        SUBNETWORK_ID_NATIVE,
        0,
        payload, // empty payload
    );
    let ptx = PopulatedTransaction::new(&tx, utxo_entries);

    let p = Params::from(network_id);
    let m = mass::MassCalculator::new_with_consensus_params(&p);

    let ncm = m.calc_non_contextual_masses(&tx);
    // Assumptions which must be verified before this call:
    //     1. All output values are non-zero
    //     2. At least one input (unless coinbase)
    //
    // Otherwise this function should never fail. As in our case.
    let cm = m.calc_contextual_masses(&ptx).unwrap();

    let mass = cm.max(ncm);

    // TODO: Apply current feerate. It can be fetched from https://api.kaspa.org/info/fee-estimate.
    mass
}

async fn get_pending_withdrawals(
    withdrawals: Vec<HyperlaneMessage>,
    cosmos: &CosmosGrpcClient,
    height: Option<u32>,
) -> Result<(TransactionOutpoint, Vec<HyperlaneMessage>)> {
    // A list of withdrawal IDs to request their statuses from the Hub
    let withdrawal_ids: Vec<_> = withdrawals
        .iter()
        .map(|m| WithdrawalId {
            message_id: m.id().to_string(),
        })
        .collect();

    // Request withdrawal statuses from the Hub
    let resp = cosmos
        .withdrawal_status(withdrawal_ids, height)
        .await
        .map_err(|e| anyhow::anyhow!("Query outpoint from x/kas: {}", e))?;

    let outpoint_data = resp
        .outpoint
        .ok_or_else(|| anyhow::anyhow!("No outpoint data in response"))?;

    if outpoint_data.transaction_id.len() != 32 {
        return Err(anyhow::anyhow!(
            "Invalid transaction ID length: expected 32 bytes, got {}",
            outpoint_data.transaction_id.len()
        ));
    }

    // Convert the transaction ID to kaspa transaction ID
    let kaspa_tx_id = kaspa_hashes::Hash::from_bytes(
        outpoint_data
            .transaction_id
            .as_slice()
            .try_into()
            .map_err(|e| anyhow::anyhow!("Convert tx ID to Kaspa tx ID: {:}", e))?,
    );

    // resp.status is a list of the same length as withdrawals. If status == WithdrawalStatus::Unprocessed,
    // then the respective element of withdrawals is Unprocessed.
    let pending_withdrawals: Vec<_> = resp
        .status
        .into_iter()
        .enumerate()
        .filter_map(|(idx, status)| match status.try_into() {
            Ok(WithdrawalStatus::Unprocessed) => Some(withdrawals[idx].clone()),
            _ => None, // Ignore other statuses
        })
        .collect();

    Ok((
        TransactionOutpoint {
            transaction_id: kaspa_tx_id,
            index: outpoint_data.index,
        },
        pending_withdrawals,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kaspa_address_conversion() {
        // Input is an address which is going to receive funds
        let input = "kaspatest:qzgq29y4cwrchsre26tvyezk2lsyhm3k23ch9tv4nrpvyq7lyhs3sux404nt8";
        // First, we need to get its bytes representation
        let input_kaspa = kaspa_addresses::Address::constructor(input);
        // Input hex is what will be used in MsgRemoteTransfer
        let input_hex = hex::encode(input_kaspa.payload);
        // In x/warp, the input hex is converted to a byte vector
        let output_bytes = hex::decode(input_hex).unwrap();
        // Put these bytes to a 32-byte array
        let output_bytes_32: [u8; 32] = output_bytes.try_into().unwrap();
        // In the agent, the 32-byte array is converted to H256
        let output_h256 = H256::from_slice(&output_bytes_32);
        // Construct Kaspa address
        let output_kaspa = kaspa_addresses::Address::new(
            kaspa_addresses::Prefix::Testnet,
            kaspa_addresses::Version::PubKey,
            output_h256.as_bytes(),
        );

        let output = output_kaspa.address_to_string();

        assert_eq!(true, kaspa_addresses::Address::validate(output.as_str()));
        assert_eq!(input, output.as_str());
    }
}
