use async_trait::async_trait;
use ethers::prelude::{AwsSigner, LocalWallet};
use ethers::utils::hex::ToHex;
use eyre::{bail, Context, Report};
use rusoto_core::Region;
use rusoto_kms::KmsClient;
use tracing::instrument;

use hyperlane_core::{AccountAddressType, H256};

use super::aws_credentials::AwsChainCredentialsProvider;
use crate::types::utils;

/// Signer types
#[derive(Default, Debug, Clone)]
pub enum SignerConf {
    /// A local hex key
    HexKey {
        /// Private key value
        key: H256,
    },
    /// An AWS signer. Note that AWS credentials must be inserted into the env
    /// separately.
    Aws {
        /// The UUID identifying the AWS KMS Key
        id: String,
        /// The AWS region
        region: Region,
    },
    /// Cosmos Specific key
    CosmosKey {
        /// Private key value
        key: H256,
        /// Prefix for cosmos address
        prefix: String,
        /// Account address type for cosmos address
        account_address_type: AccountAddressType,
    },
    /// Starknet Specific key
    StarkKey {
        /// Private key value
        key: H256,
        /// Starknet address
        address: H256,
        /// Version of the Starknet signer
        version: u32,
    },
    /// Assume node will sign on RPC calls
    #[default]
    Node,
}

impl SignerConf {
    /// Try to convert the ethereum signer to a local wallet
    #[instrument(err)]
    pub async fn build<S: BuildableWithSignerConf>(&self) -> Result<S, Report> {
        S::build(self).await
    }
}

/// A signer for a chain.
pub trait ChainSigner: Send {
    /// The address of the signer, formatted in the chain's own address format.
    fn address_string(&self) -> String;
    /// The address of the signer, in h256 format
    fn address_h256(&self) -> H256;
}

/// Builder trait for signers
#[async_trait]
pub trait BuildableWithSignerConf: Sized + ChainSigner {
    /// Build a signer from a conf
    async fn build(conf: &SignerConf) -> Result<Self, Report>;
}

#[async_trait]
impl BuildableWithSignerConf for hyperlane_ethereum::Signers {
    async fn build(conf: &SignerConf) -> Result<Self, Report> {
        Ok(match conf {
            SignerConf::HexKey { key } => hyperlane_ethereum::Signers::Local(LocalWallet::from(
                ethers::core::k256::ecdsa::SigningKey::from(
                    ethers::core::k256::SecretKey::from_slice(key.as_bytes())
                        .context("Invalid ethereum signer key")?,
                ),
            )),
            SignerConf::Aws { id, region } => {
                let client = KmsClient::new_with_client(
                    rusoto_core::Client::new_with(
                        AwsChainCredentialsProvider::new(),
                        utils::http_client_with_timeout().unwrap(),
                    ),
                    region.clone(),
                );

                let signer = AwsSigner::new(client, id, 0).await?;
                hyperlane_ethereum::Signers::Aws(signer)
            }
            SignerConf::CosmosKey { .. } => {
                bail!("cosmosKey signer is not supported by Ethereum")
            }
            SignerConf::StarkKey { .. } => {
                bail!("starkKey signer is not supported by Ethereum")
            }
            SignerConf::Node => bail!("Node signer"),
        })
    }
}

impl ChainSigner for hyperlane_ethereum::Signers {
    fn address_string(&self) -> String {
        ethers::signers::Signer::address(self).encode_hex()
    }
    fn address_h256(&self) -> H256 {
        ethers::types::H256::from(ethers::signers::Signer::address(self)).into()
    }
}

#[async_trait]
impl BuildableWithSignerConf for fuels::prelude::WalletUnlocked {
    async fn build(conf: &SignerConf) -> Result<Self, Report> {
        if let SignerConf::HexKey { key } = conf {
            let key = fuels::crypto::SecretKey::try_from(key.as_bytes())
                .context("Invalid fuel signer key")?;
            Ok(fuels::prelude::WalletUnlocked::new_from_private_key(
                key, None,
            ))
        } else {
            bail!(format!("{conf:?} key is not supported by fuel"));
        }
    }
}

impl ChainSigner for fuels::prelude::WalletUnlocked {
    fn address_string(&self) -> String {
        self.address().to_string()
    }
    fn address_h256(&self) -> H256 {
        H256::from_slice(fuels::types::Address::from(self.address()).as_slice())
    }
}

#[async_trait]
impl BuildableWithSignerConf for hyperlane_sealevel::Keypair {
    async fn build(conf: &SignerConf) -> Result<Self, Report> {
        if let SignerConf::HexKey { key } = conf {
            hyperlane_sealevel::create_keypair(key)
        } else {
            bail!(format!("{conf:?} key is not supported by sealevel"));
        }
    }
}

impl ChainSigner for hyperlane_sealevel::Keypair {
    fn address_string(&self) -> String {
        solana_sdk::signer::Signer::pubkey(self).to_string()
    }
    fn address_h256(&self) -> H256 {
        H256::from_slice(&solana_sdk::signer::Signer::pubkey(self).to_bytes())
    }
}

#[async_trait]
impl BuildableWithSignerConf for hyperlane_cosmos::Signer {
    async fn build(conf: &SignerConf) -> Result<Self, Report> {
        if let SignerConf::CosmosKey {
            key,
            prefix,
            account_address_type,
        } = conf
        {
            Ok(hyperlane_cosmos::Signer::new(
                key.as_bytes().to_vec(),
                prefix.clone(),
                account_address_type,
            )?)
        } else {
            bail!(format!("{conf:?} key is not supported by cosmos"));
        }
    }
}

impl ChainSigner for hyperlane_cosmos::Signer {
    fn address_string(&self) -> String {
        self.address_string.clone()
    }
    fn address_h256(&self) -> H256 {
        self.address_h256()
    }
}

#[async_trait]
impl BuildableWithSignerConf for hyperlane_starknet::Signer {
    async fn build(conf: &SignerConf) -> Result<Self, Report> {
        if let SignerConf::StarkKey {
            key,
            address,
            version,
        } = conf
        {
            Ok(hyperlane_starknet::Signer::new(key, address, *version)?)
        } else {
            bail!(format!("{conf:?} key is not supported by starknet"));
        }
    }
}

#[async_trait]
impl BuildableWithSignerConf for hyperlane_cosmos_native::Signer {
    async fn build(conf: &SignerConf) -> Result<Self, Report> {
        if let SignerConf::CosmosKey {
            key,
            prefix,
            account_address_type,
        } = conf
        {
            Ok(hyperlane_cosmos_native::Signer::new(
                key.as_bytes().to_vec(),
                prefix.clone(),
                account_address_type,
            )?)
        } else {
            bail!(format!("{conf:?} key is not supported by cosmos"));
        }
    }
}

impl ChainSigner for hyperlane_starknet::Signer {
    fn address_string(&self) -> String {
        self.address.to_string()
    }
}

impl ChainSigner for hyperlane_cosmos_native::Signer {
    fn address_string(&self) -> String {
        self.address_string.clone()
    }
    fn address_h256(&self) -> H256 {
        self.address_h256()
    }
}

#[cfg(test)]
mod tests {
    use ethers::{signers::LocalWallet, utils::hex};
    use hyperlane_core::{AccountAddressType, Encode, H256};

    use crate::settings::ChainSigner;

    #[test]
    fn address_h256_ethereum() {
        const PRIVATE_KEY: &str =
            "2bcd4cb33dc9b879d74aebb847b0fdd27868ade2b3a999988debcaae763283c6";
        const ADDRESS: &str = "0000000000000000000000000bec35c9af305b1b8849d652f4b542d19ef7e8f9";

        let wallet = PRIVATE_KEY
            .parse::<LocalWallet>()
            .expect("Failed to parse private key");

        let chain_signer = hyperlane_ethereum::Signers::Local(wallet);

        let address_h256 = H256::from_slice(
            hex::decode(ADDRESS)
                .expect("Failed to decode public key")
                .as_slice(),
        );
        assert_eq!(chain_signer.address_h256(), address_h256);
    }

    #[test]
    fn address_h256_sealevel() {
        const PRIVATE_KEY: &str =
            "0d861aa9ee7b09fe0305a649ec9aa0dfede421817dbe995b48964e5a79fc89e50f8ac473c042cdd96a1fc81eac32221188807572521429fb871a856a668502a5";
        const ADDRESS: &str = "0f8ac473c042cdd96a1fc81eac32221188807572521429fb871a856a668502a5";

        let chain_signer = hyperlane_sealevel::Keypair::from_bytes(
            hex::decode(PRIVATE_KEY)
                .expect("Failed to decode private key")
                .as_slice(),
        )
        .expect("Failed to decode keypair");

        let address_h256 = H256::from_slice(
            hex::decode(ADDRESS)
                .expect("Failed to decode public key")
                .as_slice(),
        );
        assert_eq!(chain_signer.address_h256(), address_h256);
    }

    #[test]
    fn address_h256_fuel() {
        const PRIVATE_KEY: &str =
            "0a83ee2a87f328704512567198ee25578c27c707b26fdf3be9ea8bf8588f3b65";
        const PUBLIC_KEY: &str = "b43425b2256e7dcdd61752808b137b23f4f697cfaf21175ed81d0610ebab5a87";

        let private_key = fuels::crypto::SecretKey::try_from(
            hex::decode(PRIVATE_KEY)
                .expect("Failed to decode private key")
                .as_slice(),
        )
        .expect("Failed to create secret key");

        let chain_signer = fuels::prelude::WalletUnlocked::new_from_private_key(private_key, None);

        let address_h256 = H256::from_slice(
            hex::decode(PUBLIC_KEY)
                .expect("Failed to decode public key")
                .as_slice(),
        );
        assert_eq!(chain_signer.address_h256(), address_h256);
    }

    #[test]
    fn address_h256_cosmos() {
        const PRIVATE_KEY: &str =
            "5486418967eabc770b0fcb995f7ef6d9a72f7fc195531ef76c5109f44f51af26";
        const ADDRESS: &str = "000000000000000000000000b5a79b48c87e7a37bdb625096140ee7054816942";

        let key = H256::from_slice(
            hex::decode(PRIVATE_KEY)
                .expect("Failed to decode public key")
                .as_slice(),
        );
        let chain_signer = hyperlane_cosmos::Signer::new(
            key.to_vec(),
            "neutron".to_string(),
            &AccountAddressType::Bitcoin,
        )
        .expect("Failed to create cosmos signer");

        let address_h256 = H256::from_slice(
            hex::decode(ADDRESS)
                .expect("Failed to decode public key")
                .as_slice(),
        );
        assert_eq!(chain_signer.address_h256(), address_h256);
    }

    #[test]
    fn address_h256_cosmosnative() {
        const PRIVATE_KEY: &str =
            "5486418967eabc770b0fcb995f7ef6d9a72f7fc195531ef76c5109f44f51af26";
        const ADDRESS: &str = "000000000000000000000000b5a79b48c87e7a37bdb625096140ee7054816942";

        let key = H256::from_slice(
            hex::decode(PRIVATE_KEY)
                .expect("Failed to decode public key")
                .as_slice(),
        );
        let chain_signer = hyperlane_cosmos_native::Signer::new(
            key.to_vec(),
            "neutron".to_string(),
            &AccountAddressType::Bitcoin,
        )
        .expect("Failed to create cosmos signer");

        let address_h256 = H256::from_slice(
            hex::decode(ADDRESS)
                .expect("Failed to decode public key")
                .as_slice(),
        );
        assert_eq!(chain_signer.address_h256(), address_h256);
    }
}
