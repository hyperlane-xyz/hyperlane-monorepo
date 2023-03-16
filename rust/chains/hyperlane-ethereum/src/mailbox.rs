#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::num::NonZeroU64;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::abi::AbiEncode;
use ethers::prelude::Middleware;
use ethers::types::Eip1559TransactionRequest;
use ethers_contract::builders::ContractCall;
use hyperlane_core::{H160, KnownHyperlaneDomain};
use tracing::instrument;

use hyperlane_core::{
    utils::fmt_bytes, ChainCommunicationError, ChainResult, Checkpoint, ContractLocator,
    HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProtocolError, HyperlaneProvider, Indexer, LogMeta, Mailbox, MailboxIndexer,
    RawHyperlaneMessage, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::contracts::arbitrum_node_interface::ArbitrumNodeInterface;
use crate::contracts::mailbox::{Mailbox as EthereumMailboxInternal, ProcessCall, MAILBOX_ABI};
use crate::trait_builder::BuildableWithProvider;
use crate::tx::report_tx;
use crate::EthereumProvider;

/// An amount of gas to add to the estimated gas
const GAS_ESTIMATE_BUFFER: u32 = 100000;

impl<M> std::fmt::Display for EthereumMailboxInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

pub struct MailboxIndexerBuilder {
    pub finality_blocks: u32,
}

#[async_trait]
impl BuildableWithProvider for MailboxIndexerBuilder {
    type Output = Box<dyn MailboxIndexer>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMailboxIndexer::new(
            Arc::new(provider),
            locator,
            self.finality_blocks,
        ))
    }
}

#[derive(Debug)]
/// Struct that retrieves event data for an Ethereum mailbox
pub struct EthereumMailboxIndexer<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMailboxInternal<M>>,
    provider: Arc<M>,
    finality_blocks: u32,
}

impl<M> EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumMailboxIndexer
    pub fn new(provider: Arc<M>, locator: &ContractLocator, finality_blocks: u32) -> Self {
        let contract = Arc::new(EthereumMailboxInternal::new(
            locator.address,
            provider.clone(),
        ));
        Self {
            contract,
            provider,
            finality_blocks,
        }
    }
}

#[async_trait]
impl<M> Indexer for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self
            .provider
            .get_block_number()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .as_u32()
            .saturating_sub(self.finality_blocks))
    }
}

#[async_trait]
impl<M> MailboxIndexer for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn fetch_sorted_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {
        let mut events: Vec<(HyperlaneMessage, LogMeta)> = self
            .contract
            .dispatch_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| (HyperlaneMessage::from(event.message.to_vec()), meta.into()))
            .collect();

        events.sort_by(|a, b| a.0.nonce.cmp(&b.0.nonce));
        Ok(events)
    }

    #[instrument(err, skip(self))]
    async fn fetch_delivered_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(H256, LogMeta)>> {
        Ok(self
            .contract
            .process_id_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| (H256::from(event.message_id), meta.into()))
            .collect())
    }
}

pub struct MailboxBuilder {}

#[async_trait]
impl BuildableWithProvider for MailboxBuilder {
    type Output = Box<dyn Mailbox>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMailbox::new(Arc::new(provider), locator))
    }
}

/// A reference to a Mailbox contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMailbox<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMailboxInternal<M>>,
    domain: HyperlaneDomain,
    provider: Arc<M>,
    arbitrum_node_interface: Option<Arc<ArbitrumNodeInterface<M>>>,
}

impl<M> EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        // Arbitrum Nitro based chains are a special case for transaction cost estimation.
        // The gas amount that eth_estimateGas returns considers both L1 and L2 gas costs.
        // We use the NodeInterface, found at address(0xC8), to isolate the L2 gas costs.
        // See https://developer.arbitrum.io/arbos/gas#nodeinterfacesol or https://github.com/OffchainLabs/nitro/blob/master/contracts/src/node-interface/NodeInterface.sol#L110
        let arbitrum_node_interface = locator.domain.is_arbitrum_nitro().then(|| {
            Arc::new(ArbitrumNodeInterface::new(
                H160::from_low_u64_be(0xC8),
                provider.clone(),
            ))
        });

        Self {
            contract: Arc::new(EthereumMailboxInternal::new(
                locator.address,
                provider.clone(),
            )),
            domain: locator.domain.clone(),
            provider,
            arbitrum_node_interface,
        }
    }

    /// Returns a ContractCall that processes the provided message.
    /// If the provided tx_gas_limit is None, gas estimation occurs.
    async fn process_contract_call(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<ContractCall<M, ()>> {
        let tx = self.contract.process(
            metadata.to_vec().into(),
            RawHyperlaneMessage::from(message).to_vec().into(),
        );
        let gas_limit = if let Some(gas_limit) = tx_gas_limit {
            gas_limit
        } else {
            tx.estimate_gas()
                .await?
                .saturating_add(U256::from(GAS_ESTIMATE_BUFFER))
        };
        let chain_id = match self.provider.get_chainid().await {
            Ok(chainId) => chainId.as_u32(),
            // Couldn't get chainId, assume not 1559
            Err(_) => return Ok(tx.gas(gas_limit))
        };
        let Ok((max_fee, max_priority_fee)) = self.provider.estimate_eip1559_fees(None).await else {
            // Is not EIP 1559 chain
            return Ok(tx.gas(gas_limit))
        };
        let max_priority_fee = if KnownHyperlaneDomain::try_from(chain_id)? == KnownHyperlaneDomain::Polygon {
            let min_polygon_fee = ethers::utils::parse_units("31", "gwei").unwrap().into();
            // Polygon needs a max priority fee > 30 gwei
            max_priority_fee.max(min_polygon_fee)
        } else { max_priority_fee };
        // Is EIP 1559 chain
        let mut request = Eip1559TransactionRequest::new();
        if let Some(from) = tx.tx.from() {
            request = request.from(*from);
        }
        if let Some(to) = tx.tx.to() {
            request = request.to(to.clone());
        }
        if let Some(data) = tx.tx.data() {
            request = request.data(data.clone());
        }
        if let Some(value) = tx.tx.value() {
            request = request.value(*value);
        }
        request = request.max_fee_per_gas(max_fee);
        request = request.max_priority_fee_per_gas(max_priority_fee);
        let mut eip_1559_tx = tx.clone();
        eip_1559_tx.tx = ethers::types::transaction::eip2718::TypedTransaction::Eip1559(request);
        Ok(eip_1559_tx.gas(gas_limit))
    }
}

impl<M> HyperlaneChain for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.provider.clone(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> Mailbox for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn count(&self) -> ChainResult<u32> {
        Ok(self.contract.count().call().await?)
    }

    #[instrument(err, ret)]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        Ok(self.contract.delivered(id.into()).call().await?)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn latest_checkpoint(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        let base_call = self.contract.latest_checkpoint();
        let call_with_lag = match maybe_lag {
            Some(lag) => {
                let tip = self
                    .provider
                    .get_block_number()
                    .await
                    .map_err(ChainCommunicationError::from_other)?
                    .as_u64();
                base_call.block(tip.saturating_sub(lag.get()))
            }
            None => base_call,
        };
        let (root, index) = call_with_lag.call().await?;
        Ok(Checkpoint {
            mailbox_address: self.address(),
            mailbox_domain: self.domain.id(),
            root: root.into(),
            index,
        })
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        Ok(self.contract.default_ism().call().await?.into())
    }

    #[instrument(err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        Ok(self
            .contract
            .recipient_ism(recipient.into())
            .call()
            .await?
            .into())
    }

    #[instrument(err, ret, skip(self), fields(metadata=%fmt_bytes(metadata)))]
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

    #[instrument(err, ret, skip(self), fields(msg=%message, metadata=%fmt_bytes(metadata)))]
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

        // If we have a ArbitrumNodeInterface, we need to set the l2_gas_limit.
        let l2_gas_limit = if let Some(arbitrum_node_interface) = &self.arbitrum_node_interface {
            let (l1_gas_limit, _, _) = arbitrum_node_interface
                .gas_estimate_l1_component(
                    self.contract.address(),
                    false, // Not a contract creation
                    contract_call.calldata().unwrap_or_default(),
                )
                .call()
                .await?;
            Some(gas_limit.saturating_sub(l1_gas_limit.into()))
        } else {
            None
        };

        let gas_price = self
            .provider
            .get_gas_price()
            .await
            .map_err(ChainCommunicationError::from_other)?;

        Ok(TxCostEstimate {
            gas_limit,
            gas_price,
            l2_gas_limit,
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

pub struct EthereumMailboxAbi;

impl HyperlaneAbi for EthereumMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        super::extract_fn_map(&MAILBOX_ABI)
    }
}

#[cfg(test)]
mod test {
    use std::{str::FromStr, sync::Arc};

    use ethers::{
        abi::{encode, Token},
        providers::{MockProvider, Provider},
        types::{Block, Transaction},
    };
    use hyperlane_core::{
        ContractLocator, HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, Mailbox,
        TxCostEstimate, H160, H256, U256,
    };

    use crate::{mailbox::GAS_ESTIMATE_BUFFER, EthereumMailbox};

    #[tokio::test]
    async fn test_process_estimate_costs_sets_l2_gas_limit_for_arbitrum() {
        let mock_provider = Arc::new(MockProvider::new());
        let provider = Arc::new(Provider::new(mock_provider.clone()));

        let mailbox = EthereumMailbox::new(
            provider.clone(),
            &ContractLocator {
                // An Arbitrum Nitro chain
                domain: HyperlaneDomain::Known(KnownHyperlaneDomain::ArbitrumGoerli),
                // Address doesn't matter because we're using a MockProvider
                address: H256::default(),
            },
        );

        let message = HyperlaneMessage::default();
        let metadata: Vec<u8> = vec![];

        assert!(mailbox.arbitrum_node_interface.is_some());
        // Confirm `H160::from_low_u64_ne(0xC8)` does what's expected
        assert_eq!(
            mailbox.arbitrum_node_interface.as_ref().unwrap().address(),
            H160::from_str("0x00000000000000000000000000000000000000C8").unwrap(),
        );

        // The MockProvider responses we push are processed in LIFO
        // order, so we start with the final RPCs and work toward the first
        // RPCs

        // RPC 4: eth_gasPrice by process_estimate_costs
        // Return 15 gwei
        let gas_price: U256 = ethers::utils::parse_units("15", "gwei").unwrap().into();
        mock_provider.push(gas_price).unwrap();

        // RPC 3: eth_call to the ArbitrumNodeInterface's gasEstimateL1Component function by process_estimate_costs
        let l1_gas_estimate = U256::from(800000u32); // 800k gas
        let base_fee = U256::from(5u32);
        let l1_base_fee = U256::from(6u32);
        let return_bytes = encode(&[Token::Tuple(vec![
            Token::Uint(l1_gas_estimate),
            Token::Uint(base_fee),
            Token::Uint(l1_base_fee),
        ])]);
        let encoded_return_hex = hex::encode(return_bytes);
        mock_provider
            .push::<String, _>(format!("0x{:}", encoded_return_hex))
            .unwrap();

        // RPC 2: eth_getBlockByNumber from the estimate_eip1559_fees call in process_contract_call
        mock_provider.push(Block::<Transaction>::default()).unwrap();

        // RPC 1: eth_estimateGas from the estimate_gas call in process_contract_call
        // Return 1M gas
        let gas_limit = U256::from(1000000u32);
        mock_provider.push(gas_limit).unwrap();

        let tx_cost_estimate = mailbox
            .process_estimate_costs(&message, &metadata)
            .await
            .unwrap();

        // The TxCostEstimat's gas limit includes the buffer
        let estimated_gas_limit = gas_limit.saturating_add(GAS_ESTIMATE_BUFFER.into());

        assert_eq!(
            tx_cost_estimate,
            TxCostEstimate {
                gas_limit: estimated_gas_limit,
                gas_price,
                l2_gas_limit: Some(estimated_gas_limit.saturating_sub(l1_gas_estimate)),
            },
        );
    }
}
