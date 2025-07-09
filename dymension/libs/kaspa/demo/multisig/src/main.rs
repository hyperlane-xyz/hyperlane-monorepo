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
    DEPOSIT_AMOUNT as e2e_deposit_amount, NETWORK_ID as e2e_network_id,
    RELAYER_NETWORK_FEE as e2e_relayer_network_fee, URL as e2e_url,
};
use relayer::withdraw::demo::*;
use relayer::withdraw::hub_to_kaspa::{
    build_withdrawal_pskt, combine_bundles_with_fee as relayer_combine_bundles_and_pay_fee,
    fetch_input_utxos,
};
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
async fn demo() -> Result<()> {
    kaspa_core::log::init_logger(None, "");

    let args = Args::parse();

    let w = EasyKaspaWallet::try_new(EasyKaspaWalletArgs {
        wallet_secret: args.wallet_secret.unwrap(),
        rpc_url: e2e_url.to_string(),
        network: Network::KaspaTest10,
    })
    .await?;

    let rpc = w.api();

    check_balance("wallet", rpc.as_ref(), &w.account().receive_address()?).await?;

    let e = Escrow::new(1);
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

    let payload = MessageIDs::from(vec![hl_msg.id()]).to_bytes()?;

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
    )
    .map_err(|e| eyre::eyre!("Build withdrawal PSKT: {}", e))?;

    info!("Constructed withdrawal PSKT");

    let new_anchor = TransactionOutpoint::new(pskt.calculate_id(), (pskt.outputs.len() - 1) as u32);

    let fxg = WithdrawFXG::new(
        Bundle::from(pskt),
        vec![vec![hl_msg]],
        vec![current_anchor, new_anchor],
    );

    let bundle_val = validator_sign_withdrawal_fxg(&fxg, e.keys.first().unwrap())?;

    info!("Signed withdrawal PSKT");

    let finalized = relayer_combine_bundles_and_pay_fee(
        vec![bundle_val],
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
        eprintln!("Error: {}", e);
    }
}
