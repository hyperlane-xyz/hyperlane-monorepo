#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use byteorder::{BigEndian, ByteOrder};

use async_trait::async_trait;
use cainome::cairo_serde::U256 as StarknetU256;
use hyperlane_core::{
    utils::bytes_to_hex, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox, TxCostEstimate, TxOutcome, H256,
    U256,
};
use hyperlane_core::{FixedPointNumber, ReorgPeriod};
use starknet::accounts::{ExecutionV3, SingleOwnerAccount};
use starknet::core::types::Felt;

use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::mailbox::Mailbox as StarknetMailboxInternal;
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{
    build_single_owner_account, get_block_height_for_reorg_period, send_and_confirm,
    ConnectionConf, JsonProvider, Signer, StarknetProvider,
};

/// A reference to a Mailbox contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetMailbox {
    contract: StarknetMailboxInternal<SingleOwnerAccount<JsonProvider, LocalWallet>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetMailbox {
    /// Create a reference to a mailbox at a specific Starknet address on some
    /// chain
    pub async fn new(
        conn: &ConnectionConf,
        locator: &ContractLocator<'_>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let account = build_single_owner_account(conn.urls.clone(), signer).await?;

        let mailbox_address: Felt = HyH256(locator.address).into();

        let contract = StarknetMailboxInternal::new(mailbox_address, account);

        Ok(Self {
            contract,
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }

    /// Returns a ContractCall that processes the provided message.
    /// If the provided tx_gas_limit is None, gas estimation occurs.
    async fn process_contract_call(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<ExecutionV3<'_, SingleOwnerAccount<JsonProvider, LocalWallet>>> {
        Ok(self.contract.process(&metadata.into(), &message.into()))
    }
}

impl HyperlaneChain for StarknetMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetMailbox {
    fn address(&self) -> H256 {
        HyH256::from(self.contract.address).0
    }
}

#[async_trait]
impl Mailbox for StarknetMailbox {
    #[instrument(skip(self))]
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let block_number =
            get_block_height_for_reorg_period(&self.provider.rpc_client(), reorg_period).await?;

        let nonce = self
            .contract
            .nonce()
            .block_id(starknet::core::types::BlockId::Number(block_number))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(nonce)
    }

    #[instrument(skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let bytes = id.as_bytes();
        let (high_bytes, low_bytes) = bytes.split_at(16);
        let high = BigEndian::read_u128(high_bytes);
        let low = BigEndian::read_u128(low_bytes);
        Ok(self
            .contract
            .delivered(&StarknetU256 { low, high })
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?)
    }

    #[instrument(skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        let address = self
            .contract
            .get_default_ism()
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        Ok(HyH256::from(address.0).0)
    }

    #[instrument(skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let address = self
            .contract
            .recipient_ism(&StarknetU256::from_bytes_be(&recipient.to_fixed_bytes()))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        Ok(HyH256::from(address.0).0)
    }

    #[instrument(skip(self), fields(metadata=%bytes_to_hex(metadata)))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let contract_call = self.process_contract_call(message, metadata).await?;
        send_and_confirm(&self.provider.rpc_client(), contract_call).await
    }

    #[instrument(skip(self), fields(msg=%message, metadata=%bytes_to_hex(metadata)))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let contract_call = self.process_contract_call(message, metadata).await?;

        // Get fee estimate from the provider
        let fee_estimate = contract_call
            .estimate_fee()
            .await
            .map_err(HyperlaneStarknetError::from)?;

        Ok(TxCostEstimate {
            gas_limit: fee_estimate.l2_gas_consumed.into(), // use l2 gas as an approximation, as its the most relevant
            gas_price: FixedPointNumber::zero(),
            l2_gas_limit: Some(fee_estimate.l2_gas_consumed.into()),
        })
    }

    async fn process_calldata(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        // This function is only relevant for the new submitter
        // TODO: Revisit with new submitter changes
        Ok(Vec::new())
    }

    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        todo!()
    }
}
