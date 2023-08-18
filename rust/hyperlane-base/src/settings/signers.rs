use std::time::Duration;

use async_trait::async_trait;
use ed25519_dalek::SecretKey;
use ethers::prelude::{AwsSigner, LocalWallet};
use eyre::{bail, Context, Report};
use hyperlane_core::H256;
use hyperlane_sealevel::Keypair;
use rusoto_core::{HttpClient, HttpConfig, Region};
use rusoto_kms::KmsClient;
use tracing::instrument;

use ed25519_dalek::SecretKey;
use hyperlane_sealevel::Keypair;

use super::aws_credentials::AwsChainCredentialsProvider;

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
    },
    /// Assume node will sign on RPC calls
    #[default]
    Node,
}

/// Raw signer types
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RawSignerConf {
    #[serde(rename = "type")]
    signer_type: Option<String>,
    key: Option<String>,
    id: Option<String>,
    region: Option<String>,
    prefix: Option<String>,
}

impl FromRawConf<'_, RawSignerConf> for SignerConf {
    fn from_config_filtered(
        raw: RawSignerConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let key_path = || cwp + "key";
        let region_path = || cwp + "region";
        match raw.signer_type.as_deref() {
            Some("hexKey") => Ok(Self::HexKey {
                key: raw
                    .key
                    .ok_or_else(|| eyre!("Missing `key` for HexKey signer"))
                    .into_config_result(key_path)?
                    .parse()
                    .into_config_result(key_path)?,
            }),
            Some("aws") => Ok(Self::Aws {
                id: raw
                    .id
                    .ok_or_else(|| eyre!("Missing `id` for Aws signer"))
                    .into_config_result(|| cwp + "id")?,
                region: raw
                    .region
                    .ok_or_else(|| eyre!("Missing `region` for Aws signer"))
                    .into_config_result(region_path)?
                    .parse()
                    .into_config_result(region_path)?,
            }),
            Some("cosmosKey") => Ok(Self::CosmosKey {
                key: raw
                    .key
                    .ok_or_else(|| eyre!("Missing `key` for CosmosKey signer"))
                    .into_config_result(key_path)?
                    .parse()
                    .into_config_result(key_path)?,
                prefix: raw
                    .prefix
                    .ok_or_else(|| eyre!("Missing `prefix` for CosmosKey signer"))
                    .into_config_result(key_path)?,
            }),
            Some(t) => Err(eyre!("Unknown signer type `{t}`")).into_config_result(|| cwp + "type"),
            None if raw.key.is_some() => Ok(Self::HexKey {
                key: raw.key.unwrap().parse().into_config_result(key_path)?,
            }),
            None => Ok(Self::Node),
        }
    }
}

impl SignerConf {
    /// Try to convert the ethereum signer to a local wallet
    #[instrument(err)]
    pub async fn build<S: BuildableWithSignerConf>(&self) -> Result<S, Report> {
        S::build(self).await
    }
}

/// Builder trait for signers
#[async_trait]
pub trait BuildableWithSignerConf: Sized {
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
                let mut config = HttpConfig::new();
                // see https://github.com/hyperium/hyper/issues/2136#issuecomment-589345238
                config.pool_idle_timeout(Duration::from_secs(20));
                let client = KmsClient::new_with_client(
                    rusoto_core::Client::new_with(
                        AwsChainCredentialsProvider::new(),
                        HttpClient::new_with_config(config).unwrap(),
                    ),
                    region.clone(),
                );

                let signer = AwsSigner::new(client, id, 0).await?;
                hyperlane_ethereum::Signers::Aws(signer)
            }
            SignerConf::CosmosKey { key, .. } => {
                hyperlane_ethereum::Signers::Local(LocalWallet::from(
                    ethers::core::k256::ecdsa::SigningKey::from(
                        ethers::core::k256::SecretKey::from_be_bytes(key.as_bytes())
                            .context("Invalid ethereum signer key")?,
                    ),
                ))
            }
            SignerConf::Node => bail!("Node signer"),
        })
    }
}

#[async_trait]
impl BuildableWithSignerConf for fuels::prelude::WalletUnlocked {
    async fn build(conf: &SignerConf) -> Result<Self, Report> {
        Ok(match conf {
            SignerConf::HexKey { key } => {
                let key = fuels::signers::fuel_crypto::SecretKey::try_from(key.as_bytes())
                    .context("Invalid fuel signer key")?;
                fuels::prelude::WalletUnlocked::new_from_private_key(key, None)
            }
            SignerConf::Aws { .. } => bail!("Aws signer is not supported by fuel"),
            SignerConf::CosmosKey { .. } => bail!("Cosmos signer is not supported by fuel"),
            SignerConf::Node => bail!("Node signer is not supported by fuel"),
        })
    }
}

#[async_trait]
impl BuildableWithSignerConf for Keypair {
    async fn build(conf: &SignerConf) -> Result<Self, Report> {
        Ok(match conf {
            SignerConf::HexKey { key } => {
                let secret = SecretKey::from_bytes(key.as_bytes())
                    .context("Invalid sealevel ed25519 secret key")?;
                Keypair::from_bytes(&ed25519_dalek::Keypair::from(secret).to_bytes())
                    .context("Unable to create Keypair")?
            }
            SignerConf::Aws { .. } => bail!("Aws signer is not supported by fuel"),
            SignerConf::CosmosKey { .. } => bail!("Cosmos signer is not supported by fuel"),
            SignerConf::Node => bail!("Node signer is not supported by fuel"),
        })
    }
}

#[async_trait]
impl BuildableWithSignerConf for hyperlane_cosmos::Signer {
    async fn build(conf: &SignerConf) -> Result<Self, Report> {
        Ok(match conf {
            SignerConf::HexKey { .. } => bail!("HexKey signer is not supported by cosmos"),
            SignerConf::Aws { .. } => bail!("Aws signer is not supported by cosmos"),
            SignerConf::CosmosKey { key, prefix } => {
                hyperlane_cosmos::Signer::new(key.as_bytes().to_vec(), prefix.clone())
            }
            SignerConf::Node => bail!("Node signer is not supported by cosmos"),
        })
    }
}
