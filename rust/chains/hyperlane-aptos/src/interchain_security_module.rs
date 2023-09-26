use async_trait::async_trait;
use num_traits::cast::FromPrimitive;
use solana_sdk::signature::Keypair;
use tracing::warn;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, InterchainSecurityModule, ModuleType, H256, U256,
};

use crate::utils;
use crate::AptosClient;
use crate::ConnectionConf;

use aptos_sdk::types::account_address::AccountAddress;

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
        let package_address =
            AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
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
        Box::new(crate::AptosHpProvider::new(
            self.domain.clone(),
            self.aptos_client.path_prefix_string(),
        ))
    }
}

#[async_trait]
impl InterchainSecurityModule for AptosInterchainSecurityModule {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let view_response = utils::send_view_request(
            &self.aptos_client,
            self.package_address.to_hex_literal(),
            "multisig_ism".to_string(),
            "get_module_type".to_string(),
            vec![],
            vec![],
        )
        .await?;

        let view_result: u64 = serde_json::from_str::<String>(&view_response[0].to_string())
            .unwrap()
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
        // TODO: Implement this once we have aggregation ISM support in Aptos
        Ok(Some(U256::zero()))
    }
}
