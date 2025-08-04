#![allow(unused)] // TODO: remove
use eyre::{eyre, Result};

mod x;

use corelib::balance::*;
use corelib::deposit::*;
use corelib::escrow::*;
use corelib::user::deposit::deposit_with_payload as deposit;
use corelib::wallet::*;
use hardcode::e2e::{
    get_tn10_config as e2e_config, ADDRESS_PREFIX as e2e_address_prefix,
    DEPOSIT_AMOUNT as e2e_deposit_amount, MIN_DEPOSIT_SOMPI as e2e_min_deposit_sompi,
    NETWORK_ID as e2e_network_id, RELAYER_NETWORK_FEE as e2e_relayer_network_fee, URL as e2e_url,
};
use hyperlane_core::U256;
use relayer::withdraw::demo::*;
use relayer::withdraw::hub_to_kaspa::{
    build_withdrawal_pskt, combine_bundles_with_fee as relayer_combine_bundles_and_pay_fee,
    fetch_input_utxos,
};
use validator::withdraw::safe_bundle as validator_safe_bundle;
use validator::withdraw::sign_withdrawal_fxg as validator_sign_withdrawal_fxg;
use x::args::Args;

use std::sync::Arc;

use corelib::withdraw::WithdrawFXG;
use hyperlane_core::{HyperlaneMessage, H256};
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
use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::tx::Fees;

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::*; // Import the prelude for easy access to traits/structs

use kaspa_txscript::{
    extract_script_pub_key_address, multisig_redeem_script, pay_to_address_script,
    pay_to_script_hash_script,
};

use secp256k1::{rand::thread_rng, Keypair};

use corelib::payload::MessageIDs;
use corelib::util::get_recipient_script_pubkey_address;
use kaspa_rpc_core::api::rpc::RpcApi;
use workflow_core::abortable::Abortable;
/*
Demo:
The purpose is to test out using a multisig for securing an escrow address.
There are three roles, signer 1 and 2, and a relayer.
The relayer is responsible for building and orchestrating the multisig TXs, including paying any fees.
The signers are just responsible for signing.

The test involves a 'user', which corresponds to the local wallet account.

Steps are:

1. Create an escrow address.
2. User deposits some funds to the escrow address.
3. The relayer builds a multisig TX to send the funds back to the user from the escrow address.
4. The signers sign the TX.
5. The relayer sends the TX to the network.

Always, we want to get confirmation that everything has worked, been accepted by the network etc.

We will test against testnet 10. The wallet has 200'000 KAS available.

*/
async fn load_wallet(args: &Args, url: Option<&str>) -> Result<EasyKaspaWallet> {
    // if url is none will try to build one
    // nslookup n-testnet-10.kaspa.ws
    for u in vec![
        "65.109.145.174",
        "152.53.18.176",
        "57.129.49.28",
        "95.217.61.211",
        "185.69.54.99",
        "23.88.70.20",
        "122.116.168.37",
        "152.53.21.111",
        "152.53.54.29",
        "89.58.46.206",
        "79.137.67.110",
        "38.242.150.130",
        "167.235.98.225",
        "144.76.19.91",
        "184.190.99.128",
        "157.90.201.188",
    ] {
        for pre in ["", "http://", "https://", "ws://", "wss://"] {
            for suf in ["", ":16210", ":17210"] {
                let full_url: String = match url {
                    Some(url) => url.to_string(),
                    None => format!("{pre}{u}{suf}"),
                };
                let w = EasyKaspaWallet::try_new(EasyKaspaWalletArgs {
                    wallet_secret: args.wallet_secret.as_ref().unwrap().clone(),
                    rpc_url: full_url.clone(),
                    net: Network::KaspaTest10,
                    storage_folder: None,
                })
                .await;
                if w.is_ok() {
                    println!("Connected to wallet at {full_url}");
                    return w;
                }
            }
        }
    }
    Err(eyre::eyre!("Failed to connect to wallet"))
}

async fn demo() -> Result<()> {
    kaspa_core::log::init_logger(None, "");

    let args = Args::parse();

    let w = load_wallet(&args, Some(e2e_url)).await?;

    let rpc = w.api();

    check_balance("wallet", rpc.as_ref(), &w.account().receive_address()?).await?;

    let e = Escrow::new(2, 3);
    info!(
        "Created escrow address: {}",
        e.public(e2e_address_prefix).addr
    );

    let amt = e2e_deposit_amount;
    let escrow_addr = e.public(e2e_address_prefix).addr;
    let tx_id = deposit(&w.wallet, &w.secret, escrow_addr, 2 * amt, vec![]).await?;
    info!("Sent deposit transaction: {}", tx_id);

    workflow_core::task::sleep(std::time::Duration::from_secs(5)).await;

    check_balance("wallet", rpc.as_ref(), &w.account().receive_address()?).await?;
    check_balance("escrow", rpc.as_ref(), &e.public(e2e_address_prefix).addr).await?;

    let user_addr = w.account().receive_address()?;

    let hl_msg = HyperlaneMessage::default();

    let payload = MessageIDs::from(vec![hl_msg.id()]).to_bytes();

    let current_anchor = TransactionOutpoint::new(tx_id, 0);

    let inputs = fetch_input_utxos(
        &rpc,
        &e.public(e2e_address_prefix),
        &w.account().change_address().unwrap(),
        &current_anchor,
        e2e_network_id,
    )
    .await
    .map_err(|e| eyre::eyre!("Fetch input utxos: {}", e))?;

    let pskt = build_withdrawal_pskt(
        inputs,
        vec![TransactionOutput::new(
            amt,
            get_recipient_script_pubkey_address(&user_addr),
        )],
        payload,
        &e.public(e2e_address_prefix),
        &w.account().change_address().unwrap(),
        e2e_network_id,
        U256::from(e2e_min_deposit_sompi),
    )
    .map_err(|e| eyre::eyre!("Build withdrawal PSKT: {}", e))?;

    info!("Constructed withdrawal PSKT");

    let new_anchor = TransactionOutpoint::new(pskt.calculate_id(), (pskt.outputs.len() - 1) as u32);

    let fxg = WithdrawFXG::new(
        Bundle::from(pskt),
        vec![vec![hl_msg]],
        vec![current_anchor, new_anchor],
    );

    let safe_b = validator_safe_bundle(&fxg.bundle)?;

    let input_selector = |i: &Input| match i.redeem_script.clone() {
        Some(rs) => rs == e.public(e2e_address_prefix).redeem_script,
        None => false,
    };

    let val_bundles = e
        .keys
        .iter()
        .take(e.m())
        .map(|k| validator_sign_withdrawal_fxg(&safe_b, k, Some(input_selector)))
        .collect::<Result<Vec<_>>>()?;

    info!("Signed withdrawal PSKT");

    let finalized = relayer_combine_bundles_and_pay_fee(
        val_bundles,
        &fxg,
        e.m(),
        &e.public(e2e_address_prefix),
        &w,
    )
    .await?;

    info!("Signed relayer fee and finalized withdrawal RPC TX");

    finalized.iter().for_each(|tx| {
        tx.outputs.iter().for_each(|o| {
            info!("Output: {}", o.value);
        });
    });

    let res = rpc
        .submit_transaction(finalized.first().unwrap().clone(), false)
        .await?;

    workflow_core::task::sleep(std::time::Duration::from_secs(5)).await;

    check_balance("wallet", rpc.as_ref(), &w.account().receive_address()?).await?;
    check_balance("escrow", rpc.as_ref(), &e.public(e2e_address_prefix).addr).await?;

    w.wallet.stop().await?;
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(e) = demo().await {
        eprintln!("Error: {e}");
    }
}
