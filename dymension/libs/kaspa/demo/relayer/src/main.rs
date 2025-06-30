#![allow(unused)] // TODO: remove

mod x;

use std::error::Error;
use core::api::client::get_local_testnet_client;
use core::deposit::*;
use core::escrow::*;
use core::util::*;
use core::wallet::*;
use core::ESCROW_ADDRESS;
use bytes::Bytes;
use relayer::withdraw::*;
use validator::withdraw::*;
use relayer::handle_new_deposit;
use validator::validate_deposit;
use x::args::Args;
use x::consts::*;
use std::sync::Arc;
use hyperlane_core::{Encode,Decode,H256,HyperlaneMessage,U256};
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

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::*; // Import the prelude for easy access to traits/structs

use secp256k1::{rand::thread_rng, Keypair};

use kaspa_rpc_core::api::rpc::RpcApi;
use workflow_core::abortable::Abortable;

pub async fn deposit(
    w: &Arc<Wallet>,
    secret: &Secret,
    address: Address,
    amt: u64,
) -> Result<TransactionId, KaspaError> {
    let a = w.account()?;

    let dst = PaymentDestination::from(PaymentOutput::new(address, amt));
    let fees = Fees::from(0i64);
    let payment_secret = None;
    let abortable = Abortable::new();

    let mut hl_message = HyperlaneMessage::default();
    let token_message = TokenMessage::new(H256::random(), U256::from(amt), vec![]);

    let encoded_bytes = token_message.to_vec();
    hl_message.body = encoded_bytes;

    let payload = hl_message.to_vec();
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


async fn demo() -> Result<(), Box<dyn Error>> {
    kaspa_core::log::init_logger(None, "");

    // parse demo args
    let args = Args::parse();

    // load wallet (using kaspa wallet)
    let s = Secret::from(args.wallet_secret.unwrap_or("".to_string()));
    let w = get_wallet(&s, NETWORK_ID, URL.to_string()).await?;


    println!("address {}",&w.account()?.receive_address()?);
    println!("balance {}",&w.account()?.get_list_string()?);

    // deposit to escrow address
    let amt = DEPOSIT_AMOUNT;
    let escrow_address = Address::try_from(ESCROW_ADDRESS)?;
    let tx_id = deposit(&w, &s, escrow_address, amt).await?;
    info!("Sent deposit transaction: {}", tx_id);

    // wait (it may take some time that the deposit is available to indexer-archive rpc service)
    workflow_core::task::sleep(std::time::Duration::from_secs(10)).await;

    // handle deposit (relayer operation)
    let deposit_fxg = handle_new_deposit(tx_id.to_string()).await?;

    // deposit encode to bytes 
    let deposit_bytes_recv: Bytes = (&deposit_fxg).into(); 

    // deposit from bytes
    let deposit_recv  = DepositFXG::try_from(deposit_bytes_recv)?;

    println!("Deposit pulled by relay tx_id:{} block_id:{} amount:{}", deposit_recv.tx_id, deposit_recv.block_id,deposit_recv.amount);

    // load kaspa validator rpc client 
    let client = get_local_testnet_client().await?;
    // validate deposit using kaspa rpc (validator operation)
    let validation_result = validate_deposit(&client,deposit_recv).await?;

    if validation_result {
        println!("Deposit validated");
    } else {
        println!("Failed to validate deposit");
    }

    client.stop().await?;
    w.stop().await?;
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(e) = demo().await {
        eprintln!("Error: {}", e);
    }
}
