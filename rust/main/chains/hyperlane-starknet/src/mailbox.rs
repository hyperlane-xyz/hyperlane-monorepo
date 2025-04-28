#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use byteorder::{BigEndian, ByteOrder};

use async_trait::async_trait;
use hyperlane_core::{
    utils::bytes_to_hex, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox,
    TxCostEstimate, TxOutcome, H256, U256,
};
use hyperlane_core::{FixedPointNumber, ReorgPeriod};
use starknet::accounts::{Execution, SingleOwnerAccount};
use starknet::core::types::FieldElement;

use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::mailbox::{Mailbox as StarknetMailboxInternal, Message as StarknetMessage};
use crate::error::HyperlaneStarknetError;
use crate::types::{HyH256, HyU256};
use crate::utils::to_mailbox_bytes;
use crate::{
    build_single_owner_account, get_block_height_for_reorg_period, send_and_confirm,
    ConnectionConf, Signer, StarknetProvider,
};
use cainome::cairo_serde::U256 as StarknetU256;

impl<A> std::fmt::Display for StarknetMailboxInternal<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl From<&HyperlaneMessage> for StarknetMessage {
    fn from(message: &HyperlaneMessage) -> Self {
        StarknetMessage {
            version: message.version,
            nonce: message.nonce,
            origin: message.origin,
            sender: StarknetU256::from_bytes_be(&message.sender.to_fixed_bytes()),
            destination: message.destination,
            recipient: StarknetU256::from_bytes_be(&message.recipient.to_fixed_bytes()),
            body: to_mailbox_bytes(&message.body),
        }
    }
}

/// A reference to a Mailbox contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetMailbox {
    contract: Arc<StarknetMailboxInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetMailbox {
    /// Create a reference to a mailbox at a specific Starknet address on some
    /// chain
    pub fn new(
        conn: &ConnectionConf,
        locator: &ContractLocator,
        signer: Signer,
    ) -> ChainResult<Self> {
        let account = build_single_owner_account(
            &conn.url,
            signer.local_wallet(),
            &signer.address,
            false,
            locator.domain.id(),
        );

        let mailbox_address: FieldElement = HyH256(locator.address)
            .try_into()
            .map_err(HyperlaneStarknetError::BytesConversionError)?;

        let contract = StarknetMailboxInternal::new(mailbox_address, account);

        Ok(Self {
            contract: Arc::new(contract),
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
        tx_gas_estimate: Option<U256>,
    ) -> ChainResult<Execution<'_, SingleOwnerAccount<AnyProvider, LocalWallet>>> {
        println!("MAILBOX address: {:?}", self.contract.address);

        println!(
            "SAQUON process call: metadata {:?} and message {:?} and id {:?}",
            metadata,
            StarknetMessage::from(message),
            message.id()
        );

        // self.contract.
        let tx = self
            .contract
            .process(&to_mailbox_bytes(metadata), &message.into());

        println!("SAQUON tx {:?}", tx);
        let gas_estimate = match tx_gas_estimate {
            Some(estimate) => HyU256(estimate)
                .try_into()
                .map_err(Into::<HyperlaneStarknetError>::into)?,
            None => {
                tx.estimate_fee()
                    .await
                    .map_err(|e| {
                        tracing::error!("Failed to estimate fee in process_contract_call: {:?}", e);
                        HyperlaneStarknetError::AccountError(e.to_string())
                    })?
                    .overall_fee
            }
        };
        println!("SAQUON gas estimate {:?}", gas_estimate);
        Ok(tx.max_fee(gas_estimate * FieldElement::TWO))
    }

    #[allow(unused)]
    pub fn contract(
        &self,
    ) -> &StarknetMailboxInternal<SingleOwnerAccount<AnyProvider, LocalWallet>> {
        &self.contract
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
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let contract_call = self
            .process_contract_call(message, metadata, tx_gas_limit)
            .await?;
        send_and_confirm(&self.provider.rpc_client(), contract_call).await
    }

    #[instrument(skip(self), fields(msg=%message, metadata=%bytes_to_hex(metadata)))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let contract_call = self.process_contract_call(message, metadata, None).await?;

        // Get fee estimate from the provider
        let fee_estimate = contract_call.estimate_fee().await.map_err(|e| {
            tracing::error!("Failed to estimate fee in process_estimate_costs: {:?}", e);
            HyperlaneStarknetError::AccountError(e.to_string())
        })?;

        Ok(TxCostEstimate {
            gas_limit: HyU256::from(fee_estimate.overall_fee).0,
            gas_price: FixedPointNumber::try_from(HyU256::from(fee_estimate.gas_price).0).map_err(
                |e| {
                    HyperlaneStarknetError::AccountError(format!(
                        "Failed to convert gas price to FixedPointNumber: {e}"
                    ))
                },
            )?,
            l2_gas_limit: Some(HyU256::from(fee_estimate.overall_fee).0),
        })
    }

    async fn process_calldata(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        // For Starknet, we don't need to process the calldata as it's handled by the contract
        Ok(Vec::new())
    }
}

pub struct StarknetMailboxAbi;

impl HyperlaneAbi for StarknetMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        HashMap::default()
    }
}
