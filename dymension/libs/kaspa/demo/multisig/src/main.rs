mod x;
use corelib::balance::*;
use corelib::escrow::*;
use corelib::user::deposit::deposit_with_payload as deposit;
use corelib::util::kaspa_address_to_h256;
use corelib::wallet::*;
use eyre::{eyre, Result};
use hardcode::e2e::{
    ADDRESS_PREFIX as e2e_address_prefix, DEPOSIT_AMOUNT as e2e_deposit_amount,
    MIN_DEPOSIT_SOMPI as e2e_min_deposit_sompi,
};
use hyperlane_core::HyperlaneMessage;
use hyperlane_core::{Encode, U256};
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_core::info;
use kaspa_wallet_pskt::prelude::*; // Import the prelude for easy access to traits/structs
use relayer::withdraw::hub_to_kaspa::combine_bundles_with_fee as relayer_combine_bundles_and_pay_fee;
use relayer::withdraw::messages::build_withdrawal_fxg;
use validator::withdraw::sign_withdrawal_fxg as validator_sign_withdrawal_fxg;
use validator::withdraw::{safe_bundle as validator_safe_bundle, validate_pskts};
use x::args::Args;

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
                    wrpc_url: full_url.clone(),
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

    let mut args = Args::parse();

    let w = load_wallet(&args, None).await?;

    let rpc = w.api();

    check_balance("wallet", rpc.as_ref(), &w.account().change_address()?).await?;

    let e = Escrow::new(8, 8);
    let e_public = e.public(e2e_address_prefix);
    info!("Created escrow address: {}", e_public.addr);

    let amt = e2e_deposit_amount;
    let escrow_addr = e_public.addr.clone();

    // Create 3 UTXOs on the escrow address

    // Initial UTXO == anchor
    let anchor_tx_id = deposit(&w.wallet, &w.secret, escrow_addr.clone(), amt * 2, vec![]).await?;
    info!("Sent deposit transaction: initial anchor: {}", anchor_tx_id);
    workflow_core::task::sleep(std::time::Duration::from_secs(1)).await;

    // Simulate deposits
    for i in 1..4 {
        let tx_id = deposit(&w.wallet, &w.secret, escrow_addr.clone(), amt, vec![]).await?;
        info!("Sent deposit transaction: deposit {}: {}", i, tx_id);
        workflow_core::task::sleep(std::time::Duration::from_secs(1)).await;
    }

    // Wait maturity
    workflow_core::task::sleep(std::time::Duration::from_secs(4)).await;

    check_balance("wallet", rpc.as_ref(), &w.account().change_address()?).await?;
    check_balance("escrow", rpc.as_ref(), &e_public.addr).await?;

    let token_message = TokenMessage::new(
        kaspa_address_to_h256(w.account().receive_address()?),
        U256::from(amt),
        vec![],
    );
    let hl_msg = HyperlaneMessage {
        body: token_message.to_vec(),
        ..Default::default()
    };

    let current_anchor = TransactionOutpoint::new(anchor_tx_id, 0);

    let fxg = build_withdrawal_fxg(
        vec![hl_msg],
        current_anchor,
        w.clone(),
        e_public.clone(),
        U256::from(e2e_min_deposit_sompi),
        1.3, // tx_fee_multiplier
    )
    .await
    .map_err(|e| eyre!("Build withdrawal FXG: {}", e))?;

    let fxg = fxg.ok_or(eyre!("Got none as withdrawal FXG"))?;

    info!("Constructed withdrawal PSKT");

    let safe_b = validator_safe_bundle(&fxg.bundle)?;

    let input_selector = |i: &Input| match i.redeem_script.clone() {
        Some(rs) => rs == e_public.redeem_script,
        None => false,
    };

    let messages = fxg.messages.clone();
    let old_anchor = fxg.anchors.first().cloned().unwrap();
    let mut val_bundles = Vec::new();
    for k in e.keys.iter().take(e.m()) {
        validate_pskts(
            &safe_b,
            &*messages,
            old_anchor,
            e_public.clone(),
            w.net.address_prefix,
        )
        .map_err(|e| eyre!("Failed to validate PSKT: {e}"))?;

        let bundle = validator_sign_withdrawal_fxg(
            &safe_b,
            || async { Ok(k.clone()) },
            Some(input_selector),
        )
        .await?;
        val_bundles.push(bundle);
    }

    info!("Signed withdrawal PSKT");

    let finalized =
        relayer_combine_bundles_and_pay_fee(val_bundles, &fxg, e.m(), &e_public, &w).await?;

    info!("Signed relayer fee and finalized withdrawal RPC TX");

    finalized.iter().enumerate().for_each(|(tx_idx, tx)| {
        tx.outputs.iter().enumerate().for_each(|(o_idx, o)| {
            info!("TX #{} Output #{}: {}", tx_idx, o_idx, o.value);
        });
    });

    for tx in finalized {
        let allow_orphan = false; // TODO: false is good or not?
        let tx_id = rpc.submit_transaction(tx, allow_orphan).await?;
        info!("TX #{tx_id} is broadcasted");
    }

    workflow_core::task::sleep(std::time::Duration::from_secs(5)).await;

    check_balance("wallet", rpc.as_ref(), &w.account().change_address()?).await?;
    check_balance("escrow", rpc.as_ref(), &e_public.addr).await?;

    w.wallet.stop().await?;
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(e) = demo().await {
        eprintln!("Error: {e}");
    }
}
