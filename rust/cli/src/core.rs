// Shared code to be moved to apppropriate modules.

use color_eyre::{eyre::Context, Result};
use ethers::prelude::k256::ecdsa::SigningKey;
use ethers::signers::Wallet;
use ethers::{
    prelude::SignerMiddleware,
    signers::{LocalWallet, Signer},
};
use ethers::{
    providers::{Http, Middleware, Provider},
    types::Address,
};
use hyperlane_core::H256;
use hyperlane_core::{
    HyperlaneDomain, HyperlaneDomainProtocol, HyperlaneDomainType, KnownHyperlaneDomain,
};
use std::sync::Arc;

pub fn get_hyperlane_domain(chain_id: u32) -> HyperlaneDomain {
    match KnownHyperlaneDomain::try_from(chain_id) {
        Ok(domain) => HyperlaneDomain::Known(domain),
        Err(_) => HyperlaneDomain::Unknown {
            domain_id: chain_id,
            domain_name: "Unknown".to_string(),
            domain_type: HyperlaneDomainType::Unknown,
            domain_protocol: HyperlaneDomainProtocol::Ethereum,
        },
    }
}

pub async fn show_block_number(
    provider: &Provider<Http>,
    endpoint: &str,
) -> Result<(), color_eyre::Report> {
    let block_number = provider
        .get_block_number()
        .await
        .with_context(|| format!("Failed to retrieve block number from {endpoint}"))?
        .as_u64();
    println!("Block: {block_number}");
    Ok(())
}

pub async fn show_balances(
    provider: &Provider<Http>,
    sender_address: Address,
    recipient_address: Address,
    stage: Option<&str>,
) -> Result<()> {
    let sender_balance = provider.get_balance(sender_address, None).await?;
    let recipient_balance = provider.get_balance(recipient_address, None).await?;

    if let Some(stage) = stage {
        println!("{stage} transaction:");
    }
    println!(
        "  Sender balance   : {sender_balance:?}\n  Recipient balance: {recipient_balance:?}\n"
    );

    Ok(())
}

pub fn get_client<S: Signer>(
    provider: Arc<Provider<Http>>,
    sender_wallet: S,
) -> Arc<SignerMiddleware<Arc<Provider<Http>>, S>> {
    Arc::new(SignerMiddleware::new(provider, sender_wallet))
}

pub fn get_wallet(key: H256, chain_id: u32) -> Result<Wallet<SigningKey>> {
    let sender_wallet = LocalWallet::from_bytes(key.as_bytes())
        .context("Failed to create wallet from private key")?
        .with_chain_id(chain_id);
    Ok(sender_wallet)
}

pub fn show_hyperlane_domain(chain_id: u32) {
    let domain = get_hyperlane_domain(chain_id);
    println!(
        "\nHyperlane domain: {:?}, {:?} ({}: {})",
        domain.domain_type(),
        domain.domain_protocol(),
        domain.id(),
        domain.name()
    );
}

pub async fn get_provider(
    rpc_url: String,
) -> Result<(Arc<Provider<Http>>, u32), color_eyre::Report> {
    println!("Connecting to: {rpc_url}");
    let provider = Arc::new(
        Provider::<Http>::try_from(rpc_url.clone())
            .with_context(|| format!("Failed to create provider for {rpc_url}"))?,
    );

    // let block_number = provider
    //     .get_block_number()
    //     .await
    //     .with_context(|| format!("Failed to retrieve block number from {rpc_url}"))?
    //     .as_u64();
    // println!("  Block: {block_number}");

    let chain_id = provider
        .get_chainid()
        .await
        .with_context(|| format!("Failed to retrieve chain id for {rpc_url}"))?
        .as_u32();

    show_connected_hyperlane_domain_details(chain_id);

    Ok((provider, chain_id))
}

fn show_connected_hyperlane_domain_details(chain_id: u32) {
    let domain = get_hyperlane_domain(chain_id);
    let domain_name = match &domain {
        HyperlaneDomain::Known(domain) => format!("{domain:?}"),
        HyperlaneDomain::Unknown { domain_name, .. } => domain_name.to_owned(),
    };

    println!(
        "Connected, chain identified as: {} {} {:?} {:?}",
        chain_id,
        domain_name,
        domain.domain_protocol(),
        domain.domain_type()
    );
}

pub fn option_into_display_string<T: std::fmt::Display>(opt: &Option<T>) -> String {
    match opt {
        Some(value) => format!("{}", value),
        None => String::from("None"),
    }
}

pub fn option_into_debug_string<T: std::fmt::Debug>(opt: &Option<T>) -> String {
    match opt {
        Some(value) => format!("{:?}", value),
        None => String::from("None"),
    }
}
