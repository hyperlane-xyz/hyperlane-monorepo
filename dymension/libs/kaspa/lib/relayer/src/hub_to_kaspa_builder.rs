use anyhow::Result;
use hyperlane_core::{Decode, HyperlaneMessage, H256};
use hyperlane_cosmos_native::CosmosNativeProvider;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{WithdrawalId, WithdrawalStatus};
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::hashing::sighash_type::{
    SigHashType, SIG_HASH_ALL, SIG_HASH_ANY_ONE_CAN_PAY,
};
use kaspa_consensus_core::mass::transaction_output_estimated_serialized_size;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_consensus_core::tx::{ScriptPublicKey, UtxoEntry};
use kaspa_hashes;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_rpc_core::{RpcUtxoEntry, RpcUtxosByAddressesEntry};
use kaspa_txscript;
use kaspa_txscript::standard::pay_to_address_script;
use kaspa_wallet_core::account::Account;
use kaspa_wallet_core::utxo::{NetworkParams, UtxoIterator};
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::prelude::{Signer, PSKT};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;
// Assuming EscrowPublic is correctly defined in the `core` crate
// and `core` is a dependency in this crate's Cargo.toml (e.g., `core = { path = "../core" }`)
use core::escrow::EscrowPublic;

// ---------------------------------------------------------------------------
// Types & helpers - Updated to match specification
// ---------------------------------------------------------------------------

/// Details of a withdrawal extracted from HyperlaneMessage
#[derive(Debug, Clone)]
struct WithdrawalDetails {
    pub message_id: H256, // MessageID from HyperlaneMessage.id()
    pub recipient: kaspa_addresses::Address,
    pub amount_satoshi: u64,
}

pub async fn build_kaspa_withdrawal_pskts(
    messages: Vec<HyperlaneMessage>,
    cosmos_provider: &CosmosNativeProvider,
    hub_height: Option<u32>,
    kaspa_rpc: &impl RpcApi,
    escrow_public: &EscrowPublic,
    relayer_kaspa_account: &Arc<dyn Account>,
    network_id: NetworkId,
) -> Result<Option<Vec<PSKT<Signer>>>> {
    // Fetch current Hub x/kas state
    let (outpoint, pending_messages) =
        get_pending_withdrawals(messages, cosmos_provider, hub_height).await?;

    build_kaspa_withdrawal_pskts_pending(
        pending_messages,
        kaspa_rpc,
        escrow_public,
        relayer_kaspa_account,
        &outpoint,
        network_id,
    )
    .await
}

/// Updated signature matching the specification
async fn build_kaspa_withdrawal_pskts_pending(
    messages: Vec<HyperlaneMessage>,
    kaspa_rpc: &impl RpcApi,
    escrow_public: &EscrowPublic,
    relayer_kaspa_account: &Arc<dyn Account>,
    current_hub_state: &TransactionOutpoint,
    network_id: NetworkId,
) -> Result<Option<Vec<PSKT<Signer>>>> {
    let mut prepared_pskts: Vec<PSKT<Signer>> = Vec::new();

    let withdrawal_details: Vec<_> = messages
        .into_iter()
        .filter_map(|m| {
            match TokenMessage::read_from(&mut Cursor::new(&m.body)) {
                Ok(msg) => {
                    let kr = match kaspa_addresses::Address::try_from(m.recipient.to_string()) {
                        Ok(addr) => Some(addr),
                        Err(e) => None, // TODO: log error?
                    }?;

                    Some(WithdrawalDetails {
                        message_id: m.id(),
                        recipient: kr,
                        amount_satoshi: msg.amount().as_u64(),
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

    // Build PSKTs for each withdrawal
    for withdrawal in withdrawal_details {
        match build_single_withdrawal_pskt(
            &withdrawal,
            kaspa_rpc,
            escrow_public,
            relayer_kaspa_account,
            current_hub_state,
            network_id,
        )
        .await
        {
            Ok(pskt) => {
                prepared_pskts.push(pskt);

                println!(
                    "Successfully built PSKT for withdrawal {:?}",
                    withdrawal.message_id
                );
            }
            Err(e) => {
                eprintln!(
                    "Failed to build PSKT for withdrawal {:?}: {}",
                    withdrawal.message_id, e
                );
                // Continue processing other withdrawals
                continue;
            }
        }
    }

    // Return results
    if prepared_pskts.is_empty() {
        Ok(None)
    } else {
        println!("Built {} PSKTs for withdrawals", prepared_pskts.len());
        Ok(Some(prepared_pskts))
    }
}

const MIN_TO_SPEND: usize = 3; // consolidate ~3 inputs per tx

async fn get_utxo_to_spend(
    addr: kaspa_addresses::Address,
    total: u64,
    kaspa_rpc: &impl RpcApi,
    network_id: NetworkId,
) -> Result<Vec<RpcUtxosByAddressesEntry>> {
    let mut utxos = kaspa_rpc
        .get_utxos_by_addresses(vec![addr.clone()])
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get escrow UTXOs: {}", e))?;

    // Descending order – older UTXOs first
    utxos.sort_by_key(|u| std::cmp::Reverse(u.utxo_entry.block_daa_score));

    let mut selected = Vec::new();
    let mut total_in = 0u64;

    let block = kaspa_rpc
        .get_block_dag_info()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get block DAG info: {}", e))?;
    let current_daa_score = block.virtual_daa_score;

    for utxo in utxos {
        if !is_mature(&utxo.utxo_entry, current_daa_score, network_id) {
            continue;
        }

        // TODO: check if the utxo is not dust

        total_in += utxo.utxo_entry.amount;
        selected.push(utxo);

        if selected.len() >= MIN_TO_SPEND && total_in >= total {
            break;
        }
    }

    Ok(selected)
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

/// IN PROCESS
///
/// Helper function to build a single withdrawal PSKT
/// Adapts logic from withdraw.rs::build_withdrawal_tx
///
/// Process:
/// 1. Get all UTXOs from the multisig. Ensure that one of them is a current anchor
/// 1.1 Calculate the transaction fee - ?
/// 2. Get all USTOs from the relayer account. It pays the fees. Optionally, get only UTXOs to cover the fee
/// 3. Combine all the UTXOs in transaction inputs
/// 4. Create outputs: one - for user, relayer change, multisig change (next anchor)
async fn build_single_withdrawal_pskt(
    withdrawal_details: &WithdrawalDetails,
    kaspa_rpc: &impl RpcApi,
    escrow_public: &EscrowPublic,
    relayer_kaspa_account: &Arc<dyn Account>,
    current_anchor_outpoint: &TransactionOutpoint,
    network_id: NetworkId,
) -> Result<PSKT<Signer>> {
    let utxos = get_utxo_to_spend(
        escrow_public.addr.clone(),
        withdrawal_details.amount_satoshi,
        kaspa_rpc,
        network_id,
    )
    .await?;

    // TODO: include anchor UTXO

    let utxos = get_utxo_to_spend(
        relayer_kaspa_account.receive_address().unwrap(),
        withdrawal_details.amount_satoshi,
        kaspa_rpc,
        network_id,
    )
    .await?;

    // Find the specific anchor UTXO we want to spend
    let utxo_e_first = utxos
        .into_iter()
        .find(|utxo| {
            utxo.outpoint.transaction_id == current_anchor_outpoint.transaction_id
                && utxo.outpoint.index == current_anchor_outpoint.index
        })
        .ok_or_else(|| anyhow::anyhow!("Anchor UTXO not found"))?;

    let utxo_e_entry = UtxoEntry::from(utxo_e_first.utxo_entry);
    let utxo_e_out = kaspa_consensus_core::tx::TransactionOutpoint::from(utxo_e_first.outpoint);

    // 2. Get relayer UTXO for fees
    // We need to get as many UXTOs as we need to cover the fee
    let utxo_r = UtxoIterator::new(relayer_kaspa_account.utxo_context())
        .next()
        .ok_or_else(|| anyhow::anyhow!("Relayer has no UTXOs"))?;
    let utxo_r_entry: UtxoEntry = (utxo_r.utxo.as_ref()).into();
    let utxo_r_out = kaspa_consensus_core::tx::TransactionOutpoint::from(utxo_r.outpoint());

    // 3. Calculate amounts
    let withdrawal_amount = withdrawal_details.amount_satoshi;
    let fee = 1000; // TODO: Calculate proper fee

    // Verify escrow has enough funds
    if utxo_e_entry.amount < withdrawal_amount {
        return Err(anyhow::anyhow!(
            "Insufficient escrow funds: {} < {}",
            utxo_e_entry.amount,
            withdrawal_amount
        ));
    }

    // Verify relayer has enough for fees
    if utxo_r_entry.amount < fee {
        return Err(anyhow::anyhow!(
            "Insufficient relayer funds for fee: {} < {}",
            utxo_r_entry.amount,
            fee
        ));
    }

    // 4. Build escrow input (spending the anchor UTXO)
    let input_e = InputBuilder::default()
        .utxo_entry(utxo_e_entry.clone())
        .previous_outpoint(utxo_e_out)
        .redeem_script(escrow_public.redeem_script.clone())
        .sig_op_count(escrow_public.n() as u8) // Total possible signers
        .sighash_type(
            SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()).unwrap(),
        )
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build escrow input: {}", e))?;

    // 5. Build relayer input (for fees)
    let input_r = InputBuilder::default()
        .utxo_entry(utxo_r_entry.clone())
        .previous_outpoint(utxo_r_out)
        .sig_op_count(1)
        .sighash_type(
            SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()).unwrap(),
        )
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build relayer input: {}", e))?;

    // 6. Build output to user
    let output_e_to_user = OutputBuilder::default()
        .amount(withdrawal_amount)
        .script_public_key(ScriptPublicKey::from(pay_to_address_script(
            &withdrawal_details.recipient,
        )))
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build user output: {}", e))?;

    // 7. Build new escrow anchor output (escrow change)
    let escrow_change_amount = utxo_e_entry.amount - withdrawal_amount;
    let output_e_change = OutputBuilder::default()
        .amount(escrow_change_amount)
        .script_public_key(escrow_public.p2sh.clone())
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build escrow change output: {}", e))?;

    // 8. Build relayer change output
    let relayer_change_amount = utxo_r_entry.amount - fee;
    let output_r_change = OutputBuilder::default()
        .amount(relayer_change_amount)
        .script_public_key(ScriptPublicKey::from(pay_to_address_script(
            &relayer_kaspa_account
                .change_address()
                .map_err(|e| anyhow::anyhow!("Failed to get relayer change address: {}", e))?,
        )))
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build relayer change output: {}", e))?;

    // 9. Encode L' (withdrawal_id) as payload
    // For now, we'll add it as an OP_RETURN output to encode the message_id
    // This serves as the withdrawal identifier for the bridge
    let mut script_builder = kaspa_txscript::script_builder::ScriptBuilder::new();
    script_builder
        .add_op(kaspa_txscript::opcodes::codes::OpReturn)
        .map_err(|e| anyhow::anyhow!("Failed to add OP_RETURN: {}", e))?;
    script_builder
        .add_data(withdrawal_details.message_id.as_bytes())
        .map_err(|e| anyhow::anyhow!("Failed to add message_id data: {}", e))?;
    let payload_script = script_builder.drain();

    let output_payload = OutputBuilder::default()
        .amount(0) // OP_RETURN output with zero value
        .script_public_key(ScriptPublicKey::new(0, payload_script.into()))
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build payload output: {}", e))?;

    // 10. Build the PSKT
    let pskt = PSKT::<Creator>::default()
        .constructor()
        .input(input_e)
        .input(input_r)
        .output(output_e_to_user)
        .output(output_e_change)
        .output(output_r_change)
        .output(output_payload) // Include withdrawal_id payload
        .no_more_inputs()
        .no_more_outputs()
        .signer();

    Ok(pskt)
}

async fn get_pending_withdrawals(
    withdrawals: Vec<HyperlaneMessage>,
    cosmos_provider: &CosmosNativeProvider,
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
    let resp = match height {
        Some(h) => {
            cosmos_provider
                .grpc()
                .withdrawal_status(withdrawal_ids, Some(h))
                .await
        }
        None => {
            cosmos_provider
                .grpc()
                .withdrawal_status(withdrawal_ids, None)
                .await
        }
    }
    .map_err(|e| anyhow::anyhow!("Failed to query outpoint from x/kas module: {}", e))?;

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
            .map_err(|e| anyhow::anyhow!("Failed to convert transaction ID to array: {:?}", e))?,
    );

    // resp.status is a list of the same length as withdrawals. If status == WithdrawalStatus::Unprocessed,
    // then the respective element of withdrawals is Unprocessed.
    let pending_withdrawals: Vec<_> = resp
        .status
        .into_iter()
        .enumerate()
        .filter_map(|(idx, status)| match WithdrawalStatus::from_i32(status) {
            Some(WithdrawalStatus::Unprocessed) => Some(withdrawals[idx].clone()),
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
