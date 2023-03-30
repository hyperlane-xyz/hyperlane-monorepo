use async_trait::async_trait;
use ethers::prelude::AwsSigner;
use eyre::{bail, Context, Report};
use rusoto_core::credential::EnvironmentProvider;
use rusoto_core::HttpClient;
use rusoto_kms::KmsClient;
use serde::Deserialize;
use tracing::instrument;

use hyperlane_core::utils::HexString;

use crate::settings::{declare_deserialize_for_config_struct, EyreOptionExt, KMS_CLIENT};

/// Signer types
#[derive(Default, Debug, Clone)]
pub enum SignerConf {
    /// A local hex key
    HexKey {
        /// Hex string of private key, without 0x prefix
        key: HexString<64>,
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

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum RawSignerConf {
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

declare_deserialize_for_config_struct!(SignerConf);

impl TryFrom<RawSignerConf> for SignerConf {
    type Error = Report;

    fn try_from(r: RawSignerConf) -> Result<Self, Self::Error> {
        use RawSignerConf::*;
        match r {
            HexKey { key } => Ok(Self::HexKey {
                key: HexString::from_string(
                    &key.expect_or_eyre("Missing `key` for HexKey signer")?,
                )
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
            SignerConf::HexKey { key } => hyperlane_ethereum::Signers::Local(key.as_ref().parse()?),
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
                let key = key.as_ref().parse()?;
                fuels::prelude::WalletUnlocked::new_from_private_key(key, None)
            }
            SignerConf::Aws { .. } => bail!("Aws signer is not supported by fuel"),
            SignerConf::Node => bail!("Node signer is not supported by fuel"),
        })
    }
}
