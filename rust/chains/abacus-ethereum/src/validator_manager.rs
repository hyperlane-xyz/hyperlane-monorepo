#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::fmt::Display;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::abi::AbiEncode;
use ethers::prelude::*;
use ethers_contract::builders::ContractCall;
use eyre::Result;

use abacus_core::{
    accumulator::merkle::Proof, AbacusMessage, ChainCommunicationError, ContractLocator, Encode,
    InboxValidatorManager, MultisigSignedCheckpoint, TxOutcome,
};

use crate::contracts::inbox_validator_manager::{
    InboxValidatorManager as EthereumInboxValidatorManagerInternal, ProcessCall,
};
use crate::trait_builder::MakeableWithProvider;
use crate::tx::report_tx;

pub use crate::contracts::inbox_validator_manager::INBOXVALIDATORMANAGER_ABI;

impl<M> Display for EthereumInboxValidatorManagerInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct InboxValidatorManagerBuilder {
    pub inbox_address: Address,
}

impl MakeableWithProvider for InboxValidatorManagerBuilder {
    type Output = Box<dyn InboxValidatorManager>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInboxValidatorManager::new(
            Arc::new(provider),
            locator,
            self.inbox_address,
        ))
    }
}

/// A struct that provides access to an Ethereum InboxValidatorManager contract
#[derive(Debug)]
pub struct EthereumInboxValidatorManager<M>
where
    M: Middleware,
{
    contract: Arc<EthereumInboxValidatorManagerInternal<M>>,
    #[allow(unused)]
    domain: u32,
    #[allow(unused)]
    chain_name: String,
    #[allow(unused)]
    provider: Arc<M>,
    inbox_address: Address,
}

impl<M> EthereumInboxValidatorManager<M>
where
    M: Middleware,
{
    /// Create a reference to a inbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator, inbox_address: Address) -> Self {
        Self {
            contract: Arc::new(EthereumInboxValidatorManagerInternal::new(
                &locator.address,
                provider.clone(),
            )),
            domain: locator.domain,
            chain_name: locator.chain_name.to_owned(),
            provider,
            inbox_address,
        }
    }
}

#[async_trait]
impl<M> InboxValidatorManager for EthereumInboxValidatorManager<M>
where
    M: Middleware + 'static,
{
    #[tracing::instrument(skip(self))]
    async fn process(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        let contract_call = self
            .process_contract_call(multisig_signed_checkpoint, message, proof)
            .await?;
        let receipt = report_tx(contract_call).await?;
        Ok(receipt.into())
    }

    async fn process_tx(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TransactionRequest, ChainCommunicationError> {
        let contract_call = self
            .process_contract_call(multisig_signed_checkpoint, message, proof)
            .await?;

        Ok(contract_call.tx.into())
    }

    fn process_calldata(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Vec<u8> {
        // IInbox _inbox,
        // bytes32 _root,
        // uint256 _index,
        // bytes[] calldata _signatures,
        // bytes calldata _message,
        // bytes32[32] calldata _proof,
        // uint256 _leafIndex

        let mut sol_proof: [[u8; 32]; 32] = Default::default();
        sol_proof
            .iter_mut()
            .enumerate()
            .for_each(|(i, elem)| *elem = proof.path[i].to_fixed_bytes());

        let process_call = ProcessCall {
            inbox: self.inbox_address,
            root: multisig_signed_checkpoint.checkpoint.root.to_fixed_bytes(),
            index: multisig_signed_checkpoint.checkpoint.index.into(),
            signatures: multisig_signed_checkpoint
                .signatures
                .iter()
                .map(|s| s.to_vec().into())
                .collect(),
            message: message.to_vec().into(),
            proof: sol_proof,
            leaf_index: proof.index.into(),
        };

        process_call.encode()

        // self.contract.encode(
        //     "process",
        //     [
        //         Token::Address(self.inbox_address),
        //         Token::FixedBytes(
        //             multisig_signed_checkpoint
        //                 .checkpoint
        //                 .root
        //                 .to_fixed_bytes()
        //                 .into(),
        //         ),
        //         Token::Uint(multisig_signed_checkpoint.checkpoint.index.into()),
        //         Token::Array(
        //             multisig_signed_checkpoint
        //                 .signatures
        //                 .iter()
        //                 .map(|s| Token::Bytes(s.to_vec()))
        //                 .collect(),
        //         ),
        //         Token::Bytes(message.to_vec()),
        //         Token::FixedArray(
        //             proof.path[0..32]
        //                 .iter()
        //                 .map(|e| Token::FixedBytes(e.to_vec()))
        //                 .collect(),
        //         ),
        //         Token::Uint(proof.index.into()),
        //     ],
        // )
    }

    fn contract_address(&self) -> abacus_core::Address {
        self.contract.address().into()
    }
}

impl<M> EthereumInboxValidatorManager<M>
where
    M: Middleware + 'static,
{
    async fn process_contract_call(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<ContractCall<M, ()>, ChainCommunicationError> {
        let mut sol_proof: [[u8; 32]; 32] = Default::default();
        sol_proof
            .iter_mut()
            .enumerate()
            .for_each(|(i, elem)| *elem = proof.path[i].to_fixed_bytes());

        let tx = self.contract.process(
            self.inbox_address,
            multisig_signed_checkpoint.checkpoint.root.to_fixed_bytes(),
            multisig_signed_checkpoint.checkpoint.index.into(),
            multisig_signed_checkpoint
                .signatures
                .iter()
                .map(|s| s.to_vec().into())
                .collect(),
            message.to_vec().into(),
            sol_proof,
            proof.index.into(),
        );
        let gas = tx.estimate_gas().await?.saturating_add(U256::from(100000));
        let gassed = tx.gas(gas);
        Ok(gassed)
    }
}
