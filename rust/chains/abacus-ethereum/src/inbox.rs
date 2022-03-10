#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use abacus_core::{accumulator::merkle::Proof, MessageStatus, *};
use abacus_core::{
    AbacusCommon, AbacusCommonIndexer, AbacusMessage, ChainCommunicationError, Checkpoint,
    CheckpointMeta, CheckpointWithMeta, ContractLocator, Inbox, TxOutcome,
};
use async_trait::async_trait;
use color_eyre::Result;
use ethers::contract::abigen;
use ethers::core::types::{H256, U256};
use tracing::instrument;

use std::{error::Error as StdError, sync::Arc};

use crate::report_tx;

abigen!(
    EthereumInboxInternal,
    "./chains/abacus-ethereum/abis/Inbox.abi.json",
     methods {
        initialize(address) as initialize_common;
        initialize(uint32, address, bytes32, uint256, uint32) as initialize;
     },
);

impl<M> std::fmt::Display for EthereumInboxInternal<M>
where
    M: ethers::providers::Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

#[derive(Debug)]
/// Struct that retrieves indexes event data for Ethereum inbox
pub struct EthereumInboxIndexer<M>
where
    M: ethers::providers::Middleware,
{
    contract: Arc<EthereumInboxInternal<M>>,
    provider: Arc<M>,
    from_height: u32,
    chunk_size: u32,
}

impl<M> EthereumInboxIndexer<M>
where
    M: ethers::providers::Middleware + 'static,
{
    /// Create new EthereumHomeIndexer
    pub fn new(
        provider: Arc<M>,
        ContractLocator {
            name: _,
            domain: _,
            address,
        }: &ContractLocator,
        from_height: u32,
        chunk_size: u32,
    ) -> Self {
        Self {
            contract: Arc::new(EthereumInboxInternal::new(address, provider.clone())),
            provider,
            from_height,
            chunk_size,
        }
    }
}

#[async_trait]
impl<M> AbacusCommonIndexer for EthereumInboxIndexer<M>
where
    M: ethers::providers::Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn get_block_number(&self) -> Result<u32> {
        Ok(self.provider.get_block_number().await?.as_u32())
    }

    #[instrument(err, skip(self))]
    async fn fetch_sorted_checkpoints(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<CheckpointWithMeta>> {
        let mut events = self
            .contract
            .checkpoint_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?;

        events.sort_by(|a, b| {
            let mut ordering = a.1.block_number.cmp(&b.1.block_number);
            if ordering == std::cmp::Ordering::Equal {
                ordering = a.1.transaction_index.cmp(&b.1.transaction_index);
            }

            ordering
        });

        let outbox_domain = self.contract.remote_domain().call().await?;

        Ok(events
            .iter()
            .map(|event| {
                let checkpoint = Checkpoint {
                    outbox_domain,
                    root: event.0.root.into(),
                    index: event.0.index.as_u32(),
                };

                CheckpointWithMeta {
                    checkpoint,
                    metadata: CheckpointMeta {
                        block_number: event.1.block_number.as_u64(),
                    },
                }
            })
            .collect())
    }
}

/// A struct that provides access to an Ethereum inbox contract
#[derive(Debug)]
pub struct EthereumInbox<M>
where
    M: ethers::providers::Middleware,
{
    contract: Arc<EthereumInboxInternal<M>>,
    domain: u32,
    name: String,
    provider: Arc<M>,
}

impl<M> EthereumInbox<M>
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
    ) -> Self {
        Self {
            contract: Arc::new(EthereumInboxInternal::new(address, provider.clone())),
            domain: *domain,
            name: name.to_owned(),
            provider,
        }
    }
}

#[async_trait]
impl<M> AbacusCommon for EthereumInbox<M>
where
    M: ethers::providers::Middleware + 'static,
{
    fn local_domain(&self) -> u32 {
        self.domain
    }

    fn name(&self) -> &str {
        &self.name
    }

    #[tracing::instrument(err)]
    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        let receipt_opt = self
            .contract
            .client()
            .get_transaction_receipt(txid)
            .await
            .map_err(|e| Box::new(e) as Box<dyn StdError + Send + Sync>)?;

        Ok(receipt_opt.map(Into::into))
    }

    #[tracing::instrument(err)]
    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        Ok(self.contract.validator_manager().call().await?.into())
    }

    #[tracing::instrument(err)]
    async fn checkpointed_root(&self) -> Result<H256, ChainCommunicationError> {
        Ok(self.contract.checkpointed_root().call().await?.into())
    }

    #[tracing::instrument(err, skip(self))]
    async fn latest_checkpoint(&self) -> Result<Checkpoint, ChainCommunicationError> {
        let (root, index) = self.contract.latest_checkpoint().call().await?;
        Ok(Checkpoint {
            // This is inefficient, but latest_checkpoint should never be called
            outbox_domain: self.remote_domain().await?,
            root: root.into(),
            index: index.as_u32(),
        })
    }
}

#[async_trait]
impl<M> Inbox for EthereumInbox<M>
where
    M: ethers::providers::Middleware + 'static,
{
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError> {
        Ok(self.contract.remote_domain().call().await?)
    }

    #[tracing::instrument(err)]
    async fn prove(&self, proof: &Proof) -> Result<TxOutcome, ChainCommunicationError> {
        let mut sol_proof: [[u8; 32]; 32] = Default::default();
        sol_proof
            .iter_mut()
            .enumerate()
            .for_each(|(i, elem)| *elem = proof.path[i].to_fixed_bytes());

        let tx = self
            .contract
            .prove(proof.leaf.into(), sol_proof, proof.index.into());

        Ok(report_tx!(tx).into())
    }

    #[tracing::instrument(err)]
    async fn process(&self, message: &AbacusMessage) -> Result<TxOutcome, ChainCommunicationError> {
        let tx = self.contract.process(message.to_vec().into());
        let gas = tx.estimate_gas().await?.saturating_add(U256::from(100000));
        let gassed = tx.gas(gas);
        Ok(report_tx!(gassed).into())
    }

    #[tracing::instrument(err)]
    async fn prove_and_process(
        &self,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        let mut sol_proof: [[u8; 32]; 32] = Default::default();
        sol_proof
            .iter_mut()
            .enumerate()
            .for_each(|(i, elem)| *elem = proof.path[i].to_fixed_bytes());

        //
        let tx =
            self.contract
                .prove_and_process(message.to_vec().into(), sol_proof, proof.index.into());
        let gas = tx.estimate_gas().await?.saturating_add(U256::from(100000));
        let gassed = tx.gas(gas);
        Ok(report_tx!(gassed).into())
    }

    #[tracing::instrument(err)]
    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        let status = self.contract.messages(leaf.into()).call().await?;
        match status {
            0 => Ok(MessageStatus::None),
            1 => Ok(MessageStatus::Proven),
            2 => Ok(MessageStatus::Processed),
            _ => panic!("Bad status from solidity"),
        }
    }

    #[tracing::instrument(err, skip(self), fields(hex_signature = %format!("0x{}", hex::encode(signed_checkpoint.signature.to_vec()))))]
    async fn submit_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpoint,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        let tx = self.contract.checkpoint(
            signed_checkpoint.checkpoint.root.to_fixed_bytes(),
            signed_checkpoint.checkpoint.index.into(),
            signed_checkpoint.signature.to_vec().into(),
        );

        Ok(report_tx!(tx).into())
    }
}
