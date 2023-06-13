use std::time::Duration;

use async_trait::async_trait;
use ethers::prelude::{AwsSigner, LocalWallet};
use eyre::{bail, eyre, Context, Report};
use rusoto_core::{HttpClient, HttpConfig, Region};
use rusoto_kms::KmsClient;
use serde::Deserialize;
use tracing::instrument;

use super::aws_credentials::AwsChainCredentialsProvider;
use hyperlane_core::{config::*, H256};

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
            SignerConf::Node => bail!("Node signer is not supported by fuel"),
        })
    }
}
