#![allow(unused)] // TODO: remove

use crate::api::deposits::Deposit;
use crate::balance::*;
use crate::deposit::*;
use crate::escrow::*;
use crate::wallet::*;
use api_rs::apis::configuration;
use bytes::Bytes;
use hardcode::e2e::*;
use hex;
use hyperlane_core::{Decode, Encode, HyperlaneMessage, H256, U256};
use hyperlane_warp_route::TokenMessage;
use kaspa_addresses::Address;
use kaspa_consensus_core::{
    constants::TX_VERSION,
    sign::sign,
    subnets::SUBNETWORK_ID_NATIVE,
    tx::{
        MutableTransaction, ScriptPublicKey, Transaction, TransactionInput, TransactionOutpoint,
        TransactionOutput, UtxoEntry,
    },
};
use kaspa_core::info;
use kaspa_grpc_client::GrpcClient;
use kaspa_wallet_core::api::{AccountsSendRequest, WalletApi};
use kaspa_wallet_core::error::Error as KaspaError;
use kaspa_wallet_core::tx::Fees;
use std::error::Error;
use std::sync::Arc;

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::*; // Import the prelude for easy access to traits/structs

use secp256k1::{rand::thread_rng, Keypair};

use api_rs::apis::kaspa_transactions_api::{
    get_transaction_transactions_transaction_id_get,
    GetTransactionTransactionsTransactionIdGetParams,
};
use kaspa_rpc_core::api::rpc::RpcApi;
use workflow_core::abortable::Abortable;

// TODO: move to demo/call site, because not reusable
pub async fn deposit_with_default_hl_Message(
    w: &Arc<Wallet>,
    secret: &Secret,
    address: Address,
    amt: u64,
) -> Result<TransactionId, KaspaError> {
    let mut hl_message = HyperlaneMessage::default();
    let token_message = TokenMessage::new(H256::random(), U256::from(amt), vec![]);

    let encoded_bytes = token_message.to_vec();

    hl_message.body = encoded_bytes;

    let payload = hl_message.to_vec();

    deposit_with_payload(w, secret, address.clone(), amt, payload.clone()).await
}

pub async fn deposit_with_payload(
    w: &Arc<Wallet>,
    secret: &Secret,
    address: Address,
    amt: u64,
    payload: Vec<u8>,
) -> Result<TransactionId, KaspaError> {
    let a = w.account()?;

    let dst = PaymentDestination::from(PaymentOutput::new(address, amt));
    let fees = Fees::from(0i64);
    let payment_secret = None;
    let abortable = Abortable::new();

    // use account.send, because wallet.accounts_send(AccountsSendRequest{..}) is buggy
    let (summary, _) = a
        .send(
            dst,
            fees,
            match payload.len() {
                0 => None,
                _ => Some(payload),
            },
            secret.clone(),
            payment_secret,
            &abortable,
            None,
        )
        .await?;

    summary.final_transaction_id().ok_or_else(|| {
        KaspaError::Custom("Deposit transaction failed to generate a transaction ID".to_string())
    })
}
