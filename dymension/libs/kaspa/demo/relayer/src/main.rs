#![allow(unused)] // TODO: remove

mod x;

use api_rs::apis::configuration;
use bytes::Bytes;
use core::api::deposits::Deposit;
use core::deposit::*;
use core::escrow::*;
use core::util::*;
use core::wallet::*;
use core::ESCROW_ADDRESS;
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
use relayer::handle_new_deposit;
use relayer::withdraw::*;
use std::error::Error;
use std::sync::Arc;
use validator::deposit::validate_deposit;
use validator::withdraw::*;
use x::args::Args;
use x::consts::*;

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::*; // Import the prelude for easy access to traits/structs

use secp256k1::{rand::thread_rng, Keypair};

use api_rs::apis::kaspa_transactions_api::{
    get_transaction_transactions_transaction_id_get,
    GetTransactionTransactionsTransactionIdGetParams,
};
use kaspa_rpc_core::api::rpc::RpcApi;
use workflow_core::abortable::Abortable;

pub async fn deposit(
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

    deposit_impl(w, secret, address.clone(), amt, payload.clone()).await
}

pub async fn deposit_impl(
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
            Some(payload),
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

fn get_tn10_config() -> configuration::Configuration {
    configuration::Configuration {
        base_path: "https://api-tn10.kaspa.org".to_string(),
        user_agent: Some("OpenAPI-Generator/a6a9569/rust".to_owned()),
        client: reqwest_middleware::ClientBuilder::new(reqwest::Client::new()).build(),
        basic_auth: None,
        oauth_access_token: None,
        bearer_access_token: None,
        api_key: None,
    }
}

async fn demo() -> Result<(), Box<dyn Error>> {
    kaspa_core::log::init_logger(None, "");

    // parse demo args
    let args = Args::parse();

    // load wallet (using kaspa wallet)
    let s = Secret::from(args.wallet_secret.unwrap_or("".to_string()));
    let w = get_wallet(&s, NETWORK_ID, URL.to_string()).await?;

    println!("address {}", &w.account()?.receive_address()?);
    println!("balance {}", &w.account()?.get_list_string()?);

    // deposit to escrow address
    let amt = args.amount.unwrap_or(DEPOSIT_AMOUNT);
    let escrow_address = if let Some(e) = args.escrow_address {
        Address::try_from(e)?
    } else {
        Address::try_from(ESCROW_ADDRESS)?
    };

    let tx_id = if let Some(payload) = args.payload {
        info!("Dymension, sending deposit with payload: {:?}", payload);
        // deposit_impl(&w, &s, escrow_address.clone(), amt, payload.as_bytes().to_vec()).await?
        let bz = hex::decode(payload).unwrap();
        deposit_impl(&w, &s, escrow_address.clone(), amt, bz).await?
    } else {
        deposit(&w, &s, escrow_address.clone(), amt).await?
    };

    info!("Sent deposit transaction: {}", tx_id);

    if args.only_deposit {
        return Ok(());
    }

    // wait (it may take some time that the deposit is available to indexer-archive rpc service)
    workflow_core::task::sleep(std::time::Duration::from_secs(10)).await;

    // rpc config
    let config = get_tn10_config();

    // api request
    let get_params = GetTransactionTransactionsTransactionIdGetParams {
        transaction_id: tx_id.to_string(),
        block_hash: None,
        inputs: None,
        outputs: None,
        resolve_previous_outpoints: None,
    };

    // get transaction info using Kaspa API
    let res = get_transaction_transactions_transaction_id_get(&config, get_params).await?;

    // build deposit from api response
    let deposit = Deposit::try_from(res)?;

    // handle deposit (relayer operation)
    let deposit_fxg = handle_new_deposit(&escrow_address.to_string(), &deposit).await?;

    // deposit encode to bytes
    let deposit_bytes_recv: Bytes = (&deposit_fxg).into();

    // deposit from bytes
    let deposit_recv = DepositFXG::try_from(deposit_bytes_recv)?;

    println!(
        "Deposit pulled by relay tx_id:{} block_id:{} amount:{}",
        deposit_recv.tx_id, deposit_recv.block_id, deposit_recv.amount
    );

    // validate deposit using kaspa rpc (validator operation)
    let validation_result =
        validate_deposit(&w.rpc_api(), &deposit_recv, &escrow_address.to_string()).await?;

    if validation_result {
        println!("Deposit validated");
    } else {
        println!("Failed to validate deposit");
    }

    w.stop().await?;
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(e) = demo().await {
        eprintln!("Error: {}", e);
    }
}
