#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::num::NonZeroU64;
use std::sync::Arc;

use async_trait::async_trait;
use starknet::accounts::Execution;
use starknet::core::types::{FieldElement, MaybePendingTransactionReceipt, TransactionReceipt};
use tracing::instrument;

use hyperlane_core::{
    utils::bytes_to_hex, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox,
    TxCostEstimate, TxOutcome, H256, U256,
};

use crate::contracts::mailbox::{
    Bytes as StarknetBytes, Mailbox as StarknetMailboxInternal, Message as StarknetMessage,
};
use crate::error::HyperlaneStarknetError;
use crate::{get_transaction_receipt, ConnectionConf, Signer, StarknetProvider};

impl<A> std::fmt::Display for StarknetMailboxInternal<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// A reference to a Mailbox contract on some Starknet chain
#[derive(Debug)]
pub struct StarknetMailbox<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug,
{
    contract: Arc<StarknetMailboxInternal<A>>,
    provider: StarknetProvider<A>,
    conn: ConnectionConf,
}

impl<A> StarknetMailbox<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug,
{
    /// Create a reference to a mailbox at a specific Starknet address on some
    /// chain
    pub fn new(conn: &ConnectionConf, locator: &ContractLocator, signer: Option<Signer>) -> Self {
        let provider: StarknetProvider<A> =
            StarknetProvider::new(locator.domain.clone(), conn, signer);
        Self {
            contract: Arc::new(StarknetMailboxInternal::new(
                FieldElement::from_bytes_be(&locator.address.to_fixed_bytes()).unwrap(),
                *provider.account().unwrap(),
            )),
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
    ) -> ChainResult<Execution<'_, A>> {
        let tx = self.contract.process(
            &StarknetBytes {
                size: metadata.len() as u32,
                data: metadata.iter().map(|b| *b as u128).collect(),
            },
            &StarknetMessage {
                version: message.version,
                nonce: message.nonce,
                origin: message.origin,
                sender: cainome::cairo_serde::ContractAddress(
                    FieldElement::from_bytes_be(&message.sender.to_fixed_bytes())
                        .map_err(Into::<HyperlaneStarknetError>::into)?,
                ),
                destination: message.destination,
                recipient: cainome::cairo_serde::ContractAddress(
                    FieldElement::from_bytes_be(&message.recipient.to_fixed_bytes())
                        .map_err(Into::<HyperlaneStarknetError>::into)?,
                ),
                body: StarknetBytes {
                    size: message.body.len() as u32,
                    data: message.body.iter().map(|b| *b as u128).collect(),
                },
            },
        );

        let gas_estimate = match tx_gas_estimate {
            Some(estimate) => FieldElement::from_dec_str(estimate.to_string().as_str())
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
}

impl<A> HyperlaneChain for StarknetMailbox<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(StarknetProvider::<A>::new(
            self.provider.domain().clone(),
            &self.conn,
            None,
        ))
    }
}

impl<A> HyperlaneContract for StarknetMailbox<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug,
{
    fn address(&self) -> H256 {
        H256::from_slice(self.contract.address.to_bytes_be().as_slice())
    }
}

#[async_trait]
impl<A> Mailbox for StarknetMailbox<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug,
{
    #[instrument(skip(self))]
    async fn count(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<u32> {
        // TODO: add lag support
        // let nonce = self.contract.nonce().call().await?;
        let nonce = 0;
        Ok(nonce)
    }

    #[instrument(skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        Ok(self
            .contract
            .delivered(
                &FieldElement::from_bytes_be(id.as_fixed_bytes())
                    .map_err(Into::<HyperlaneStarknetError>::into)?,
            )
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
        Ok(H256::from_slice(address.0.to_bytes_be().as_slice()))
    }

    #[instrument(skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        Ok(self
            .contract
            .recipient_ism(&cainome::cairo_serde::ContractAddress(
                FieldElement::from_bytes_be(&recipient.to_fixed_bytes())
                    .map_err(Into::<HyperlaneStarknetError>::into)?,
            ))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?
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

    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
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
