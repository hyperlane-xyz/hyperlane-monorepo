use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::abi::Detokenize;
use ethers::prelude::Middleware;
use ethers_contract::builders::ContractCall;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, OnchainCheckpointStorage, SignedAnnouncement, SignedCheckpointWithMessageId,
    TxOutcome, H160, H256, U256,
};

use crate::interfaces::arbitrum_node_interface::ArbitrumNodeInterface;
use crate::interfaces::i_checkpoint_storage::{
    Announcement as AnnouncementContractType, Checkpoint as CheckpointContractType,
    ICheckpointStorage, SignedCheckpoint as SignedCheckpointContractType, ICHECKPOINTSTORAGE_ABI,
};
use crate::tx::{fill_tx_gas_params, report_tx};
use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider};

/// A builder for a checkpoint storage contract on Ethereum
pub struct EthereumCheckpointStorageBuilder {}

#[async_trait]
impl BuildableWithProvider for EthereumCheckpointStorageBuilder {
    type Output = Box<dyn OnchainCheckpointStorage>;
    const NEEDS_SIGNER: bool = true;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumCheckpointStorage::new(
            Arc::new(provider),
            conn,
            locator,
        ))
    }
}

#[derive(Debug)]
/// A checkpoint storage contract on Ethereum
pub struct EthereumCheckpointStorage<M>
where
    M: Middleware + 'static,
{
    contract: Arc<ICheckpointStorage<M>>,
    domain: HyperlaneDomain,
    provider: Arc<M>,
    arbitrum_node_interface: Option<Arc<ArbitrumNodeInterface<M>>>,
    conn: ConnectionConf,
}

impl<M> HyperlaneChain for EthereumCheckpointStorage<M>
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

impl<M> HyperlaneContract for EthereumCheckpointStorage<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

impl<M> OnchainCheckpointStorage for EthereumCheckpointStorage<M>
where
    M: Middleware + 'static,
{
    fn announcement_location(&self) -> String {
        format!(
            "{}:{}",
            self.domain.name(),
            self.contract.address().to_string()
        )
    }
}

impl<M> EthereumCheckpointStorage<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a checkpoint storage at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, conn: &ConnectionConf, locator: &ContractLocator) -> Self {
        // Arbitrum Nitro based chains are a special case for transaction cost estimation.
        // The gas amount that eth_estimateGas returns considers both L1 and L2 gas costs.
        // We use the NodeInterface, found at address(0xC8), to isolate the L2 gas costs.
        // See https://developer.arbitrum.io/arbos/gas#nodeinterfacesol or https://github.com/OffchainLabs/nitro/blob/master/contracts/src/node-interface/NodeInterface.sol#L25
        let arbitrum_node_interface = locator.domain.is_arbitrum_nitro().then(|| {
            Arc::new(ArbitrumNodeInterface::new(
                H160::from_low_u64_be(0xC8),
                provider.clone(),
            ))
        });

        Self {
            contract: Arc::new(ICheckpointStorage::new(locator.address, provider.clone())),
            domain: locator.domain.clone(),
            provider,
            arbitrum_node_interface,
            conn: conn.clone(),
        }
    }

    async fn add_gas_overrides<D: Detokenize>(
        &self,
        tx: ContractCall<M, D>,
    ) -> ChainResult<ContractCall<M, D>> {
        fill_tx_gas_params(
            tx,
            self.provider.clone(),
            &self.conn.transaction_overrides.clone(),
        )
        .await
    }

    async fn execute_contract_call<D: Detokenize>(
        &self,
        mut tx: ContractCall<M, D>,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        if let Some(gas_estimate) = tx_gas_limit {
            tx = tx.gas(gas_estimate);
        }
        let contract_call = self.add_gas_overrides(tx).await?;
        let receipt = report_tx(contract_call).await?;
        Ok(receipt.into())
    }

    async fn latest_index(&self, tx_gas_limit: Option<U256>) -> ChainResult<TxOutcome> {
        let tx = self.contract.latest_index();
        self.execute_contract_call(tx, tx_gas_limit).await
    }

    async fn fetch_checkpoint(
        &self,
        validator: H160,
        index: u32,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let tx = self.contract.fetch_checkpoint(validator.into(), index);
        self.execute_contract_call(tx, tx_gas_limit).await
    }

    async fn write_checkpoint(
        &self,
        checkpoint: &SignedCheckpointWithMessageId,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let tx = self
            .contract
            .write_checkpoint(SignedCheckpointContractType {
                checkpoint: CheckpointContractType {
                    origin: (&self.domain).into(),
                    merkle_tree: checkpoint.value.merkle_tree_hook_address.into(),
                    root: checkpoint.value.root.into(),
                    index: checkpoint.value.index,
                    message_id: checkpoint.value.message_id.into(),
                },
                signature: checkpoint.signature.to_vec().into(),
            });
        self.execute_contract_call(tx, tx_gas_limit).await
    }

    async fn write_metadata(
        &self,
        metadata: String,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let tx = self.contract.write_metadata(metadata.clone());
        self.execute_contract_call(tx, tx_gas_limit).await
    }

    async fn write_announcement(
        &self,
        announcement: &SignedAnnouncement,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let tx = self.contract.write_announcement(
            AnnouncementContractType {
                validator: announcement.value.validator.into(),
                mailbox_address: announcement.value.mailbox_address.into(),
                mailbox_domain: announcement.value.mailbox_domain,
                storage_location: announcement.value.storage_location.clone().into(),
            },
            announcement.signature.to_vec().into(),
        );
        self.execute_contract_call(tx, tx_gas_limit).await
    }
}

/// ABI for the checkpoint storage contract
pub struct EthereumCheckpointStorageAbi;

impl HyperlaneAbi for EthereumCheckpointStorageAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&ICHECKPOINTSTORAGE_ABI)
    }
}

/*  TODO: Add tests for checkpoint storage
#[cfg(test)]
mod test {
    use std::{str::FromStr, sync::Arc};

    use ethers::{
        providers::{MockProvider, Provider},
        types::{Block, Transaction, U256 as EthersU256},
    };

    use hyperlane_core::{
        ContractLocator, HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, Mailbox,
        TxCostEstimate, H160, H256, U256,
    };

    use crate::{contracts::EthereumMailbox, ConnectionConf, RpcConnectionConf};

    /// An amount of gas to add to the estimated gas
    const GAS_ESTIMATE_BUFFER: u32 = 75_000;

    fn get_test_mailbox(
        domain: HyperlaneDomain,
    ) -> (
        EthereumMailbox<Provider<Arc<MockProvider>>>,
        Arc<MockProvider>,
    ) {
        let mock_provider = Arc::new(MockProvider::new());
        let provider = Arc::new(Provider::new(mock_provider.clone()));
        let connection_conf = ConnectionConf {
            rpc_connection: RpcConnectionConf::Http {
                url: "http://127.0.0.1:8545".parse().unwrap(),
            },
            transaction_overrides: Default::default(),
            operation_batch: Default::default(),
        };

        let mailbox = EthereumMailbox::new(
            provider.clone(),
            &connection_conf,
            &ContractLocator {
                domain: &domain,
                // Address doesn't matter because we're using a MockProvider
                address: H256::default(),
            },
        );
        (mailbox, mock_provider)
    }

    #[tokio::test]
    async fn test_process_estimate_costs_sets_l2_gas_limit_for_arbitrum() {
        // An Arbitrum Nitro chain
        let (mailbox, mock_provider) =
            get_test_mailbox(HyperlaneDomain::Known(KnownHyperlaneDomain::PlumeTestnet));

        let message = HyperlaneMessage::default();
        let metadata: Vec<u8> = vec![];

        assert!(mailbox.arbitrum_node_interface.is_some());
        // Confirm `H160::from_low_u64_ne(0xC8)` does what's expected
        assert_eq!(
            H160::from(mailbox.arbitrum_node_interface.as_ref().unwrap().address()),
            H160::from_str("0x00000000000000000000000000000000000000C8").unwrap(),
        );

        // The MockProvider responses we push are processed in LIFO
        // order, so we start with the final RPCs and work toward the first
        // RPCs

        // RPC 4: eth_gasPrice by process_estimate_costs
        // Return 15 gwei
        let gas_price: U256 =
            EthersU256::from(ethers::utils::parse_units("15", "gwei").unwrap()).into();
        mock_provider.push(gas_price).unwrap();

        // RPC 4: eth_estimateGas to the ArbitrumNodeInterface's estimateRetryableTicket function by process_estimate_costs
        let l2_gas_limit = U256::from(200000); // 200k gas
        mock_provider.push(l2_gas_limit).unwrap();

        let latest_block: Block<Transaction> = Block {
            gas_limit: ethers::types::U256::MAX,
            ..Block::<Transaction>::default()
        };
        // RPC 3: eth_getBlockByNumber from the fill_tx_gas_params call in process_contract_call
        // to get the latest block gas limit and for eip 1559 fee estimation
        mock_provider.push(latest_block).unwrap();

        // RPC 1: eth_estimateGas from the estimate_gas call in process_contract_call
        // Return 1M gas
        let gas_limit = U256::from(1000000u32);
        mock_provider.push(gas_limit).unwrap();

        let tx_cost_estimate = mailbox
            .process_estimate_costs(&message, &metadata)
            .await
            .unwrap();

        // The TxCostEstimate's gas limit includes the buffer
        let estimated_gas_limit = gas_limit.saturating_add(GAS_ESTIMATE_BUFFER.into());

        assert_eq!(
            tx_cost_estimate,
            TxCostEstimate {
                gas_limit: estimated_gas_limit,
                gas_price: gas_price.try_into().unwrap(),
                l2_gas_limit: Some(l2_gas_limit),
            },
        );
    }

    #[tokio::test]
    async fn test_tx_gas_limit_caps_at_block_gas_limit() {
        let (mailbox, mock_provider) =
            get_test_mailbox(HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum));

        let message = HyperlaneMessage::default();
        let metadata: Vec<u8> = vec![];

        // The MockProvider responses we push are processed in LIFO
        // order, so we start with the final RPCs and work toward the first
        // RPCs

        // RPC 4: eth_gasPrice by process_estimate_costs
        // Return 15 gwei
        let gas_price: U256 =
            EthersU256::from(ethers::utils::parse_units("15", "gwei").unwrap()).into();
        mock_provider.push(gas_price).unwrap();

        let latest_block_gas_limit = U256::from(12345u32);
        let latest_block: Block<Transaction> = Block {
            gas_limit: latest_block_gas_limit.into(),
            ..Block::<Transaction>::default()
        };
        // RPC 3: eth_getBlockByNumber from the fill_tx_gas_params call in process_contract_call
        // to get the latest block gas limit and for eip 1559 fee estimation
        mock_provider.push(latest_block).unwrap();

        // RPC 1: eth_estimateGas from the estimate_gas call in process_contract_call
        // Return 1M gas
        let gas_limit = U256::from(1000000u32);
        mock_provider.push(gas_limit).unwrap();

        let tx_cost_estimate = mailbox
            .process_estimate_costs(&message, &metadata)
            .await
            .unwrap();

        assert_eq!(
            tx_cost_estimate,
            TxCostEstimate {
                // The block gas limit is the cap
                gas_limit: latest_block_gas_limit,
                gas_price: gas_price.try_into().unwrap(),
                l2_gas_limit: None,
            },
        );
    }
}
*/
