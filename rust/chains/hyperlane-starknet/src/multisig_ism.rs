#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::MultisigIsm;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, H256,
};
use starknet::accounts::SingleOwnerAccount;
use starknet::core::types::FieldElement;
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::multisig_ism::{
    Bytes as StarknetBytes, Message as StarknetMessage, MultisigIsm as StarknetMultisigIsmInternal,
};
use crate::error::HyperlaneStarknetError;
use crate::{build_single_owner_account, ConnectionConf, Signer, StarknetProvider};

impl<A> std::fmt::Display for StarknetMultisigIsmInternal<A>
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
pub struct StarknetMultisigIsm {
    contract: Arc<StarknetMultisigIsmInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetMultisigIsm {
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

        let contract = StarknetMultisigIsmInternal::new(
            FieldElement::from_bytes_be(&locator.address.to_fixed_bytes())
                .map_err(HyperlaneStarknetError::BytesConversionError)?,
            account,
        );

        Ok(Self {
            contract: Arc::new(contract),
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }

    #[allow(unused)]
    pub fn contract(
        &self,
    ) -> &StarknetMultisigIsmInternal<SingleOwnerAccount<AnyProvider, LocalWallet>> {
        &self.contract
    }
}

impl HyperlaneChain for StarknetMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetMultisigIsm {
    fn address(&self) -> H256 {
        H256::from_slice(self.contract.address.to_bytes_be().as_slice())
    }
}

#[async_trait]
impl MultisigIsm for StarknetMultisigIsm {
    #[instrument(err)]
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let message = &StarknetMessage {
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
        };
        let (validator_addresses, threshold) = self
            .contract
            .validators_and_threshold(message)
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok((
            validator_addresses
                .iter()
                .map(|v| H256::from_slice(v.address.0.to_bytes_be().as_slice()))
                .collect(),
            threshold as u8,
        ))
    }
}

pub struct StarknetMultisigIsmAbi;

impl HyperlaneAbi for StarknetMultisigIsmAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        todo!()
    }
}
