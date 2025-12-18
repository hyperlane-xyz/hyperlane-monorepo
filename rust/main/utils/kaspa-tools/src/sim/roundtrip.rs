//! Single roundtrip command - deposit from Kaspa to Hub, then withdraw back

use super::hub_whale_pool::HubWhale;
use super::kaspa_whale_pool::KaspaWhale;
use super::key_cosmos::EasyHubKey;
use super::round_trip::{do_round_trip, TaskArgs, TaskResources};
use super::stats::RoundTripStats;
use super::util::{create_cosmos_provider, SOMPI_PER_KAS};
use crate::x::args::RoundtripCli;
use dym_kas_core::api::base::RateLimitConfig;
use dym_kas_core::api::client::HttpClient;
use dym_kas_core::wallet::{EasyKaspaWallet, EasyKaspaWalletArgs};
use eyre::Result;
use kaspa_wallet_core::prelude::Secret;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

pub async fn do_roundtrip(cli: RoundtripCli) -> Result<()> {
    let kaspa_network = cli.bridge.parse_kaspa_network()?;
    let escrow_address = cli.bridge.parse_escrow_address()?;

    // Initialize wallets
    let kaspa_wallet = EasyKaspaWallet::try_new(EasyKaspaWalletArgs {
        wallet_secret: cli.kaspa_wallet_secret.clone(),
        wrpc_url: cli.bridge.kaspa_wrpc_url.clone(),
        net: kaspa_network.clone(),
        storage_folder: cli.kaspa_wallet_dir.clone(),
    })
    .await?;
    let kaspa_secret = Secret::from(cli.kaspa_wallet_secret.clone());
    let kaspa_addr = kaspa_wallet.wallet.account()?.receive_address()?;

    let hub_key = EasyHubKey::from_hex(&cli.hub_priv_key);
    let hub_addr = hub_key.signer().address_string.clone();

    let hub_provider = create_cosmos_provider(
        &hub_key,
        &cli.bridge.hub_rpc_url,
        &cli.bridge.hub_grpc_url,
        &cli.bridge.hub_chain_id,
        &cli.bridge.hub_prefix,
        &cli.bridge.hub_denom,
        cli.bridge.hub_decimals,
    )
    .await?;

    // Print config
    println!(
        "Roundtrip: {} sompi ({:.2} KAS)",
        cli.bridge.deposit_amount,
        cli.bridge.deposit_amount as f64 / SOMPI_PER_KAS as f64
    );
    println!("  Kaspa: {}", kaspa_addr);
    println!("  Hub:   {}", hub_addr);
    println!();

    // Build resources
    let task_args = TaskArgs {
        domain_kas: cli.bridge.domain_kas,
        token_kas_placeholder: cli.bridge.token_kas_placeholder,
        domain_hub: cli.bridge.domain_hub,
        token_hub: cli.bridge.token_hub,
        escrow_address,
        deposit_amount: cli.bridge.deposit_amount,
        withdrawal_fee_pct: cli.bridge.withdrawal_fee_pct,
    };

    let task_resources = TaskResources {
        hub: hub_provider.clone(),
        args: task_args,
        kas_rest: HttpClient::new(
            cli.bridge.kaspa_rest_url.clone(),
            RateLimitConfig::default(),
        ),
        kaspa_network,
    };

    // Wrap as whales (required by do_round_trip interface)
    let kaspa_whale = Arc::new(KaspaWhale {
        wallet: kaspa_wallet,
        secret: kaspa_secret,
        last_used: Mutex::new(Instant::now()),
        id: 0,
    });
    let hub_whale = Arc::new(HubWhale {
        provider: hub_provider,
        last_used: Mutex::new(Instant::now()),
        id: 0,
        tx_lock: AsyncMutex::new(()),
    });

    // Setup stats channel and timeout
    let (tx, mut rx) = mpsc::channel::<RoundTripStats>(32);
    let cancel_token = CancellationToken::new();
    let cancel_clone = cancel_token.clone();
    let timeout_secs = cli.timeout;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(timeout_secs)).await;
        cancel_clone.cancel();
    });

    // Run roundtrip in background, print progress from stats
    let rt_handle = tokio::spawn(async move {
        do_round_trip(task_resources, kaspa_whale, hub_whale, &tx, 0, cancel_token).await;
    });

    // Track progress
    let mut last_stage = String::new();
    let mut final_stats: Option<RoundTripStats> = None;

    while let Some(stats) = rx.recv().await {
        if stats.stage != last_stage {
            print_stage(&stats.stage);
            last_stage = stats.stage.clone();
        }
        final_stats = Some(stats);
    }

    rt_handle.await?;

    // Print result
    println!();
    let Some(stats) = final_stats else {
        println!("FAILED: no response");
        return Err(eyre::eyre!("no stats received"));
    };
    print_result(&stats)
}

fn print_stage(stage: &str) {
    let msg = match stage {
        "PreDeposit" => "[1/4] Submitting deposit...",
        "AwaitingDepositCredit" => "[2/4] Waiting for hub credit...",
        "PreWithdrawal" => "[3/4] Submitting withdrawal...",
        "AwaitingWithdrawalCredit" => "[4/4] Waiting for kaspa credit...",
        "Complete" => "Done",
        s if s.contains("NotCredited") => return, // error states handled in result
        _ => return,
    };
    println!("{}", msg);
}

fn print_result(stats: &RoundTripStats) -> Result<()> {
    let deposit_ok = stats.deposit_error.is_none() && stats.deposit_credit_error.is_none();
    let withdraw_ok = stats.withdrawal_error.is_none() && stats.withdraw_credit_error.is_none();

    let deposit_time = stats
        .deposit_credit_time_millis
        .zip(stats.kaspa_deposit_tx_time_millis)
        .map(|(end, start)| format_duration(end - start));

    let withdraw_time = stats
        .withdraw_credit_time_millis
        .zip(stats.hub_withdraw_tx_time_millis)
        .map(|(end, start)| format_duration(end - start));

    // Deposit result
    print!("Deposit:    ");
    if let Some(ref e) = stats.deposit_error {
        println!("FAILED ({})", e);
    } else if let Some(ref e) = stats.deposit_credit_error {
        println!("FAILED ({})", e);
    } else if let Some(t) = deposit_time {
        println!("OK ({})", t);
    } else {
        println!("INCOMPLETE");
    }

    // Withdrawal result
    print!("Withdrawal: ");
    if !deposit_ok {
        println!("SKIPPED");
    } else if let Some(ref e) = stats.withdrawal_error {
        println!("FAILED ({})", e);
    } else if let Some(ref e) = stats.withdraw_credit_error {
        println!("FAILED ({})", e);
    } else if let Some(t) = withdraw_time {
        println!("OK ({})", t);
    } else {
        println!("INCOMPLETE");
    }

    if deposit_ok && withdraw_ok && stats.stage == "Complete" {
        Ok(())
    } else {
        Err(eyre::eyre!("roundtrip failed"))
    }
}

fn format_duration(ms: u128) -> String {
    let secs = ms / 1000;
    if secs >= 60 {
        format!("{}m{}s", secs / 60, secs % 60)
    } else {
        format!("{}s", secs)
    }
}
