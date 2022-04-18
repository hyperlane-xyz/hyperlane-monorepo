#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use abacus_core::{ChainCommunicationError, ContractLocator, TxOutcome};
use abacus_core::{InboxValidatorManager, MultisigSignedCheckpoint};
use async_trait::async_trait;
use color_eyre::Result;
use ethers::contract::abigen;
use ethers::core::types::Address;

use std::sync::Arc;

use crate::report_tx;

abigen!(
    EthereumInboxValidatorManagerInternal,
    "./chains/abacus-ethereum/abis/InboxValidatorManager.abi.json",
);

impl<M> std::fmt::Display for EthereumInboxValidatorManagerInternal<M>
where
    M: ethers::providers::Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

/// A struct that provides access to an Ethereum InboxValidatorManager contract
#[derive(Debug)]
pub struct EthereumInboxValidatorManager<M>
where
    M: ethers::providers::Middleware,
{
    contract: Arc<EthereumInboxValidatorManagerInternal<M>>,
    domain: u32,
    name: String,
    provider: Arc<M>,
    inbox_address: Address,
}

impl<M> EthereumInboxValidatorManager<M>
where
    M: ethers::providers::Middleware,
{
    /// Create a reference to a inbox at a specific Ethereum address on some
    /// chain
    pub fn new(
        provider: Arc<M>,
        ContractLocator {
            name,
            domain,
            address,
        }: &ContractLocator,
        inbox_address: Address,
    ) -> Self {
        Self {
            contract: Arc::new(EthereumInboxValidatorManagerInternal::new(
                address,
                provider.clone(),
            )),
            domain: *domain,
            name: name.to_owned(),
            provider,
            inbox_address,
        }
    }
}

#[async_trait]
impl<M> InboxValidatorManager for EthereumInboxValidatorManager<M>
where
    M: ethers::providers::Middleware + 'static,
{
    #[tracing::instrument(err, skip(self))]
    async fn submit_checkpoint(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        let tx = self.contract.checkpoint(
            self.inbox_address,
            multisig_signed_checkpoint.checkpoint.root.to_fixed_bytes(),
            multisig_signed_checkpoint.checkpoint.index.into(),
            multisig_signed_checkpoint
                .signatures
                .iter()
                .map(|s| s.to_vec().into())
                .collect(),
        );

        Ok(report_tx!(tx).into())
    }
}
