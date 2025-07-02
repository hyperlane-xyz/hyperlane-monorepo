#![allow(unused)] // TODO: remove

use api_rs::apis::configuration;
use bytes::Bytes;
use corelib::api::deposits::Deposit;
use corelib::deposit::*;
use corelib::escrow::*;
use corelib::user::deposit::{deposit as do_deposit, deposit_impl};
use corelib::util::*;
use corelib::wallet::*;
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
use kaspa_wallet_core::utxo::NetworkParams;
use relayer::deposit::handle_new_deposit;
use relayer::withdraw::*;
use std::error::Error;
use std::sync::Arc;
use validator::deposit::validate_deposit;
use validator::withdraw::*;

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::*; // Import the prelude for easy access to traits/structs

use secp256k1::{rand::thread_rng, Keypair};

use api_rs::apis::kaspa_transactions_api::{
    get_transaction_transactions_transaction_id_get,
    GetTransactionTransactionsTransactionIdGetParams,
};
use kaspa_rpc_core::api::rpc::RpcApi;
use workflow_core::abortable::Abortable;

pub struct DemoArgs {
    pub amt: u64,
    pub escrow_address: Address,
    pub payload: Option<String>,
    pub only_deposit: bool,
    pub wallet_secret: String,
}

impl Default for DemoArgs {
    fn default() -> Self {
        Self {
            amt: 1000000000000000000,
            escrow_address: Address::try_from(ESCROW_ADDRESS).unwrap(),
            payload: None,
            only_deposit: false,
            wallet_secret: "".to_string(),
        }
    }
}

pub async fn demo(args: DemoArgs) -> Result<(), Box<dyn Error>> {
    kaspa_core::log::init_logger(None, "");

    let s = Secret::from(args.wallet_secret);
    let w = get_wallet(&s, NETWORK_ID, URL.to_string()).await?;

    println!("address {}", &w.account()?.receive_address()?);
    println!("balance {}", &w.account()?.get_list_string()?);

    // deposit to escrow address
    let amt = args.amt;
    let escrow_address = args.escrow_address;

    let tx_id = if let Some(payload) = args.payload {
        info!("Dymension, sending deposit with payload: {:?}", payload);
        // deposit_impl(&w, &s, escrow_address.clone(), amt, payload.as_bytes().to_vec()).await?
        let bz = hex::decode(payload).unwrap();
        deposit_impl(&w, &s, escrow_address.clone(), amt, bz).await?
    } else {
        do_deposit(&w, &s, escrow_address.clone(), amt).await?
    };

    info!("Sent deposit transaction: {}", tx_id);

    if args.only_deposit {
        return Ok(());
    }

    // wait (it may take some time that the deposit is available to indexer-archive rpc service)
    workflow_core::task::sleep(std::time::Duration::from_secs(10)).await;

    // rpc config
    let config = hardcode::e2e::get_tn10_config();

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
    let d = Deposit::try_from(res)?;

    // handle deposit (relayer operation)
    let deposit_fxg = handle_new_deposit(&escrow_address.to_string(), &d).await?;

    // deposit encode to bytes
    let deposit_bytes_recv: Bytes = (&deposit_fxg).into();

    // deposit from bytes
    let deposit_recv = DepositFXG::try_from(deposit_bytes_recv)?;

    println!(
        "Deposit pulled by relay tx_id:{} block_id:{} amount:{}",
        deposit_recv.tx_id, deposit_recv.block_id, deposit_recv.amount
    );

    // validate deposit using kaspa rpc (validator operation)
    let validation_result = validate_deposit(
        &w.rpc_api(),
        &deposit_recv,
        &escrow_address.to_string(),
        NetworkParams::from(w.network_id()?),
    )
    .await?;

    if validation_result {
        println!("Deposit validated");
    } else {
        println!("Failed to validate deposit");
    }

    w.stop().await?;
    Ok(())
}
