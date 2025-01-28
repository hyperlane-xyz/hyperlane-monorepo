use async_trait::async_trait;
use num_traits::cast::FromPrimitive;
use solana_sdk::{instruction::Instruction, pubkey::Pubkey, signature::Keypair, signer::Signer};
use tracing::warn;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, ModuleType, H256, U256,
};
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
use serializable_account_meta::SimulationReturnData;

use crate::{ConnectionConf, SealevelProvider, SealevelRpcClient};

/// A reference to an InterchainSecurityModule contract on some Sealevel chain
pub struct SealevelInterchainSecurityModule {
    payer: Option<Keypair>,
    program_id: Pubkey,
    provider: SealevelProvider,
}

impl SealevelInterchainSecurityModule {
    /// Create a new sealevel InterchainSecurityModule
    pub fn new(conf: &ConnectionConf, locator: ContractLocator, payer: Option<Keypair>) -> Self {
        let provider = SealevelProvider::new(locator.domain.clone(), conf);
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            payer,
            program_id,
            provider,
        }
    }

    fn rpc(&self) -> &SealevelRpcClient {
        self.provider.rpc()
    }
}

impl HyperlaneContract for SealevelInterchainSecurityModule {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        self.provider.provider()
    }
}

#[async_trait]
impl InterchainSecurityModule for SealevelInterchainSecurityModule {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &InterchainSecurityModuleInstruction::Type
                .encode()
                .map_err(ChainCommunicationError::from_other)?[..],
            vec![],
        );

        let module = self
            .rpc()
            .simulate_instruction::<SimulationReturnData<u32>>(
                self.payer
                    .as_ref()
                    .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?,
                instruction,
            )
            .await?
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("No return data was returned from the ISM")
            })?
            .return_data;

        if let Some(module_type) = ModuleType::from_u32(module) {
            Ok(module_type)
        } else {
            warn!(%module, "Unknown module type");
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

impl std::fmt::Debug for SealevelInterchainSecurityModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        #[allow(dead_code)]
        #[derive(Debug)]
        struct PublicKey {
            base58_pubkey: String,
        }

        #[allow(dead_code)]
        #[derive(Debug)]
        struct SealevelInterchainSecurityModule<'a> {
            payer: Option<PublicKey>,
            program_id: &'a Pubkey,
            provider: &'a SealevelProvider,
        }

        let payer = self.payer.as_ref().map(|s| PublicKey {
            base58_pubkey: s.pubkey().to_string(),
        });
        let val = SealevelInterchainSecurityModule {
            payer,
            program_id: &self.program_id,
            provider: &self.provider,
        };
        std::fmt::Debug::fmt(&val, f)
    }
}

#[cfg(test)]
mod test {
    use std::str::FromStr;

    use hyperlane_core::{
        config::OperationBatchConfig, HyperlaneDomain, KnownHyperlaneDomain, NativeToken,
    };
    use solana_sdk::{signature::Keypair, signer::Signer};
    use url::Url;

    use crate::{
        ConnectionConf, PriorityFeeOracleConfig, SealevelProvider, TransactionSubmitterConfig,
    };

    use super::SealevelInterchainSecurityModule;

    #[test]
    fn test_no_exposed_secret_key() {
        let priv_key = "2ckDxzDFpZGeWd7VbHzd6dMgxYpqVDPA8XzeXFuuUJ1K8CjtyTBenD1TSPPovahXEFw3kBihoyAKktyro22MP4bN";
        let pub_key = "6oKnHXD2LRzQ4iNsgvkGSNNx68vj5GCYYpR2icy5JZhE";

        let keypair = Keypair::from_base58_string(priv_key);

        let program_id = keypair.pubkey();

        let value = SealevelInterchainSecurityModule {
            payer: Some(keypair),
            program_id,
            provider: SealevelProvider::new(
                HyperlaneDomain::Known(KnownHyperlaneDomain::SolanaMainnet),
                &ConnectionConf {
                    url: Url::from_str("https://solscan.io").expect("Failed to parse URL"),
                    operation_batch: OperationBatchConfig::default(),
                    native_token: NativeToken::default(),
                    priority_fee_oracle: PriorityFeeOracleConfig::Constant(0),
                    transaction_submitter: TransactionSubmitterConfig::Rpc { url: None },
                },
            ),
        };

        let expected = format!(
            r#"SealevelInterchainSecurityModule {{ payer: Some(PublicKey {{ base58_pubkey: "{pub_key}" }}), program_id: {pub_key}, provider: SealevelProvider {{ domain: HyperlaneDomain(solanamainnet (1399811149)), rpc_client: RpcClient {{ ... }}, native_token: NativeToken {{ decimals: 0, denom: "" }} }} }}"#
        );
        let actual = format!("{:?}", value);
        assert_eq!(expected, actual);
    }
}
