#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use cainome::cairo_serde::U256 as StarknetU256;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType, H256, U256,
};
use starknet::accounts::SingleOwnerAccount;
use starknet::core::types::FieldElement;
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::interchain_security_module::{
    Bytes as StarknetBytes, InterchainSecurityModule as StarknetInterchainSecurityModuleInternal,
    Message as StarknetMessage,
};
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{
    build_single_owner_account, to_hpl_module_type, to_packed_bytes, ConnectionConf, Signer,
    StarknetProvider,
};

impl<A> std::fmt::Display for StarknetInterchainSecurityModuleInternal<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// A reference to a ISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetInterchainSecurityModule {
    contract:
        Arc<StarknetInterchainSecurityModuleInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetInterchainSecurityModule {
    /// Create a reference to a ISM at a specific Starknet address on some
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

        let ism_address: FieldElement = HyH256(locator.address)
            .try_into()
            .map_err(HyperlaneStarknetError::BytesConversionError)?;

        let contract = StarknetInterchainSecurityModuleInternal::new(ism_address, account);

        Ok(Self {
            contract: Arc::new(contract),
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }

    #[allow(unused)]
    pub fn contract(
        &self,
    ) -> &StarknetInterchainSecurityModuleInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>
    {
        &self.contract
    }
}

impl HyperlaneChain for StarknetInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetInterchainSecurityModule {
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
impl InterchainSecurityModule for StarknetInterchainSecurityModule {
    #[instrument(skip(self))]
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let module = self
            .contract
            .module_type()
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        Ok(to_hpl_module_type(module))
    }

    #[instrument(skip(self))]
    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        let message = &message.into();

        let tx = self.contract.verify(
            &StarknetBytes {
                size: metadata.len() as u32,
                data: to_packed_bytes(metadata),
            },
            message,
        );

        let response = tx
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        // We can't simulate the `verify` call in Starknet because
        // it's not marked as an entrypoint. So we just use the query interface
        // and hardcode a gas value - this can be inefficient if one ISM is
        // vastly cheaper than another one.
        let dummy_gas_value = U256::one();
        Ok(response.then_some(dummy_gas_value))
    }
}

pub struct StarknetInterchainSecurityModuleAbi;

impl HyperlaneAbi for StarknetInterchainSecurityModuleAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        HashMap::default()
    }
}
