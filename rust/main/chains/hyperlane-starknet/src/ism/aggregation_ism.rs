#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::{
    AggregationIsm, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, H256,
};
use starknet::accounts::SingleOwnerAccount;
use starknet::core::types::FieldElement;
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::aggregation_ism::{
    AggregationIsm as StarknetAggregationIsmInternal, Message as StarknetMessage,
};
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{build_single_owner_account, ConnectionConf, Signer, StarknetProvider};

/// A reference to a AggregationISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetAggregationIsm {
    contract: StarknetAggregationIsmInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>,
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
            contract,
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
