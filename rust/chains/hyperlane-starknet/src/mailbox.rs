#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::num::NonZeroU64;
use std::sync::Arc;

use byteorder::{BigEndian, ByteOrder};

use async_trait::async_trait;
use hyperlane_core::{
    utils::bytes_to_hex, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox,
    TxCostEstimate, TxOutcome, H256, U256,
};
use starknet::accounts::{Execution, SingleOwnerAccount};
use starknet::core::types::{
    FieldElement, MaybePendingTransactionReceipt, PendingTransactionReceipt, TransactionReceipt,
};
use starknet::providers::{AnyProvider, Provider};
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::mailbox::{Mailbox as StarknetMailboxInternal, Message as StarknetMessage};
use crate::error::HyperlaneStarknetError;
use crate::utils::to_mailbox_bytes;
use crate::{
    build_single_owner_account, get_transaction_receipt, ConnectionConf, Signer, StarknetProvider,
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

        let contract = StarknetMailboxInternal::new(
            locator
                .address
                .try_into()
                .map_err(HyperlaneStarknetError::BytesConversionError)?,
            account,
        );

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
        let tx = self.contract.process(
            &to_mailbox_bytes(metadata),
            &StarknetMessage {
                version: message.version,
                nonce: message.nonce,
                origin: message.origin,
                sender: StarknetU256::from_bytes_be(&message.sender.to_fixed_bytes()),
                destination: message.destination,
                recipient: StarknetU256::from_bytes_be(&message.recipient.to_fixed_bytes()),
                body: to_mailbox_bytes(&message.body),
            },
        );

        let gas_estimate = match tx_gas_estimate {
            Some(estimate) => estimate
                .try_into()
                .map_err(Into::<HyperlaneStarknetError>::into)?,
            None => {
                tx.estimate_fee()
                    .await
                    .map_err(|e| HyperlaneStarknetError::AccountError(e.to_string()))?
                    .overall_fee
            }
        };
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
        &self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetMailbox {
    fn address(&self) -> H256 {
        self.contract.address.into()
    }
}

#[async_trait]
impl Mailbox for StarknetMailbox {
    #[instrument(skip(self))]
    async fn count(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<u32> {
        let current_block = self
            .provider
            .rpc_client()
            .block_number()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        let nonce = match maybe_lag {
            Some(lag) => self
                .contract
                .nonce()
                .block_id(starknet::core::types::BlockId::Number(
                    current_block - lag.get(),
                ))
                .call()
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?,
            None => self
                .contract
                .nonce()
                .call()
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?,
        };

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
        Ok(address.0.into())
    }

    #[instrument(skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let address = self
            .contract
            .recipient_ism(&StarknetU256::from_bytes_be(&recipient.to_fixed_bytes()))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        Ok(address.0.into())
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
        let tx = contract_call
            .send()
            .await
            .map_err(|e| HyperlaneStarknetError::AccountError(e.to_string()))?;
        let invoke_tx_receipt =
            get_transaction_receipt(&self.provider.rpc_client(), tx.transaction_hash).await;
        match invoke_tx_receipt {
            Ok(MaybePendingTransactionReceipt::Receipt(TransactionReceipt::Invoke(receipt))) => {
                return Ok(receipt.try_into()?);
            }
            Ok(MaybePendingTransactionReceipt::PendingReceipt(
                PendingTransactionReceipt::Invoke(receipt),
            )) => {
                return Ok(receipt.try_into()?);
            }
            _ => {
                return Err(HyperlaneStarknetError::InvalidTransactionReceipt.into());
            }
        }
    }

    #[instrument(skip(self), fields(msg=%message, metadata=%bytes_to_hex(metadata)))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let _contract_call = self.process_contract_call(message, metadata, None).await?;

        Ok(TxCostEstimate::default())
    }

    fn process_calldata(&self, _message: &HyperlaneMessage, _metadata: &[u8]) -> Vec<u8> {
        todo!()
    }
}

pub struct StarknetMailboxAbi;

impl HyperlaneAbi for StarknetMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        todo!()
    }
}
