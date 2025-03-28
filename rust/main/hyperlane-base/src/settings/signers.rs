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
                    ethers::core::k256::SecretKey::from_be_bytes(key.as_bytes())
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
            SignerConf::Node => bail!("Node signer"),
        })
    }
}

impl ChainSigner for hyperlane_ethereum::Signers {
    fn address_string(&self) -> String {
        ethers::signers::Signer::address(self).encode_hex()
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
        self.address.clone()
    }
}
