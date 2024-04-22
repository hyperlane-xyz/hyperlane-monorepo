#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::num::NonZeroU64;
use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::abi::AbiEncode;
use ethers::prelude::Middleware;
use ethers_contract::builders::ContractCall;
use starknet::signers::LocalWallet;
use tracing::instrument;

use hyperlane_core::{
    utils::bytes_to_hex, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneAbi,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProtocolError,
    HyperlaneProvider, Indexer, LogMeta, Mailbox, RawHyperlaneMessage, SequenceAwareIndexer,
    TxCostEstimate, TxOutcome, H160, H256, U256,
};

use crate::bindings::Mailbox as StarknetMailboxInternal;
use crate::trait_builder::BuildableWithProvider;
use crate::{ConnectionConf, StarknetProvider};

impl std::fmt::Display for StarknetMailboxInternal
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// A reference to a Mailbox contract on some Starknet chain
#[derive(Debug)]
pub struct StarknetMailbox {
    contract: Arc<StarknetMailboxInternal>,
    provider: StarknetProvider,
    conn: ConnectionConf,
    signer: LocalWallet,
}

impl StarknetMailbox {
    /// Create a reference to a mailbox at a specific Starknet address on some
    /// chain
    pub fn new(conn: &ConnectionConf, locator: &ContractLocator, signer: LocalWallet) -> Self {
        let provider = StarknetProvider::new(conn.domain.clone(), conn, signer);
        Self {
            contract: Arc::new(StarknetMailboxInternal::new(
                locator.address,
                provider.rpc_client(),
            )),
            domain: provider.domain(),
            provider,
            conn: conn.clone(),
        }
    }

    /// Returns a ContractCall that processes the provided message.
    /// If the provided tx_gas_limit is None, gas estimation occurs.
    async fn process_contract_call(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_estimate: Option<U256>,
    ) -> ChainResult {
        todo!()
    }
}

impl HyperlaneChain for StarknetMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(StarknetProvider::new(
            self.provider.clone(),
            self.domain.clone(),
            None,
        ))
    }
}

impl HyperlaneContract for StarknetMailbox {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl Mailbox for StarknetMailbox {
    #[instrument(skip(self))]
    async fn count(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<u32> {
        let call = call_with_lag(self.contract.nonce(), &self.provider, maybe_lag).await?;
        let nonce = call.call().await?;
        Ok(nonce)
    }

    #[instrument(skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        Ok(self.contract.delivered(id.into()).call().await?)
    }

    #[instrument(skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        Ok(self.contract.default_ism().call().await?.into())
    }

    #[instrument(skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        Ok(self
            .contract
            .recipient_ism(recipient.into())
            .call()
            .await?
            .into())
    }

    #[instrument(skip(self), fields(metadata=%bytes_to_hex(metadata)))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let contract_call = self
            .process_contract_call(message, metadata, tx_gas_limit)
            .await?;
        let receipt = report_tx(contract_call).await?;
        Ok(receipt.into())
    }

    #[instrument(skip(self), fields(msg=%message, metadata=%bytes_to_hex(metadata)))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let contract_call = self.process_contract_call(message, metadata, None).await?;
        let gas_limit = contract_call
            .tx
            .gas()
            .copied()
            .ok_or(HyperlaneProtocolError::ProcessGasLimitRequired)?;

        let gas_price: U256 = self
            .provider
            .get_gas_price()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into();

        Ok(TxCostEstimate {
            gas_limit: gas_limit.into(),
            gas_price: gas_price.try_into()?,
            l2_gas_limit: l2_gas_limit.map(|v| v.into()),
        })
    }

    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
        let process_call = ProcessCall {
            message: RawHyperlaneMessage::from(message).to_vec().into(),
            metadata: metadata.to_vec().into(),
        };

        AbiEncode::encode(process_call)
    }
}

pub struct StarknetMailboxAbi;

impl HyperlaneAbi for StarknetMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        todo!()
    }
}
