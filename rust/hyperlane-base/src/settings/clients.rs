use crate::settings::signers::BuildableWithSignerConf;
use crate::{ChainConnectionConf, CoreContractAddresses, SignerConf};
use eyre::{Context, Result};
use hyperlane_core::{ContractLocator, HyperlaneDomain, Mailbox, MessageIndexer, H256};
use hyperlane_ethereum::{self as h_eth, BuildableWithProvider};
use std::fmt::Debug;

/// A client setup is a domain ID, an address on that chain (where the mailbox is
/// deployed) and details for connecting to the chain API.
#[derive(Clone, Debug)]
pub struct ClientConf {
    /// The domain
    pub domain: HyperlaneDomain,
    /// Signer configuration for this chain
    pub signer: Option<SignerConf>,
    /// Addresses of contracts on the chain
    pub addresses: CoreContractAddresses,
    /// The chain connection details
    pub connection: ChainConnectionConf,
    /// Number of blocks until finality
    pub finality_blocks: u32,
}

impl ClientConf {
    /// Convert the chain settings into a Mailbox contract
    pub async fn build_mailbox(&self) -> Result<Box<dyn Mailbox>> {
        let ctx = "Building provider";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, h_eth::MailboxBuilder {})
                    .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
        }
        .context(ctx)
    }

    /// Convert the chain settings into a Message indexer
    pub async fn build_message_indexer(&self) -> Result<Box<dyn MessageIndexer>> {
        let ctx = "Building provider";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    h_eth::MessageIndexerBuilder {
                        finality_blocks: self.finality_blocks,
                    },
                )
                .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
        }
        .context(ctx)
    }

    fn locator(&self, address: H256) -> ContractLocator {
        ContractLocator {
            domain: &self.domain,
            address,
        }
    }

    async fn ethereum_signer(&self) -> Result<Option<h_eth::Signers>> {
        self.signer().await
    }

    async fn signer<S: BuildableWithSignerConf>(&self) -> Result<Option<S>> {
        if let Some(conf) = &self.signer {
            Ok(Some(conf.build::<S>().await?))
        } else {
            Ok(None)
        }
    }

    async fn build_ethereum<B>(
        &self,
        conf: &h_eth::ConnectionConf,
        locator: &ContractLocator<'_>,
        builder: B,
    ) -> Result<B::Output>
    where
        B: BuildableWithProvider + Sync,
    {
        let signer = self.ethereum_signer().await?;
        let res = builder
            .build_client_connection_conf(conf, locator, signer)
            .await;
        Ok(res?)
    }
}
