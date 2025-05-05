#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use cainome::cairo_serde::U256 as StarknetU256;
use hyperlane_core::{
    AggregationIsm, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, H256,
};
use starknet::accounts::SingleOwnerAccount;
use starknet::core::types::FieldElement;
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::aggregation_ism::{
    AggregationIsm as StarknetAggregationIsmInternal, Bytes as StarknetBytes,
    Message as StarknetMessage,
};
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{build_single_owner_account, ConnectionConf, Signer, StarknetProvider};

impl<A> std::fmt::Display for StarknetAggregationIsmInternal<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// A reference to a AggregationISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetAggregationIsm {
    contract: Arc<StarknetAggregationIsmInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetAggregationIsm {
    /// Create a reference to a AggregationISM at a specific Starknet address on some
    /// chain
    pub async fn new(
        conn: &ConnectionConf,
        locator: &ContractLocator<'_>,
        signer: Signer,
    ) -> ChainResult<Self> {
        let account =
            build_single_owner_account(&conn.url, signer.local_wallet(), &signer.address, false)
                .await?;

        let ism_address: FieldElement = HyH256(locator.address)
            .try_into()
            .map_err(HyperlaneStarknetError::BytesConversionError)?;

        let contract = StarknetAggregationIsmInternal::new(ism_address, account);

        Ok(Self {
            contract: Arc::new(contract),
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }

    #[allow(unused)]
    pub fn contract(
        &self,
    ) -> &StarknetAggregationIsmInternal<SingleOwnerAccount<AnyProvider, LocalWallet>> {
        &self.contract
    }
}

impl HyperlaneChain for StarknetAggregationIsm {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetAggregationIsm {
    fn address(&self) -> H256 {
        HyH256::from(self.contract.address).0
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
            body: StarknetBytes {
                size: message.body.len() as u32,
                data: message.body.iter().map(|b| *b as u128).collect(),
            },
        }
    }
}

#[async_trait]
impl AggregationIsm for StarknetAggregationIsm {
    #[instrument(err)]
    async fn modules_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let message: StarknetMessage = message.into();

        let (isms, threshold) = self
            .contract
            .modules_and_threshold(&message)
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        let isms_h256 = isms
            .iter()
            .map(|address| HyH256::from(address.0).0)
            .collect();

        Ok((isms_h256, threshold))
    }
}

pub struct StarknetAggregationIsmAbi;

impl HyperlaneAbi for StarknetAggregationIsmAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        HashMap::default()
    }
}
