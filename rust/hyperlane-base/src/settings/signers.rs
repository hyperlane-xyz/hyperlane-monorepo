use async_trait::async_trait;
use ethers::prelude::{AwsSigner, LocalWallet};
use eyre::{bail, Context, Report};
use rusoto_core::credential::EnvironmentProvider;
use rusoto_core::HttpClient;
use rusoto_kms::KmsClient;
use serde::Deserialize;
use tracing::instrument;

use hyperlane_core::H256;

use crate::settings::{EyreOptionExt, KMS_CLIENT};

/// Signer types
#[derive(Default, Debug, Clone)]
pub enum SignerConf {
    /// A local hex key
    HexKey {
        /// Hex string of private key, without 0x prefix
        key: H256,
    },
    /// An AWS signer. Note that AWS credentials must be inserted into the env
    /// separately.
    Aws {
        /// The UUID identifying the AWS KMS Key
        id: String, // change to no _ so we can set by env
        /// The AWS region
        region: String,
    },
    /// Assume node will sign on RPC calls
    #[default]
    Node,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RawSignerConf {
    HexKey {
        key: Option<String>,
    },
    Aws {
        id: Option<String>,
        region: Option<String>,
    },
    #[serde(other)]
    Node,
}

impl TryFrom<RawSignerConf> for SignerConf {
    type Error = Report;

    fn try_from(r: RawSignerConf) -> Result<Self, Self::Error> {
        use RawSignerConf::*;
        match r {
            HexKey { key } => Ok(Self::HexKey {
                key: key
                    .expect_or_eyre("Missing `key` for HexKey signer")?
                    .parse()
                    .context("Invalid hex string for HexKey signer `key`")?,
            }),
            Aws { id, region } => Ok(Self::Aws {
                id: id.expect_or_eyre("Missing `id` for Aws signer")?,
                region: region.expect_or_eyre("Missing `region` for Aws signer")?,
            }),
            Node => Ok(Self::Node),
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
                let client = KMS_CLIENT.get_or_init(|| {
                    KmsClient::new_with_client(
                        rusoto_core::Client::new_with(
                            EnvironmentProvider::default(),
                            HttpClient::new().unwrap(),
                        ),
                        region.parse().expect("invalid region"),
                    )
                });

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
