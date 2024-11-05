use crate::{
    contracts::validator_announce::ValidatorAnnounce as FuelVAContract, conversions::*,
    ConnectionConf, FuelProvider,
};
use async_trait::async_trait;
use fuels::{
    prelude::WalletUnlocked,
    programs::calls::Execution,
    tx::{Receipt, ScriptExecutionResult},
    types::{bech32::Bech32ContractId, Address, Bits256, Bytes},
};
use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome,
    ValidatorAnnounce, H256, H512, U256,
};
use tracing::trace;

/// A reference to a ValidatorAnnounce contract on some Fuel chain
#[derive(Debug)]
pub struct FuelValidatorAnnounce {
    contract: FuelVAContract<WalletUnlocked>,
    domain: HyperlaneDomain,
    provider: FuelProvider,
}

impl FuelValidatorAnnounce {
    /// Create a new fuel validator announce contract
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelValidatorAnnounce {
            contract: FuelVAContract::new(address, wallet),
            domain: locator.domain.clone(),
            provider: fuel_provider,
        })
    }
}

impl HyperlaneContract for FuelValidatorAnnounce {
    fn address(&self) -> H256 {
        self.contract.contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl ValidatorAnnounce for FuelValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        self.contract
            .methods()
            .get_announced_storage_locations(
                validators.iter().map(|v| Bits256::from_h256(v)).collect(),
            )
            .simulate(Execution::StateReadOnly)
            .await
            .map(|res| res.value)
            .map_err(ChainCommunicationError::from_other)
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let gas_price = self.provider.get_gas_price().await?;
        let call_res = self
            .contract
            .methods()
            .announce(
                announcement.value.validator.into_evm_address(),
                announcement.value.storage_location,
                Bytes(announcement.signature.to_vec()),
            )
            .call()
            .await
            .map_err(ChainCommunicationError::from_other)?;

        // Extract transaction success from the receipts
        let success = call_res
            .receipts
            .iter()
            .filter_map(|r| match r {
                Receipt::ScriptResult { result, .. } => Some(result),
                _ => None,
            })
            .any(|result| matches!(result, ScriptExecutionResult::Success));

        let tx_id = H512::from(call_res.tx_id.unwrap().into_h256());
        Ok(TxOutcome {
            transaction_id: tx_id,
            executed: success,
            gas_used: call_res.gas_used.into(),
            gas_price: gas_price.into(),
        })
    }

    async fn announce_tokens_needed(&self, announcement: SignedType<Announcement>) -> Option<U256> {
        let tolerance = Some(0.0);
        let block_horizon = Some(1);

        let cost_estimation = self
            .contract
            .methods()
            .announce(
                announcement.value.validator.into_evm_address(),
                announcement.value.storage_location,
                Bytes(announcement.signature.to_vec()),
            )
            .estimate_transaction_cost(tolerance, block_horizon)
            .await;

        let signer = Address::from(self.contract.account().address()).to_string();
        let signer_balance = self.provider.get_balance(signer).await.unwrap();

        match cost_estimation {
            Ok(cost) => {
                let max_cost = U256::from(cost.total_fee);
                return Some(max_cost.saturating_sub(signer_balance));
            }
            Err(err) => {
                trace!("Failed to estimate transaction cost: {:?}", err);
                return None;
            }
        }
    }
}
