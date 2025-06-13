#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, H256,
};
use starknet::core::types::Felt;
use tracing::instrument;

use crate::contracts::multisig_ism::MultisigIsmReader;
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{build_json_provider, ConnectionConf, JsonProvider, StarknetProvider};

/// A reference to a MultisigISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetMultisigIsm {
    contract: MultisigIsmReader<JsonProvider>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetMultisigIsm {
    /// Create a reference to a MultisigISM at a specific Starknet address on some
    /// chain
    pub async fn new(conn: &ConnectionConf, locator: &ContractLocator<'_>) -> ChainResult<Self> {
        let provider = build_json_provider(conn);
        let ism_address: Felt = HyH256(locator.address).into();
        let contract = MultisigIsmReader::new(ism_address, provider);

        Ok(Self {
            contract,
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }
}

impl HyperlaneChain for StarknetMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetMultisigIsm {
    fn address(&self) -> H256 {
        HyH256::from(self.contract.address).0
    }
}

#[async_trait]
impl MultisigIsm for StarknetMultisigIsm {
    #[instrument(err)]
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let message = &message.into();

        let (validator_addresses, threshold) = self
            .contract
            .validators_and_threshold(message)
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok((
            validator_addresses
                .iter()
                .map(|v| HyH256::from(v.0).0)
                .collect(),
            threshold as u8,
        ))
    }
}
