#![allow(unused)] // TODO: remove

use api_rs::apis::configuration;
use bytes::Bytes;
use corelib::api::client::Deposit;
use corelib::balance::*;
use corelib::deposit::*;
use corelib::escrow::*;
use corelib::message::{add_kaspa_metadata_hl_messsage, ParsedHL};
use corelib::user::deposit::deposit_with_payload;
use corelib::wallet::*;
use dymension_kaspa::KaspaHttpClient;
use eyre;
use hardcode::e2e::*;
use hex;
use hyperlane_core::ChainCommunicationError;
use hyperlane_core::ChainResult;
use hyperlane_core::{Decode, Encode, HyperlaneMessage, H256, U256};
use hyperlane_metric::prometheus_metric::ClientConnectionType;
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
use kaspa_core::time::unix_now;
use kaspa_grpc_client::GrpcClient;
use kaspa_wallet_core::api::{AccountsSendRequest, WalletApi};
use kaspa_wallet_core::error::Error as KaspaError;
use kaspa_wallet_core::tx::Fees;
use kaspa_wallet_core::utxo::NetworkParams;
use relayer::deposit::{build_deposit_fxg, check_deposit_finality};
use relayer::withdraw::*;
use std::collections::HashSet;
use std::error::Error;
use std::os::unix;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use url::Url;
use validator::deposit::{
    validate_new_deposit, validate_new_deposit_inner, MustMatch as DepositMustMatch,
};
use validator::withdraw::*;

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::*; // Import the prelude for easy access to traits/structs

use secp256k1::{rand::thread_rng, Keypair};

use api_rs::apis::kaspa_transactions_api::{
    get_transaction_transactions_transaction_id_get,
    GetTransactionTransactionsTransactionIdGetParams,
};
use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};
use kaspa_rpc_core::api::rpc::RpcApi;
use tokio::{sync::Mutex, task::JoinHandle, time};
use tracing::error;
use workflow_core::abortable::Abortable;

pub struct DepositCache {
    seen: Mutex<HashSet<Deposit>>,
}

impl DepositCache {
    pub fn new() -> Self {
        Self {
            seen: Mutex::new(HashSet::new()),
        }
    }

    async fn has_seen(&self, deposit: &Deposit) -> bool {
        let seen_guard = self.seen.lock().await;
        seen_guard.contains(deposit)
    }

    async fn mark_as_seen(&self, deposit: Deposit) {
        let mut seen_guard = self.seen.lock().await;
        seen_guard.insert(deposit);
    }
}

pub struct DemoArgs {
    pub amt: u64,
    pub escrow_address: Address,
    pub payload: Option<String>,
    pub only_deposit: bool,
    pub wallet_secret: String,
    pub wprc_url: String,
}

impl Default for DemoArgs {
    fn default() -> Self {
        Self {
            amt: 1000000000000000000,
            escrow_address: Address::try_from(ESCROW_ADDRESS).unwrap(),
            payload: None,
            only_deposit: false,
            wallet_secret: "".to_string(),
            wprc_url: "".to_string(),
        }
    }
}

pub async fn get_deposits(
    lower_bound_unix_time: i64,
    client: &KaspaHttpClient,
    address: &str,
) -> ChainResult<Vec<Deposit>> {
    let res = client
        .client
        .get_deposits_by_address(Some(lower_bound_unix_time), address)
        .await;
    res.map_err(|e| ChainCommunicationError::from_other_str(&e.to_string()))
        .map(|deposits| deposits.into_iter().collect())
}

async fn deposit_loop(
    cache: &DepositCache,
    client: &KaspaHttpClient,
    address: String,
    tx: TransactionId,
) -> ChainResult<Deposit> {
    info!("Dymension, starting deposit detection loop");
    let mut start_relay_time = unix_now() as i64;

    loop {
        time::sleep(Duration::from_secs(10)).await;
        let deposits_res: std::result::Result<Vec<Deposit>, ChainCommunicationError> =
            get_deposits(start_relay_time, client, &address).await;

        let deposits = match deposits_res {
            Ok(deposits) => deposits,
            Err(e) => {
                error!("Query new Kaspa deposits: {:?}", e);
                continue;
            }
        };
        let mut deposits_new = Vec::new();
        for d in deposits.into_iter() {
            if !cache.has_seen(&d).await {
                if d.time > start_relay_time {
                    start_relay_time = d.time
                }
                if d.id == tx {
                    return Ok(d);
                }
                cache.mark_as_seen(d.clone()).await;
                deposits_new.push(d);
            }
        }
    }
}

pub async fn demo(args: DemoArgs) -> Result<(), Box<dyn Error>> {
    kaspa_core::log::init_logger(None, "");

    let now: i64 = unix_now() as i64;

    let w = EasyKaspaWallet::try_new(EasyKaspaWalletArgs {
        wallet_secret: args.wallet_secret,
        wrpc_url: args.wprc_url,
        net: Network::KaspaTest10,
        storage_folder: None,
    })
    .await?;

    println!("address {}", &w.account().receive_address()?);
    println!("balance {}", &w.account().get_list_string()?);

    // deposit to escrow address
    let amt = args.amt;
    let escrow_address = args.escrow_address;

    let tx_id = if let Some(payload) = args.payload {
        info!("Dymension, sending deposit with payload: {:?}", payload);
        // deposit_impl(&w, &s, escrow_address.clone(), amt, payload.as_bytes().to_vec()).await?
        let bz = hex::decode(payload).unwrap();
        deposit_with_payload(&w.wallet, &w.secret, escrow_address.clone(), amt, bz).await?
    } else {
        do_deposit(&w.wallet, &w.secret, escrow_address.clone(), amt).await?
    };

    info!("Sent deposit transaction: {}", tx_id);

    if args.only_deposit {
        return Ok(());
    }

    let url = Url::parse("https://api-tn10.kaspa.org/").unwrap();
    let metrics_config = PrometheusConfig::from_url(&url, ClientConnectionType::Rpc, None);
    let metrics: PrometheusClientMetrics = PrometheusClientMetrics::default();
    let url = "https://api-tn10.kaspa.org/";
    let client: KaspaHttpClient =
        KaspaHttpClient::from_url(url.to_string(), metrics, metrics_config)?;

    let deposit_cache = DepositCache::new();
    let address = escrow_address.clone();

    let client_clone = client.clone();
    let handle: JoinHandle<Deposit> = tokio::spawn(async move {
        return deposit_loop(
            &deposit_cache,
            &client_clone,
            address.address_to_string(),
            tx_id,
        )
        .await
        .expect("deposit loop");
    });

    let result: Deposit = handle.await?;

    let escrow = escrow_address.clone();

    // Decode payload and add Kaspa metadata
    let payload = result
        .payload
        .as_ref()
        .ok_or_else(|| eyre::eyre!("Deposit has no payload"))?;
    let parsed_hl = ParsedHL::parse_string(payload)?;
    let amt_hl = parsed_hl.token_message.amount();

    // Find the UTXO index that satisfies the transfer amount
    let escrow_str = escrow.address_to_string();
    let utxo_index = result
        .outputs
        .iter()
        .position(|utxo| {
            U256::from(utxo.amount) >= amt_hl
                && utxo
                    .script_public_key_address
                    .as_ref()
                    .map(|addr| addr == &escrow_str)
                    .unwrap_or(false)
        })
        .ok_or_else(|| {
            eyre::eyre!(
                "kaspa deposit {} had insufficient sompi amount or no matching escrow output",
                result.id
            )
        })?;

    // Add Kaspa metadata to the Hyperlane message
    let hl_message_with_metadata =
        add_kaspa_metadata_hl_messsage(parsed_hl, result.id, utxo_index)?;

    // handle deposit (relayer operation)
    check_deposit_finality(&result, &client.client)
        .await
        .map_err(|e| eyre::eyre!("Deposit processing failed: {}", e))?;

    let deposit_fxg = build_deposit_fxg(hl_message_with_metadata, amt_hl, utxo_index, &result);

    // deposit encode to bytes
    let deposit_bytes_recv: Bytes = (&deposit_fxg).into();

    // deposit from bytes
    let deposit_recv = DepositFXG::try_from(deposit_bytes_recv)?;

    println!(
        "Deposit pulled by relay tx_id:{} block_id:{} amount:{}",
        deposit_recv.tx_id, deposit_recv.accepting_block_hash, deposit_recv.amount
    );

    let mut mm = DepositMustMatch::default();
    mm.set_validation(false);

    // validate deposit using kaspa rpc (validator operation)
    let validation_result = validate_new_deposit_inner(
        &w.api(),
        &client.client,
        &deposit_recv,
        &w.net,
        &escrow_address,
        true,
        mm,
    )
    .await?;

    println!("Deposit validated");

    Ok(())
}

pub async fn do_deposit(
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
