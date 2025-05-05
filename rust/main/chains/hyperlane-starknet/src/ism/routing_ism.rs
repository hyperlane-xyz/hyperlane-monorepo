#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use cainome::cairo_serde::U256 as StarknetU256;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RoutingIsm, H256,
};
use starknet::accounts::SingleOwnerAccount;
use starknet::core::types::FieldElement;
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::routing_ism::{
    Bytes as StarknetBytes, Message as StarknetMessage, RoutingIsm as StarknetRoutingIsmInternal,
};
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{build_single_owner_account, ConnectionConf, Signer, StarknetProvider};

impl<A> std::fmt::Display for StarknetRoutingIsmInternal<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// A reference to a RoutingISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetRoutingIsm {
    contract: Arc<StarknetRoutingIsmInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetRoutingIsm {
    /// Create a reference to a RoutingISM at a specific Starknet address on some
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

        let contract = StarknetRoutingIsmInternal::new(ism_address, account);

        Ok(Self {
            contract: Arc::new(contract),
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }

    #[allow(unused)]
    pub fn contract(
        &self,
    ) -> &StarknetRoutingIsmInternal<SingleOwnerAccount<AnyProvider, LocalWallet>> {
        &self.contract
    }
}

impl HyperlaneChain for StarknetRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetRoutingIsm {
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
impl RoutingIsm for StarknetRoutingIsm {
    #[instrument(err)]
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let message = &message.into();

        let ism = self
            .contract
            .route(message)
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(HyH256::from(ism.0).0)
    }
}

pub struct StarknetRoutingIsmAbi;

impl HyperlaneAbi for StarknetRoutingIsmAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        HashMap::default()
    }
}
