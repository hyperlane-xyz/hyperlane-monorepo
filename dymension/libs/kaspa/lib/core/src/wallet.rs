use eyre::Result;
use kaspa_addresses::{Prefix, Version};
use kaspa_consensus_core::network::{NetworkId, NetworkType};
use kaspa_wallet_core::api::WalletApi;
use kaspa_wallet_core::derivation::build_derivate_paths;
use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::prelude::*;
use kaspa_wallet_core::storage::local::set_default_storage_folder as unsafe_set_default_storage_folder_kaspa; // Import the prelude for easy access to traits/structs
use kaspa_wallet_core::utxo::NetworkParams;
use kaspa_wallet_core::wallet::Wallet;
use kaspa_wallet_keys::secret::Secret;
use kaspa_wallet_pskt::prelude::KeySource;
use kaspa_wrpc_client::Resolver;
use std::fmt;
use std::sync::Arc;
use tracing::info;

pub async fn get_wallet(
    s: &Secret,
    network_id: NetworkId,
    url: String,
    storage_folder: Option<String>,
) -> Result<Arc<Wallet>, Error> {
    if let Some(storage_folder) = storage_folder {
        unsafe { unsafe_set_default_storage_folder_kaspa(storage_folder) }?;
    }

    let local_store = Wallet::local_store()
        .map_err(|e| Error::from(format!("Failed to open wallet local store: {e}")))?;

    let w = Arc::new(
        Wallet::try_new(local_store, Some(Resolver::default()), Some(network_id))
            .map_err(|e| Error::from(format!("Failed to create wallet: {e}")))?,
    );

    // Start background services (UTXO processor, event handling).
    w.start()
        .await
        .map_err(|e| Error::from(format!("Failed to start wallet: {e}")))?;

    w.clone()
        .connect(Some(url), &network_id)
        .await
        .map_err(|e| Error::from(format!("Failed to connect wallet: {e}")))?;

    let is_c = w.is_connected();
    info!(connected = is_c, "kaspa: wallet connection status");

    info!("kaspa: wallet secret loaded");

    w.clone()
        .wallet_open(s.clone(), None, true, false)
        .await
        .map_err(|e| Error::from(format!("Failed to open wallet: {e}")))?;

    let accounts = w
        .clone()
        .accounts_enumerate()
        .await
        .map_err(|e| Error::from(format!("Failed to enumerate accounts: {e}")))?;

    let account_descriptor = accounts.first().ok_or("Wallet has no accounts.")?;

    let account_id = account_descriptor.account_id;
    info!(
        account_id = ?account_id,
        receive_address = ?account_descriptor.receive_address,
        change_address = ?account_descriptor.change_address,
        "kaspa: wallet account loaded"
    );

    w.clone()
        .accounts_select(Some(account_id))
        .await
        .map_err(|e| Error::from(format!("Failed to select wallet account: {e}")))?;

    w.clone()
        .accounts_activate(Some(vec![account_id]))
        .await
        .map_err(|e| Error::from(format!("Failed to activate wallet account: {e}")))?;

    Ok(w)
}

#[derive(Clone)]
pub struct EasyKaspaWallet {
    pub wallet: Arc<Wallet>,
    pub secret: Secret,
    pub net: NetworkInfo,
}

// Implement Debug for your wrapper
impl fmt::Debug for EasyKaspaWallet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EasyKaspaWallet(<...>)") // TODO:
    }
}

pub struct EasyKaspaWalletArgs {
    pub wallet_secret: String, // this the short password that protects the keychain, not the private key of the crypto account
    pub wrpc_url: String,      // .e.g localhost:16210
    pub net: Network,
    pub storage_folder: Option<String>,
}

impl EasyKaspaWallet {
    pub async fn try_new(args: EasyKaspaWalletArgs) -> Result<Self> {
        let s = Secret::from(args.wallet_secret);
        let info = NetworkInfo::new(args.net, args.wrpc_url);
        let w = get_wallet(
            &s,
            info.clone().network_id,
            info.clone().rpc_url,
            args.storage_folder,
        )
        .await?;
        let node_info = w.rpc_api().get_server_info().await?;
        if !node_info.is_synced {
            return Err(eyre::eyre!("Kaspa WPRC node is not synced"));
        }
        if !node_info.has_utxo_index {
            return Err(eyre::eyre!("Kaspa WPRC node does not have utxo index"));
        }
        Ok(Self {
            wallet: w,
            secret: s,
            net: info,
        })
    }

    pub fn api(&self) -> Arc<DynRpcApi> {
        self.wallet.rpc_api()
    }

    pub fn account(&self) -> Arc<dyn Account> {
        self.wallet.account().unwrap()
    }

    pub async fn signing_resources(&self) -> Result<SigningResources> {
        // The code above combines `Account.pskb_sign` and `pskb_signer_for_address` functions.
        // It's a hack allowing to sign PSKT with a custom payload.
        // https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/core/src/account/pskb.rs#L154
        // https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/core/src/account/mod.rs#L383
        let w = self.wallet.clone();
        let derivation = w.account()?.as_derivation_capable()?;
        let keydata = w.account()?.prv_key_data(self.secret.clone()).await?;
        let addr = w.account()?.change_address()?;
        let (receive, change) = derivation.derivation().addresses_indexes(&[&addr])?;
        let pks = derivation.create_private_keys(&keydata, &None, &receive, &change)?;
        let (_, priv_key) = pks.first().unwrap();

        let xprv = keydata.get_xprv(None)?;
        let key_pair = secp256k1::Keypair::from_secret_key(secp256k1::SECP256K1, priv_key);

        // Get derivation path for the account. build_derivate_paths returns receive and change paths, respectively.
        // Use receive one as it is used in `Account.pskb_sign`.
        let (derivation_path, _) = build_derivate_paths(
            &derivation.account_kind(),
            derivation.account_index(),
            derivation.cosigner_index(),
        )?;

        let key_fingerprint = xprv.public_key().fingerprint();

        Ok(SigningResources {
            key_source: KeySource::new(key_fingerprint, derivation_path),
            key_pair,
        })
    }

    pub async fn pub_key(&self) -> Result<secp256k1::PublicKey> {
        Ok(self.signing_resources().await?.key_pair.public_key())
    }
}

pub struct SigningResources {
    pub key_source: KeySource,
    pub key_pair: secp256k1::Keypair,
}

#[derive(Clone, Debug)]
pub struct NetworkInfo {
    pub network_id: NetworkId,
    pub network_type: NetworkType,
    pub address_prefix: Prefix,
    pub address_version: Version,
    pub rpc_url: String,
}

impl NetworkInfo {
    pub fn network_params(&self) -> &NetworkParams {
        NetworkParams::from(self.network_id)
    }
}

#[derive(Clone, Debug)]
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
            Network::KaspaMainnet => Self {
                network_id: NetworkId::new(NetworkType::Mainnet),
                network_type: NetworkType::Mainnet,
                address_prefix: Prefix::Mainnet,
                address_version: Version::PubKey,
                rpc_url,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn test_network_id() {
        let network = NetworkId::with_suffix(NetworkType::Testnet, 10);
        println!("network: {:?}", network.to_string());

        let name = "testnet-10";
        let id = NetworkId::from_str(name).unwrap();
        println!("id: {:?}", id.to_string());
    }

    #[tokio::test]
    #[ignore]
    async fn test_create_new_easy_wallet() {
        let rpc_url = "65.109.145.174".to_string(); // A public rpc url
        let network = Network::KaspaTest10;
        let _net_info = NetworkInfo::new(network.clone(), rpc_url.clone());

        let secret = "lkjsdf";
        let easy_wallet = EasyKaspaWallet::try_new(EasyKaspaWalletArgs {
            wallet_secret: secret.to_string(),
            wrpc_url: rpc_url.clone(),
            net: network,
            storage_folder: None,
        })
        .await
        .unwrap();

        let utxos = easy_wallet
            .api()
            .get_utxos_by_addresses(vec![Address::try_from(
                // playground escrow
                "kaspatest:pp07zhcxnm4zkw3k4d0vr6efhef8c7yg47ukdxe5uhmtgt5s4ayr6rud2mst2",
            )
            .unwrap()])
            .await
            .unwrap();
        assert!(!utxos.is_empty());
        assert!(0 < utxos.len());
    }
}
