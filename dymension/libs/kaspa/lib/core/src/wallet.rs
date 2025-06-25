#![allow(unused)] // TODO: remove

use eyre::Result;
use kaspa_addresses::{Prefix, Version};
use kaspa_consensus_core::network::{NetworkId, NetworkType};
use kaspa_core::info;
use kaspa_wallet_core::api::WalletApi;
use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::wallet::Wallet;
use kaspa_wallet_keys::secret::Secret;
use std::fmt;

use kaspa_wallet_core::prelude::*; // Import the prelude for easy access to traits/structs

use std::sync::Arc;

use kaspa_wrpc_client::Resolver;

pub async fn get_wallet(
    s: &Secret,
    network_id: NetworkId,
    url: String,
) -> Result<Arc<Wallet>, Error> {
    let w = Arc::new(Wallet::try_new(
        Wallet::local_store()?,
        Some(Resolver::default()),
        Some(network_id),
    )?);

    // Start background services (UTXO processor, event handling).
    w.start().await?;

    w.clone().connect(Some(url), &network_id).await?;

    let is_c = w.is_connected();
    info!("connected: {:?}", is_c);

    w.clone().wallet_open(s.clone(), None, true, false).await?;

    let accounts = w.clone().accounts_enumerate().await?;
    let account_descriptor = accounts.get(0).ok_or("Wallet has no accounts.")?;
    let account_id = account_descriptor.account_id;
    info!(
        "Account ID: {:?}, recv addr: {:?}, change addr: {:?}",
        account_id, account_descriptor.receive_address, account_descriptor.change_address
    );

    w.clone().accounts_select(Some(account_id)).await?;
    w.clone().accounts_activate(Some(vec![account_id])).await?;

    Ok(w)
}

#[derive(Clone)]
pub struct EasyKaspaWallet {
    wallet: Arc<Wallet>,
    network_info: NetworkInfo,
}

// Implement Debug for your wrapper
impl fmt::Debug for EasyKaspaWallet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EasyKaspaWallet(<...>)") // TODO:
    }
}

pub struct EasyKaspaWalletArgs {
    pub wallet_secret: String, // this the short password that protects the keychain, not the private key of the crypto account
    pub rpc_url: String,       // .e.g localhost:16210
    pub network: Network,
}

impl EasyKaspaWallet {
    pub async fn try_new(args: EasyKaspaWalletArgs) -> Result<Self> {
        let s = Secret::from(args.wallet_secret);
        let info = NetworkInfo::new(args.network, args.rpc_url);
        let w = get_wallet(&s, info.clone().network_id, info.clone().rpc_url).await?;
        Ok(Self {
            wallet: w,
            network_info: info,
        })
    }

    pub fn network(&self) -> NetworkType {
        self.network_info.network_type
    }

    pub fn network_id(&self) -> NetworkId {
        self.network_info.network_id
    }

    pub fn address_prefix(&self) -> Prefix {
        self.network_info.address_prefix
    }

    pub fn address_version(&self) -> Version {
        self.network_info.address_version
    }

    pub fn api(&self) -> Arc<DynRpcApi> {
        self.wallet.rpc_api()
    }

    pub fn account(&self) -> Arc<dyn Account> {
        self.wallet.account().unwrap()
    }
}

#[derive(Clone, Debug)]
struct NetworkInfo {
    pub network_id: NetworkId,
    pub network_type: NetworkType,
    pub address_prefix: Prefix,
    pub address_version: Version,
    pub rpc_url: String,
}

pub enum Network {
    KaspaTest10,
    KaspaMainnet,
}

impl NetworkInfo {
    pub fn new(network: Network, rpc_url: String) -> Self {
        match network {
            Network::KaspaTest10 => Self {
                network_id: NetworkId::with_suffix(NetworkType::Testnet, 10),
                network_type: NetworkType::Testnet,
                address_prefix: Prefix::Testnet,
                address_version: Version::PubKey,
                rpc_url,
            },
            _ => todo!("only tn10 supported"),
        }
        // TODO: finish
    }
}
