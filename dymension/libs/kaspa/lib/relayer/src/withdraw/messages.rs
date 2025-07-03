use eyre::Result;

use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};
use kaspa_wallet_core::derivation::build_derivate_paths;

use corelib::consts::KEY_MESSAGE_IDS;
use corelib::escrow::EscrowPublic;
use corelib::payload::{MessageID, MessageIDs};
use hex::ToHex;
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
use kaspa_rpc_core::{RpcTransaction, RpcUtxoEntry, RpcUtxosByAddressesEntry};
use kaspa_txscript::standard::pay_to_address_script;
use kaspa_txscript::{opcodes::codes::OpData65, script_builder::ScriptBuilder};
use kaspa_wallet_core::account::Account;
use kaspa_wallet_core::prelude::DynRpcApi;
use kaspa_wallet_core::prelude::*;
use kaspa_wallet_core::utxo::NetworkParams;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::prelude::{Signer, PSKT};
use secp256k1::PublicKey;
use std::io::Cursor;
use std::sync::Arc;

use corelib::wallet::EasyKaspaWallet;
use corelib::withdraw::WithdrawFXG;
use kaspa_addresses::Prefix;
use kaspa_wallet_pskt::prelude::Bundle;
use tracing::info;
use super::hub_to_kaspa::build_withdrawal_pskt;

pub fn get_recipient_address(recipient: H256, prefix: Prefix) -> kaspa_addresses::Address {
    let addr = kaspa_addresses::Address::new(
        prefix,
        kaspa_addresses::Version::PubKey, // should always be PubKey
        recipient.as_bytes(),
    );
    addr
}

/// Processes given messages and returns WithdrawFXG and the very first outpoint
/// (the one preceding all the given transfers; it should be used during process indication).
pub async fn on_new_withdrawals(
    messages: Vec<HyperlaneMessage>,
    relayer: EasyKaspaWallet,
    cosmos: CosmosGrpcClient,
    escrow_public: EscrowPublic,
    hub_height: Option<u32>,
) -> Result<Option<(WithdrawFXG, TransactionOutpoint)>> {
    info!("Kaspa relayer, getting pending withdrawals");
    let (outpoint, pending_messages) = get_pending_withdrawals(messages, &cosmos, hub_height)
        .await
        .map_err(|e| eyre::eyre!("Get pending withdrawals: {}", e))?;
    info!("Kaspa relayer, got pending withdrawals");

    let withdrawal_details: Vec<_> = pending_messages
        .iter()
        .filter_map(|m| {
            match TokenMessage::read_from(&mut Cursor::new(&m.body)) {
                Ok(msg) => {
                    let kaspa_recipient =
                        get_recipient_address(m.recipient, relayer.network_info.address_prefix);

                    Some(WithdrawalDetails {
                        message_id: m.id(),
                        recipient: kaspa_recipient,
                        amount_sompi: msg.amount().as_u64(),
                    })
                }
                Err(e) => None, // TODO: log?
            }
        })
        .collect();

    if withdrawal_details.is_empty() {
        info!("Kaspa relayer, no pending withdrawals, all in batch are already processed and confirmed on hub");
        return Ok(None); // nothing to process
    }
    info!(
        "Kaspa relayer, got pending withdrawals, building PSKT, len: {}",
        withdrawal_details.len()
    );

    let pskt = build_withdrawal_pskt(
        withdrawal_details,
        &relayer.api(),
        &escrow_public,
        &relayer.account(),
        &outpoint,
        relayer.network_info.network_id,
    )
    .await
    .map_err(|e| eyre::eyre!("Build withdrawal PSKT: {}", e))?;

    // We have a bundle with one PSKT which covers all the HL messages.
    Ok(Some((
        WithdrawFXG::new(Bundle::from(pskt), vec![pending_messages]),
        outpoint,
    )))
}

/// Details of a withdrawal extracted from HyperlaneMessage
#[derive(Debug, Clone)]
pub(crate) struct WithdrawalDetails {
    pub message_id: H256,
    pub recipient: kaspa_addresses::Address,
    pub amount_sompi: u64,
}

pub(crate) async fn get_pending_withdrawals(
    withdrawals: Vec<HyperlaneMessage>,
    cosmos: &CosmosGrpcClient,
    height: Option<u32>,
) -> Result<(TransactionOutpoint, Vec<HyperlaneMessage>)> {
    // A list of withdrawal IDs to request their statuses from the Hub
    let withdrawal_ids: Vec<_> = withdrawals
        .iter()
        .map(|m| WithdrawalId {
            message_id: m.id().encode_hex(),
        })
        .collect();

    // Request withdrawal statuses from the Hub
    let resp = cosmos
        .withdrawal_status(withdrawal_ids, height)
        .await
        .map_err(|e| eyre::eyre!("Query outpoint from x/kas: {}", e))?;

    let outpoint_data = resp
        .outpoint
        .ok_or_else(|| eyre::eyre!("No outpoint data in response"))?;

    if outpoint_data.transaction_id.len() != 32 {
        return Err(eyre::eyre!(
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
            .map_err(|e| eyre::eyre!("Convert tx ID to Kaspa tx ID: {:}", e))?,
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
