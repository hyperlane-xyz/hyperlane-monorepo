#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, H256,
};
use starknet::accounts::SingleOwnerAccount;
use starknet::core::types::FieldElement;
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::multisig_ism::MultisigIsm as StarknetMultisigIsmInternal;
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{build_single_owner_account, ConnectionConf, Signer, StarknetProvider};

/// A reference to a MultisigISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetMultisigIsm {
    contract: StarknetMultisigIsmInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetMultisigIsm {
    /// Create a reference to a MultisigISM at a specific Starknet address on some
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

        let contract = StarknetMultisigIsmInternal::new(ism_address, account);

        Ok(Self {
            contract,
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
