use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::async_trait;
use ethers::prelude::Selector;
use eyre::{eyre, Context, Report, Result};
use serde_json::Value;

use ethers_prometheus::middleware::{ContractInfo, PrometheusMiddlewareConf};
use hyperlane_core::{
    config::OpSubmissionConfig, AggregationIsm, CcipReadIsm, ChainResult, ContractLocator,
    HyperlaneAbi, HyperlaneDomain, HyperlaneDomainProtocol, HyperlaneMessage, HyperlaneProvider,
    IndexMode, InterchainGasPaymaster, InterchainGasPayment, InterchainSecurityModule, Mailbox,
    MerkleTreeHook, MerkleTreeInsertion, MultisigIsm, ReorgPeriod, RoutingIsm,
    SequenceAwareIndexer, SubmitterType, ValidatorAnnounce, H256,
};
use hyperlane_metric::prometheus_metric::ChainInfo;
use hyperlane_operation_verifier::ApplicationOperationVerifier;

use hyperlane_cosmos::{
    self as h_cosmos, delivery_indexer, dispatch_indexer, rpc::CosmosWasmRpcProvider,
    CosmosProvider, Signer,
};
use hyperlane_cosmos_native::{self as h_cosmos_native, CosmosNativeProvider};
use hyperlane_ethereum::{
    self as h_eth, BuildableWithProvider, EthereumInterchainGasPaymasterAbi, EthereumMailboxAbi,
    EthereumReorgPeriod, EthereumValidatorAnnounceAbi,
};
use hyperlane_fuel as h_fuel;
use hyperlane_sealevel::{
    self as h_sealevel, fallback::SealevelFallbackRpcClient, SealevelProvider, TransactionSubmitter,
};

use crate::{
    metrics::AgentMetricsConf,
    settings::signers::{BuildableWithSignerConf, SignerConf},
    CoreMetrics,
};

use super::ChainSigner;

/// A trait for converting to a type from a chain configuration with metrics
#[async_trait]
pub trait TryFromWithMetrics<T>: Sized {
    /// Try to convert the chain configuration into the type
    async fn try_from_with_metrics(
        conf: &ChainConf,
        metrics: &CoreMetrics,
        advanced_log_meta: bool,
    ) -> Result<Self>;
}

/// Contains JSON value which can contain chain-specific configuration which is parsed by
/// AdaptsChain trait implementation.
#[allow(dead_code)]
#[derive(Clone, Debug, Default)]
pub struct RawChainConf(Value);

impl From<Value> for RawChainConf {
    fn from(value: Value) -> Self {
        Self(value)
    }
}

/// A chain setup is a domain ID, an address on that chain (where the mailbox is
/// deployed) and details for connecting to the chain API.
#[derive(Clone, Debug)]
pub struct ChainConf {
    /// The domain
    pub domain: HyperlaneDomain,
    /// Signer configuration for this chain
    pub signer: Option<SignerConf>,
    /// Submitter type for this chain
    pub submitter: SubmitterType,
    /// The estimated block time, i.e. the average time the next block is added to the chain
    pub estimated_block_time: Duration,
    /// The reorg period of the chain, i.e. the number of blocks until finality
    pub reorg_period: ReorgPeriod,
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

/// A sequence-aware indexer for messages
pub type MessageIndexer = Arc<dyn SequenceAwareIndexer<HyperlaneMessage>>;

/// A sequence-aware indexer for deliveries
pub type DeliveryIndexer = Arc<dyn SequenceAwareIndexer<H256>>;

/// A sequence-aware indexer for interchain gas payments
pub type IgpIndexer = Arc<dyn SequenceAwareIndexer<InterchainGasPayment>>;

/// A sequence-aware indexer for merkle tree hooks
pub type MerkleTreeHookIndexer = Arc<dyn SequenceAwareIndexer<MerkleTreeInsertion>>;

#[async_trait]
impl TryFromWithMetrics<ChainConf> for MessageIndexer {
    async fn try_from_with_metrics(
        conf: &ChainConf,
        metrics: &CoreMetrics,
        advanced_log_meta: bool,
    ) -> Result<Self> {
        conf.build_message_indexer(metrics, advanced_log_meta)
            .await
            .map(Into::into)
    }
}

#[async_trait]
impl TryFromWithMetrics<ChainConf> for DeliveryIndexer {
    async fn try_from_with_metrics(
        conf: &ChainConf,
        metrics: &CoreMetrics,
        advanced_log_meta: bool,
    ) -> Result<Self> {
        conf.build_delivery_indexer(metrics, advanced_log_meta)
            .await
            .map(Into::into)
    }
}

#[async_trait]
impl TryFromWithMetrics<ChainConf> for IgpIndexer {
    async fn try_from_with_metrics(
        conf: &ChainConf,
        metrics: &CoreMetrics,
        advanced_log_meta: bool,
    ) -> Result<Self> {
        conf.build_interchain_gas_payment_indexer(metrics, advanced_log_meta)
            .await
            .map(Into::into)
    }
}

#[async_trait]
impl TryFromWithMetrics<ChainConf> for MerkleTreeHookIndexer {
    async fn try_from_with_metrics(
        conf: &ChainConf,
        metrics: &CoreMetrics,
        advanced_log_meta: bool,
    ) -> Result<Self> {
        conf.build_merkle_tree_hook_indexer(metrics, advanced_log_meta)
            .await
            .map(Into::into)
    }
}

/// A connection to _some_ blockchain.
#[derive(Clone, Debug)]
// TODO: re-enable this clippy check once the new submitter is shipped,
// since it might take in configs in a different way
#[allow(clippy::large_enum_variant)]
pub enum ChainConnectionConf {
    /// Ethereum configuration
    Ethereum(h_eth::ConnectionConf),
    /// Fuel configuration
    Fuel(h_fuel::ConnectionConf),
    /// Sealevel configuration.
    Sealevel(h_sealevel::ConnectionConf),
    /// Cosmos configuration.
    Cosmos(h_cosmos::ConnectionConf),
    /// Cosmos native configuration
    CosmosNative(h_cosmos_native::ConnectionConf),
}

impl ChainConnectionConf {
    /// Get what hyperlane protocol is in use for this chain.
    pub fn protocol(&self) -> HyperlaneDomainProtocol {
        match self {
            Self::Ethereum(_) => HyperlaneDomainProtocol::Ethereum,
            Self::Fuel(_) => HyperlaneDomainProtocol::Fuel,
            Self::Sealevel(_) => HyperlaneDomainProtocol::Sealevel,
            Self::Cosmos(_) => HyperlaneDomainProtocol::Cosmos,
            Self::CosmosNative(_) => HyperlaneDomainProtocol::CosmosNative,
        }
    }

    /// Get the message batch configuration for this chain.
    pub fn operation_submission_config(&self) -> Option<&OpSubmissionConfig> {
        match self {
            Self::Ethereum(conf) => Some(&conf.op_submission_config),
            Self::Cosmos(conf) => Some(&conf.op_submission_config),
            Self::Sealevel(conf) => Some(&conf.op_submission_config),
            _ => None,
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
    pub merkle_tree_hook: H256,
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

    /// Try to convert the chain settings into an ApplicationOperationVerifier.
    pub async fn build_application_operation_verifier(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn ApplicationOperationVerifier>> {
        let ctx = "Building application operation verifier";
        let locator = self.locator(H256::zero());
        let result: Result<Box<dyn ApplicationOperationVerifier>, Report> = match &self.connection {
            ChainConnectionConf::Ethereum(_conf) => Ok(Box::new(
                h_eth::application::EthereumApplicationOperationVerifier::new(),
            )
                as Box<dyn ApplicationOperationVerifier>),
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let verifier =
                    h_sealevel::application::SealevelApplicationOperationVerifier::new(provider);
                Ok(Box::new(verifier) as Box<dyn ApplicationOperationVerifier>)
            }
            ChainConnectionConf::Cosmos(_conf) => Ok(Box::new(
                h_cosmos::application::CosmosApplicationOperationVerifier::new(),
            )
                as Box<dyn ApplicationOperationVerifier>),
            // applicatino verification is the same for cosmos native and cw
            ChainConnectionConf::CosmosNative(_) => Ok(Box::new(
                h_cosmos::application::CosmosApplicationOperationVerifier::new(),
            )
                as Box<dyn ApplicationOperationVerifier>),
        };

        result.context(ctx)
    }

    /// Try to convert the chain settings into an HyperlaneProvider.
    pub async fn build_provider(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn HyperlaneProvider>> {
        let ctx = "Building provider";
        let locator = self.locator(H256::zero());
        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::HyperlaneProviderBuilder {})
                    .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let provider = build_sealevel_provider(
                    self,
                    &locator,
                    &[
                        self.addresses.mailbox,
                        self.addresses.interchain_gas_paymaster,
                    ],
                    conf,
                    metrics,
                );
                Ok(Box::new(provider) as Box<dyn HyperlaneProvider>)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let provider = build_cosmos_provider(self, conf, metrics, &locator, None)?;
                Ok(Box::new(provider) as Box<dyn HyperlaneProvider>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                Ok(Box::new(provider) as Box<dyn HyperlaneProvider>)
            }
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
                    .await
                    .map(|m| Box::new(m) as Box<dyn Mailbox>)
                    .map_err(Into::into)
            }
            ChainConnectionConf::Sealevel(conf) => {
                let keypair = self.sealevel_signer().await.context(ctx)?;

                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let tx_submitter =
                    build_sealevel_tx_submitter(&provider, self, conf, &locator, metrics);

                h_sealevel::SealevelMailbox::new(
                    provider,
                    tx_submitter,
                    conf,
                    &locator,
                    keypair.map(h_sealevel::SealevelKeypair::new),
                )
                .map(|m| Box::new(m) as Box<dyn Mailbox>)
                .map_err(Into::into)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let provider = build_cosmos_provider(self, conf, metrics, &locator, signer)?;

                h_cosmos::CosmosMailbox::new(provider, conf.clone(), locator.clone())
                    .map(|m| Box::new(m) as Box<dyn Mailbox>)
                    .map_err(Into::into)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let signer = self.cosmos_native_signer().await.context(ctx)?;
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, signer)?;
                h_cosmos_native::CosmosNativeMailbox::new(provider, locator.clone())
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
        let locator = self.locator(self.addresses.merkle_tree_hook);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::MerkleTreeHookBuilder {})
                    .await
            }
            ChainConnectionConf::Fuel(_conf) => {
                todo!("Fuel does not support merkle tree hooks yet")
            }
            ChainConnectionConf::Sealevel(conf) => {
                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let tx_submitter =
                    build_sealevel_tx_submitter(&provider, self, conf, &locator, metrics);

                h_sealevel::SealevelMailbox::new(provider, tx_submitter, conf, &locator, None)
                    .map(|m| Box::new(m) as Box<dyn MerkleTreeHook>)
                    .map_err(Into::into)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let provider = build_cosmos_provider(self, conf, metrics, &locator, signer)?;
                let hook = h_cosmos::CosmosMerkleTreeHook::new(provider, locator.clone())?;

                Ok(Box::new(hook) as Box<dyn MerkleTreeHook>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                let hook =
                    h_cosmos_native::CosmosNativeMerkleTreeHook::new(provider, locator.clone())?;

                Ok(Box::new(hook) as Box<dyn MerkleTreeHook>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a message indexer
    pub async fn build_message_indexer(
        &self,
        metrics: &CoreMetrics,
        advanced_log_meta: bool,
    ) -> Result<Box<dyn SequenceAwareIndexer<HyperlaneMessage>>> {
        let ctx = "Building delivery indexer";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                let reorg_period =
                    EthereumReorgPeriod::try_from(&self.reorg_period).context(ctx)?;
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::SequenceIndexerBuilder { reorg_period },
                )
                .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let tx_submitter =
                    build_sealevel_tx_submitter(&provider, self, conf, &locator, metrics);

                let indexer = Box::new(h_sealevel::SealevelMailboxIndexer::new(
                    provider,
                    tx_submitter,
                    &locator,
                    conf,
                    advanced_log_meta,
                )?);
                Ok(indexer as Box<dyn SequenceAwareIndexer<HyperlaneMessage>>)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let reorg_period = self.reorg_period.as_blocks().context(ctx)?;

                let provider =
                    build_cosmos_provider(self, conf, metrics, &locator, signer.clone())?;
                let wasm_provider = build_cosmos_wasm_provider(
                    self,
                    conf,
                    &locator,
                    metrics,
                    reorg_period,
                    dispatch_indexer::MESSAGE_DISPATCH_EVENT_TYPE.into(),
                )?;

                let mailbox =
                    h_cosmos::CosmosMailbox::new(provider, conf.clone(), locator.clone())?;
                let indexer = Box::new(
                    h_cosmos::dispatch_indexer::CosmosMailboxDispatchIndexer::new(
                        wasm_provider,
                        mailbox,
                    )?,
                );
                Ok(indexer as Box<dyn SequenceAwareIndexer<HyperlaneMessage>>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                let indexer = Box::new(h_cosmos_native::CosmosNativeDispatchIndexer::new(
                    provider, locator,
                )?);
                Ok(indexer as Box<dyn SequenceAwareIndexer<HyperlaneMessage>>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a delivery indexer
    pub async fn build_delivery_indexer(
        &self,
        metrics: &CoreMetrics,
        advanced_log_meta: bool,
    ) -> Result<Box<dyn SequenceAwareIndexer<H256>>> {
        let ctx = "Building delivery indexer";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                let reorg_period =
                    EthereumReorgPeriod::try_from(&self.reorg_period).context(ctx)?;
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::DeliveryIndexerBuilder { reorg_period },
                )
                .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let tx_submitter =
                    build_sealevel_tx_submitter(&provider, self, conf, &locator, metrics);
                let indexer = Box::new(h_sealevel::SealevelMailboxIndexer::new(
                    provider,
                    tx_submitter,
                    &locator,
                    conf,
                    advanced_log_meta,
                )?);
                Ok(indexer as Box<dyn SequenceAwareIndexer<H256>>)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let reorg_period = self.reorg_period.as_blocks().context(ctx)?;
                let wasm_provider = build_cosmos_wasm_provider(
                    self,
                    conf,
                    &locator,
                    metrics,
                    reorg_period,
                    delivery_indexer::MESSAGE_DELIVERY_EVENT_TYPE.into(),
                )?;

                let indexer = Box::new(
                    h_cosmos::delivery_indexer::CosmosMailboxDeliveryIndexer::new(wasm_provider)?,
                );
                Ok(indexer as Box<dyn SequenceAwareIndexer<H256>>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                let indexer = Box::new(h_cosmos_native::CosmosNativeDeliveryIndexer::new(
                    provider, locator,
                )?);
                Ok(indexer as Box<dyn SequenceAwareIndexer<H256>>)
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
                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let paymaster = Box::new(
                    h_sealevel::SealevelInterchainGasPaymaster::new(provider, &locator).await?,
                );
                Ok(paymaster as Box<dyn InterchainGasPaymaster>)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let provider = build_cosmos_provider(self, conf, metrics, &locator, signer)?;

                let paymaster = Box::new(h_cosmos::CosmosInterchainGasPaymaster::new(
                    provider,
                    locator.clone(),
                )?);
                Ok(paymaster as Box<dyn InterchainGasPaymaster>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                let indexer = Box::new(h_cosmos_native::CosmosNativeInterchainGas::new(
                    provider, conf, locator,
                )?);
                Ok(indexer as Box<dyn InterchainGasPaymaster>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a gas payment indexer
    pub async fn build_interchain_gas_payment_indexer(
        &self,
        metrics: &CoreMetrics,
        advanced_log_meta: bool,
    ) -> Result<Box<dyn SequenceAwareIndexer<InterchainGasPayment>>> {
        let ctx = "Building IGP indexer";
        let locator = self.locator(self.addresses.interchain_gas_paymaster);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                let reorg_period =
                    EthereumReorgPeriod::try_from(&self.reorg_period).context(ctx)?;
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::InterchainGasPaymasterIndexerBuilder {
                        mailbox_address: self.addresses.mailbox.into(),
                        reorg_period,
                    },
                )
                .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let provider = Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let indexer = Box::new(
                    h_sealevel::SealevelInterchainGasPaymasterIndexer::new(
                        provider,
                        locator,
                        advanced_log_meta,
                    )
                    .await?,
                );
                Ok(indexer as Box<dyn SequenceAwareIndexer<InterchainGasPayment>>)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let reorg_period = self.reorg_period.as_blocks().context(ctx)?;
                let wasm_provider = build_cosmos_wasm_provider(
                    self,
                    conf,
                    &locator,
                    metrics,
                    reorg_period,
                    h_cosmos::CosmosInterchainGasPaymasterIndexer::INTERCHAIN_GAS_PAYMENT_EVENT_TYPE.into(),
                )?;

                let indexer = Box::new(h_cosmos::CosmosInterchainGasPaymasterIndexer::new(
                    wasm_provider,
                )?);
                Ok(indexer as Box<dyn SequenceAwareIndexer<InterchainGasPayment>>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                let indexer = Box::new(h_cosmos_native::CosmosNativeInterchainGas::new(
                    provider,
                    conf,
                    locator,
                )?);
                Ok(indexer as Box<dyn SequenceAwareIndexer<InterchainGasPayment>>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a merkle tree hook indexer
    pub async fn build_merkle_tree_hook_indexer(
        &self,
        metrics: &CoreMetrics,
        advanced_log_meta: bool,
    ) -> Result<Box<dyn SequenceAwareIndexer<MerkleTreeInsertion>>> {
        let ctx = "Building merkle tree hook indexer";
        let locator = self.locator(self.addresses.merkle_tree_hook);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                let reorg_period =
                    EthereumReorgPeriod::try_from(&self.reorg_period).context(ctx)?;
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::MerkleTreeHookIndexerBuilder { reorg_period },
                )
                .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let tx_submitter =
                    build_sealevel_tx_submitter(&provider, self, conf, &locator, metrics);

                let mailbox_indexer = Box::new(h_sealevel::SealevelMailboxIndexer::new(
                    provider,
                    tx_submitter,
                    &locator,
                    conf,
                    advanced_log_meta,
                )?);
                let indexer = Box::new(h_sealevel::SealevelMerkleTreeHookIndexer::new(
                    *mailbox_indexer,
                ));
                Ok(indexer as Box<dyn SequenceAwareIndexer<MerkleTreeInsertion>>)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let reorg_period = self.reorg_period.as_blocks().context(ctx)?;

                let provider = build_cosmos_provider(self, conf, metrics, &locator, signer)?;
                let wasm_provider = build_cosmos_wasm_provider(
                    self,
                    conf,
                    &locator,
                    metrics,
                    reorg_period,
                    h_cosmos::CosmosMerkleTreeHookIndexer::MERKLE_TREE_INSERTION_EVENT_TYPE.into(),
                )?;

                let indexer = Box::new(h_cosmos::CosmosMerkleTreeHookIndexer::new(
                    provider,
                    wasm_provider,
                    locator,
                )?);
                Ok(indexer as Box<dyn SequenceAwareIndexer<MerkleTreeInsertion>>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                let indexer = Box::new(h_cosmos_native::CosmosNativeMerkleTreeHook::new(
                    provider, locator,
                )?);
                Ok(indexer as Box<dyn SequenceAwareIndexer<MerkleTreeInsertion>>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a ValidatorAnnounce
    pub async fn build_validator_announce(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn ValidatorAnnounce>> {
        let ctx = "Building validator announce";
        let locator = self.locator(self.addresses.validator_announce);
        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::ValidatorAnnounceBuilder {})
                    .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let va = Box::new(h_sealevel::SealevelValidatorAnnounce::new(
                    provider, &locator,
                ));
                Ok(va as Box<dyn ValidatorAnnounce>)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let provider = build_cosmos_provider(self, conf, metrics, &locator, signer)?;

                let va = Box::new(h_cosmos::CosmosValidatorAnnounce::new(
                    provider,
                    locator.clone(),
                )?);

                Ok(va as Box<dyn ValidatorAnnounce>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let signer = self.cosmos_native_signer().await.context(ctx)?;
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, signer)?;
                let va = Box::new(h_cosmos_native::CosmosNativeValidatorAnnounce::new(
                    provider,
                    locator.clone(),
                )?);

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
                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let ism = Box::new(h_sealevel::SealevelInterchainSecurityModule::new(
                    provider,
                    locator,
                    keypair.map(h_sealevel::SealevelKeypair::new),
                ));
                Ok(ism as Box<dyn InterchainSecurityModule>)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let provider = build_cosmos_provider(self, conf, metrics, &locator, signer)?;

                let ism = Box::new(h_cosmos::CosmosInterchainSecurityModule::new(
                    provider, locator,
                )?);
                Ok(ism as Box<dyn InterchainSecurityModule>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                let ism = Box::new(h_cosmos_native::CosmosNativeIsm::new(provider, locator)?);
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
                let provider =
                    Arc::new(build_sealevel_provider(self, &locator, &[], conf, metrics));
                let ism = Box::new(h_sealevel::SealevelMultisigIsm::new(
                    provider,
                    locator,
                    keypair.map(h_sealevel::SealevelKeypair::new),
                ));
                Ok(ism as Box<dyn MultisigIsm>)
            }
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let provider = build_cosmos_provider(self, conf, metrics, &locator, signer)?;

                let ism = Box::new(h_cosmos::CosmosMultisigIsm::new(provider, locator.clone())?);
                Ok(ism as Box<dyn MultisigIsm>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                let ism: Box<hyperlane_cosmos_native::CosmosNativeIsm> =
                    Box::new(h_cosmos_native::CosmosNativeIsm::new(provider, locator)?);
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
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let provider = build_cosmos_provider(self, conf, metrics, &locator, signer)?;

                let ism = Box::new(h_cosmos::CosmosRoutingIsm::new(provider, locator.clone())?);
                Ok(ism as Box<dyn RoutingIsm>)
            }
            ChainConnectionConf::CosmosNative(conf) => {
                let provider = build_cosmos_native_provider(self, conf, metrics, &locator, None)?;
                let ism: Box<hyperlane_cosmos_native::CosmosNativeIsm> =
                    Box::new(h_cosmos_native::CosmosNativeIsm::new(provider, locator)?);
                Ok(ism as Box<dyn RoutingIsm>)
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
            ChainConnectionConf::Cosmos(conf) => {
                let signer = self.cosmos_signer().await.context(ctx)?;
                let provider = build_cosmos_provider(self, conf, metrics, &locator, signer)?;
                let ism = Box::new(h_cosmos::CosmosAggregationIsm::new(
                    provider,
                    locator.clone(),
                )?);

                Ok(ism as Box<dyn AggregationIsm>)
            }
            ChainConnectionConf::CosmosNative(_) => {
                Err(eyre!("Cosmos Native does not support aggregation ISM yet")).context(ctx)
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
            ChainConnectionConf::Cosmos(_) => {
                Err(eyre!("Cosmos does not support CCIP read ISM yet")).context(ctx)
            }
            ChainConnectionConf::CosmosNative(_) => {
                Err(eyre!("Cosmos Native does not support CCIP read ISM yet")).context(ctx)
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

    /// Returns a ChainSigner for the flavor of chain this is, if one is configured.
    pub async fn chain_signer(&self) -> Result<Option<Box<dyn ChainSigner>>> {
        if let Some(conf) = &self.signer {
            let chain_signer: Box<dyn ChainSigner> = match &self.connection {
                ChainConnectionConf::Ethereum(_) => Box::new(conf.build::<h_eth::Signers>().await?),
                ChainConnectionConf::Fuel(_) => {
                    Box::new(conf.build::<fuels::prelude::WalletUnlocked>().await?)
                }
                ChainConnectionConf::Sealevel(_) => {
                    Box::new(conf.build::<h_sealevel::Keypair>().await?)
                }
                ChainConnectionConf::Cosmos(_) => Box::new(conf.build::<h_cosmos::Signer>().await?),
                ChainConnectionConf::CosmosNative(_) => {
                    Box::new(conf.build::<h_cosmos_native::Signer>().await?)
                }
            };
            Ok(Some(chain_signer))
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

    async fn cosmos_signer(&self) -> Result<Option<h_cosmos::Signer>> {
        self.signer().await
    }

    async fn cosmos_native_signer(&self) -> Result<Option<h_cosmos_native::Signer>> {
        self.signer().await
    }

    /// Try to build an agent metrics configuration from the chain config
    pub async fn agent_metrics_conf(&self, agent_name: String) -> Result<AgentMetricsConf> {
        let chain_signer_address = self.chain_signer().await?.map(|s| s.address_string());
        Ok(AgentMetricsConf {
            address: chain_signer_address,
            domain: self.domain.clone(),
            name: agent_name,
        })
    }

    /// Get a clone of the ethereum metrics conf with correctly configured
    /// contract information.
    pub fn metrics_conf(&self) -> PrometheusMiddlewareConf {
        let mut cfg = self.metrics_conf.clone();

        if cfg.chain.is_none() {
            cfg.chain = Some(ChainInfo {
                name: Some(self.domain.name().into()),
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
        register_contract(
            "merkle_tree_hook",
            self.addresses.merkle_tree_hook,
            EthereumInterchainGasPaymasterAbi::fn_map_owned(),
        );

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
        let mut signer = None;
        if B::NEEDS_SIGNER {
            signer = self.ethereum_signer().await?;
        }
        let metrics_conf = self.metrics_conf();
        let client_metrics = metrics.client_metrics();

        let client_metrics = Some(client_metrics);
        let middleware_metrics = Some((metrics.provider_metrics(), metrics_conf));

        let res = builder
            .build_with_connection_conf(conf, locator, signer, client_metrics, middleware_metrics)
            .await;
        Ok(res?)
    }
}

/// Helper to build a sealevel provider
fn build_sealevel_provider(
    chain_conf: &ChainConf,
    locator: &ContractLocator,
    contract_addresses: &[H256],
    conf: &h_sealevel::ConnectionConf,
    metrics: &CoreMetrics,
) -> SealevelProvider {
    let middleware_metrics = chain_conf.metrics_conf();
    let client_metrics = metrics.client_metrics();

    let chain = middleware_metrics.chain.clone();
    let urls = conf.urls.clone();
    let rpc_client = SealevelFallbackRpcClient::from_urls(chain, urls, client_metrics);
    SealevelProvider::new(rpc_client, locator.domain.clone(), contract_addresses, conf)
}

fn build_sealevel_tx_submitter(
    provider: &Arc<SealevelProvider>,
    chain_conf: &ChainConf,
    connection_conf: &h_sealevel::ConnectionConf,
    locator: &ContractLocator,
    metrics: &CoreMetrics,
) -> Box<dyn TransactionSubmitter> {
    let middleware_metrics = chain_conf.metrics_conf();
    let client_metrics = metrics.client_metrics();
    connection_conf.transaction_submitter.create_submitter(
        provider,
        client_metrics,
        middleware_metrics.chain.clone(),
        locator.domain.clone(),
        connection_conf,
    )
}

fn build_cosmos_provider(
    chain_conf: &ChainConf,
    connection_conf: &h_cosmos::ConnectionConf,
    metrics: &CoreMetrics,
    locator: &ContractLocator,
    signer: Option<Signer>,
) -> ChainResult<CosmosProvider> {
    let middleware_metrics = chain_conf.metrics_conf();
    let client_metrics = metrics.client_metrics();

    CosmosProvider::new(
        locator.domain.clone(),
        connection_conf.clone(),
        locator,
        signer,
        client_metrics,
        middleware_metrics.chain.clone(),
    )
}

fn build_cosmos_wasm_provider(
    chain_conf: &ChainConf,
    connection_conf: &h_cosmos::ConnectionConf,
    locator: &ContractLocator,
    metrics: &CoreMetrics,
    reorg_period: u32,
    event_type: String,
) -> ChainResult<CosmosWasmRpcProvider> {
    let middleware_metrics = chain_conf.metrics_conf();
    let client_metrics = metrics.client_metrics();

    CosmosWasmRpcProvider::new(
        connection_conf,
        locator,
        event_type,
        reorg_period,
        client_metrics,
        middleware_metrics.chain.clone(),
    )
}

fn build_cosmos_native_provider(
    chain_conf: &ChainConf,
    connection_conf: &h_cosmos_native::ConnectionConf,
    metrics: &CoreMetrics,
    locator: &ContractLocator,
    signer: Option<hyperlane_cosmos_native::Signer>,
) -> ChainResult<CosmosNativeProvider> {
    let middleware_metrics = chain_conf.metrics_conf();
    let metrics = metrics.client_metrics();
    CosmosNativeProvider::new(
        connection_conf,
        locator,
        signer,
        metrics,
        middleware_metrics.chain.clone(),
    )
}
