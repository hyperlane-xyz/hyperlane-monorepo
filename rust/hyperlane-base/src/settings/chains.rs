use std::collections::HashMap;

use ethers::prelude::Selector;
use ethers_prometheus::middleware::{
    ChainInfo, ContractInfo, PrometheusMiddlewareConf, WalletInfo,
};
use eyre::{eyre, Context, Result};
use hyperlane_core::{
    AggregationIsm, CcipReadIsm, ContractLocator, HyperlaneAbi, HyperlaneDomain,
    HyperlaneDomainProtocol, HyperlaneMessage, HyperlaneProvider, HyperlaneSigner, IndexMode,
    InterchainGasPaymaster, InterchainGasPayment, InterchainSecurityModule, Mailbox,
    MerkleTreeHook, MerkleTreeInsertion, MultisigIsm, RoutingIsm, SequenceIndexer,
    ValidatorAnnounce, H256,
};
use hyperlane_ethereum::{
    self as h_eth, BuildableWithProvider, EthereumInterchainGasPaymasterAbi, EthereumMailboxAbi,
    EthereumValidatorAnnounceAbi,
};
use hyperlane_fuel as h_fuel;
use hyperlane_sealevel as h_sealevel;

use crate::{
    settings::signers::{BuildableWithSignerConf, SignerConf},
    CoreMetrics,
};

/// A chain setup is a domain ID, an address on that chain (where the mailbox is
/// deployed) and details for connecting to the chain API.
#[derive(Clone, Debug)]
pub struct ChainConf {
    /// The domain
    pub domain: HyperlaneDomain,
    /// Signer configuration for this chain
    pub signer: Option<SignerConf>,
    /// Number of blocks until finality
    pub finality_blocks: u32,
    /// Addresses of contracts on the chain
    pub addresses: CoreContractAddresses,
    /// The chain connection details
    pub connection: ChainConnectionConf,
    /// Configure chain-specific metrics information. This will automatically
    /// add all contract addresses but will not override any set explicitly.
    /// Use `metrics_conf()` to get the metrics.
    pub metrics_conf: PrometheusMiddlewareConf,
    /// Settings for event indexing
    pub index: IndexSettings,
}

/// A connection to _some_ blockchain.
#[derive(Clone, Debug)]
pub enum ChainConnectionConf {
    /// Ethereum configuration
    Ethereum(h_eth::ConnectionConf),
    /// Fuel configuration
    Fuel(h_fuel::ConnectionConf),
    /// Sealevel configuration.
    Sealevel(h_sealevel::ConnectionConf),
}

impl ChainConnectionConf {
    /// Get what hyperlane protocol is in use for this chain.
    pub fn protocol(&self) -> HyperlaneDomainProtocol {
        match self {
            Self::Ethereum(_) => HyperlaneDomainProtocol::Ethereum,
            Self::Fuel(_) => HyperlaneDomainProtocol::Fuel,
            Self::Sealevel(_) => HyperlaneDomainProtocol::Sealevel,
        }
    }
}

/// Addresses for mailbox chain contracts
#[derive(Clone, Debug, Default)]
pub struct CoreContractAddresses {
    /// Address of the mailbox contract
    pub mailbox: H256,
    /// Address of the InterchainGasPaymaster contract
    pub interchain_gas_paymaster: H256,
    /// Address of the ValidatorAnnounce contract
    pub validator_announce: H256,
    /// Address of the MerkleTreeHook contract
    pub merkle_tree_hook: Option<H256>,
}

/// Indexing settings
#[derive(Debug, Default, Clone)]
pub struct IndexSettings {
    /// The height at which to start indexing contracts.
    pub from: u32,
    /// The number of blocks to query at once when indexing contracts.
    pub chunk_size: u32,
    /// The indexing mode.
    pub mode: IndexMode,
}

impl ChainConf {
    /// Fetch the index settings and index mode, since they are often used together.
    pub fn index_settings(&self) -> IndexSettings {
        self.index.clone()
    }

    /// Try to convert the chain settings into an HyperlaneProvider.
    pub async fn build_provider(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn HyperlaneProvider>> {
        let ctx = "Building provider";
        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                let locator = self.locator(H256::zero());
                self.build_ethereum(conf, &locator, metrics, h_eth::HyperlaneProviderBuilder {})
                    .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => todo!(),
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a Mailbox contract
    pub async fn build_mailbox(&self, metrics: &CoreMetrics) -> Result<Box<dyn Mailbox>> {
        let ctx = "Building mailbox";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::MailboxBuilder {})
                    .await
            }
            ChainConnectionConf::Fuel(conf) => {
                let wallet = self.fuel_signer().await.context(ctx)?;
                hyperlane_fuel::FuelMailbox::new(conf, locator, wallet)
                    .map(|m| Box::new(m) as Box<dyn Mailbox>)
                    .map_err(Into::into)
            }
            ChainConnectionConf::Sealevel(conf) => {
                let keypair = self.sealevel_signer().await.context(ctx)?;
                h_sealevel::SealevelMailbox::new(conf, locator, keypair)
                    .map(|m| Box::new(m) as Box<dyn Mailbox>)
                    .map_err(Into::into)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a Merkle Tree Hook contract
    pub async fn build_merkle_tree_hook(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn MerkleTreeHook>> {
        let ctx = "Building merkle tree hook";
        // TODO: if the merkle tree hook is set for sealevel, it's still a mailbox program
        // that the connection is made to using the pda seeds, which will not be usable.
        let address = self
            .addresses
            .merkle_tree_hook
            .unwrap_or(self.addresses.mailbox);
        let locator = self.locator(address);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::MerkleTreeHookBuilder {})
                    .await
            }
            ChainConnectionConf::Fuel(_conf) => {
                todo!("Fuel does not support merkle tree hooks yet")
            }
            ChainConnectionConf::Sealevel(conf) => {
                h_sealevel::SealevelMailbox::new(conf, locator, None)
                    .map(|m| Box::new(m) as Box<dyn MerkleTreeHook>)
                    .map_err(Into::into)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a message indexer
    pub async fn build_message_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn SequenceIndexer<HyperlaneMessage>>> {
        let ctx = "Building delivery indexer";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::SequenceIndexerBuilder {
                        finality_blocks: self.finality_blocks,
                    },
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let indexer = Box::new(h_sealevel::SealevelMailboxIndexer::new(conf, locator)?);
                Ok(indexer as Box<dyn SequenceIndexer<HyperlaneMessage>>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a delivery indexer
    pub async fn build_delivery_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn SequenceIndexer<H256>>> {
        let ctx = "Building delivery indexer";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::DeliveryIndexerBuilder {
                        finality_blocks: self.finality_blocks,
                    },
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let indexer = Box::new(h_sealevel::SealevelMailboxIndexer::new(conf, locator)?);
                Ok(indexer as Box<dyn SequenceIndexer<H256>>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into an interchain gas paymaster
    /// contract
    pub async fn build_interchain_gas_paymaster(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn InterchainGasPaymaster>> {
        let ctx = "Building IGP";
        let locator = self.locator(self.addresses.interchain_gas_paymaster);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::InterchainGasPaymasterBuilder {},
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let paymaster = Box::new(
                    h_sealevel::SealevelInterchainGasPaymaster::new(conf, &locator).await?,
                );
                Ok(paymaster as Box<dyn InterchainGasPaymaster>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a gas payment indexer
    pub async fn build_interchain_gas_payment_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn SequenceIndexer<InterchainGasPayment>>> {
        let ctx = "Building IGP indexer";
        let locator = self.locator(self.addresses.interchain_gas_paymaster);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::InterchainGasPaymasterIndexerBuilder {
                        mailbox_address: self.addresses.mailbox.into(),
                        finality_blocks: self.finality_blocks,
                    },
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let indexer = Box::new(
                    h_sealevel::SealevelInterchainGasPaymasterIndexer::new(conf, locator).await?,
                );
                Ok(indexer as Box<dyn SequenceIndexer<InterchainGasPayment>>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a merkle tree hook indexer
    pub async fn build_merkle_tree_hook_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn SequenceIndexer<MerkleTreeInsertion>>> {
        let ctx = "Building merkle tree hook indexer";
        let address = self
            .addresses
            .merkle_tree_hook
            .unwrap_or(self.addresses.mailbox);
        let locator = self.locator(address);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::MerkleTreeHookIndexerBuilder {
                        finality_blocks: self.finality_blocks,
                    },
                )
                .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => {
                let indexer = Box::new(h_sealevel::SealevelMerkleTreeHookIndexer::new());
                Ok(indexer as Box<dyn SequenceIndexer<MerkleTreeInsertion>>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a ValidatorAnnounce
    pub async fn build_validator_announce(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn ValidatorAnnounce>> {
        let locator = self.locator(self.addresses.validator_announce);
        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::ValidatorAnnounceBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let va = Box::new(h_sealevel::SealevelValidatorAnnounce::new(conf, locator));
                Ok(va as Box<dyn ValidatorAnnounce>)
            }
        }
        .context("Building ValidatorAnnounce")
    }

    /// Try to convert the chain setting into an InterchainSecurityModule
    /// contract
    pub async fn build_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn InterchainSecurityModule>> {
        let ctx = "Building ISM";
        let locator = self.locator(address);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::InterchainSecurityModuleBuilder {},
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let keypair = self.sealevel_signer().await.context(ctx)?;
                let ism = Box::new(h_sealevel::SealevelInterchainSecurityModule::new(
                    conf, locator, keypair,
                ));
                Ok(ism as Box<dyn InterchainSecurityModule>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a Multisig Ism contract
    pub async fn build_multisig_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn MultisigIsm>> {
        let ctx = "Building multisig ISM";
        let locator = self.locator(address);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::MultisigIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let keypair = self.sealevel_signer().await.context(ctx)?;
                let ism = Box::new(h_sealevel::SealevelMultisigIsm::new(conf, locator, keypair));
                Ok(ism as Box<dyn MultisigIsm>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a RoutingIsm Ism contract
    pub async fn build_routing_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn RoutingIsm>> {
        let ctx = "Building routing ISM";
        let locator = ContractLocator {
            domain: &self.domain,
            address,
        };

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::RoutingIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => {
                Err(eyre!("Sealevel does not support routing ISM yet")).context(ctx)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into an AggregationIsm Ism contract
    pub async fn build_aggregation_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn AggregationIsm>> {
        let ctx = "Building aggregation ISM";
        let locator = ContractLocator {
            domain: &self.domain,
            address,
        };

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::AggregationIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => {
                Err(eyre!("Sealevel does not support aggregation ISM yet")).context(ctx)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a CcipRead Ism contract
    pub async fn build_ccip_read_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn CcipReadIsm>> {
        let ctx = "Building CcipRead ISM";
        let locator = ContractLocator {
            domain: &self.domain,
            address,
        };

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::CcipReadIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => {
                Err(eyre!("Sealevel does not support CCIP read ISM yet")).context(ctx)
            }
        }
        .context(ctx)
    }

    async fn signer<S: BuildableWithSignerConf>(&self) -> Result<Option<S>> {
        if let Some(conf) = &self.signer {
            Ok(Some(conf.build::<S>().await?))
        } else {
            Ok(None)
        }
    }

    async fn ethereum_signer(&self) -> Result<Option<h_eth::Signers>> {
        self.signer().await
    }

    async fn fuel_signer(&self) -> Result<fuels::prelude::WalletUnlocked> {
        self.signer().await.and_then(|opt| {
            opt.ok_or_else(|| eyre!("Fuel requires a signer to construct contract instances"))
        })
    }

    async fn sealevel_signer(&self) -> Result<Option<h_sealevel::Keypair>> {
        self.signer().await
    }

    /// Get a clone of the ethereum metrics conf with correctly configured
    /// contract information.
    fn metrics_conf(
        &self,
        agent_name: &str,
        signer: &Option<impl HyperlaneSigner>,
    ) -> PrometheusMiddlewareConf {
        let mut cfg = self.metrics_conf.clone();

        if cfg.chain.is_none() {
            cfg.chain = Some(ChainInfo {
                name: Some(self.domain.name().into()),
            });
        }

        if let Some(signer) = signer {
            cfg.wallets
                .entry(signer.eth_address().into())
                .or_insert_with(|| WalletInfo {
                    name: Some(agent_name.into()),
                });
        }

        let mut register_contract = |name: &str, address: H256, fns: HashMap<Vec<u8>, String>| {
            cfg.contracts
                .entry(address.into())
                .or_insert_with(|| ContractInfo {
                    name: Some(name.into()),
                    functions: fns
                        .into_iter()
                        .map(|s| (Selector::try_from(s.0).unwrap(), s.1))
                        .collect(),
                });
        };

        register_contract(
            "mailbox",
            self.addresses.mailbox,
            EthereumMailboxAbi::fn_map_owned(),
        );
        register_contract(
            "validator_announce",
            self.addresses.validator_announce,
            EthereumValidatorAnnounceAbi::fn_map_owned(),
        );
        register_contract(
            "igp",
            self.addresses.interchain_gas_paymaster,
            EthereumInterchainGasPaymasterAbi::fn_map_owned(),
        );
        if let Some(address) = self.addresses.merkle_tree_hook {
            register_contract(
                "merkle_tree_hook",
                address,
                EthereumInterchainGasPaymasterAbi::fn_map_owned(),
            );
        }

        cfg
    }

    fn locator(&self, address: H256) -> ContractLocator {
        ContractLocator {
            domain: &self.domain,
            address,
        }
    }

    async fn build_ethereum<B>(
        &self,
        conf: &h_eth::ConnectionConf,
        locator: &ContractLocator<'_>,
        metrics: &CoreMetrics,
        builder: B,
    ) -> Result<B::Output>
    where
        B: BuildableWithProvider + Sync,
    {
        let signer = self.ethereum_signer().await?;
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let rpc_metrics = Some(metrics.json_rpc_client_metrics());
        let middleware_metrics = Some((metrics.provider_metrics(), metrics_conf));
        let res = builder
            .build_with_connection_conf(conf, locator, signer, rpc_metrics, middleware_metrics)
            .await;
        Ok(res?)
    }
}
