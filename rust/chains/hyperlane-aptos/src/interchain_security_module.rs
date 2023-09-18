use async_trait::async_trait;
use num_traits::cast::FromPrimitive;
use solana_sdk::{signature::Keypair};
use tracing::warn;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, ModuleType, H256, U256,
};

use crate::ConnectionConf;
use crate::AptosClient;
use aptos_sdk::{
  types::account_address::AccountAddress,
  rest_client::aptos_api_types::{ViewRequest, EntryFunctionId},
};

use std::str::FromStr;

/// A reference to an InterchainSecurityModule contract on some Sealevel chain
#[allow(unused)]
#[derive(Debug)]
pub struct AptosInterchainSecurityModule {
    aptos_client: AptosClient,
    package_address: AccountAddress,
    payer: Option<Keypair>,
    domain: HyperlaneDomain,
}

impl AptosInterchainSecurityModule {
    /// Create a new sealevel InterchainSecurityModule
    pub fn new(conf: &ConnectionConf, locator: ContractLocator, payer: Option<Keypair>) -> Self {
        let aptos_client = AptosClient::new(conf.url.to_string());
        let package_address = AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        Self {
            aptos_client,
            payer,
            package_address,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for AptosInterchainSecurityModule {
    fn address(&self) -> H256 {
        self.package_address.into_bytes().into()
    }
}

impl HyperlaneChain for AptosInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        Box::new(crate::AptosHpProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl InterchainSecurityModule for AptosInterchainSecurityModule {
    async fn module_type(&self) -> ChainResult<ModuleType> {
      
      tracing::warn!("ism package address {}", (self.package_address.to_hex_literal()));

      let view_response = self.aptos_client.view(
        &ViewRequest {
          function: EntryFunctionId::from_str(
            &format!(
              "{}::multisig_ism::get_module_type", 
              self.package_address.to_hex_literal()
            )
          ).unwrap(),
          type_arguments: vec![],
          arguments: vec![]
        },
        Option::None
      )
      .await
      .map_err(ChainCommunicationError::from_other)?;
      
      let view_result: u64 = serde_json::from_str::<String>(
        &view_response.inner()[0].to_string()
      ).unwrap()
      .parse()
      .unwrap();
    
      if let Some(module_type) = ModuleType::from_u64(view_result) {
        Ok(module_type)
      } else {
        warn!(%view_result, "Unknown module type");
        Ok(ModuleType::Unused)
      }
    }

    async fn dry_run_verify(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        // TODO: Implement this once we have aggregation ISM support in Sealevel
        Ok(Some(U256::zero()))
    }
}