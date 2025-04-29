use async_trait::async_trait;
use fuels::{
    accounts::ViewOnlyAccount,
    programs::calls::Execution,
    tx::{Receipt, ScriptExecutionResult},
    types::{bech32::Bech32ContractId, Address, Bits256, Bytes},
};
use tracing::trace;

use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome,
    ValidatorAnnounce, H256, H512, U256,
};

use crate::{
    contracts::validator_announce::ValidatorAnnounce as FuelVAContract, conversions::*,
    wallet::FuelWallets, ConnectionConf, FuelProvider,
};

/// A reference to a ValidatorAnnounce contract on some Fuel chain
#[derive(Debug)]
pub struct FuelValidatorAnnounce {
    contract: FuelVAContract<FuelWallets>,
    domain: HyperlaneDomain,
    provider: FuelProvider,
}

impl FuelValidatorAnnounce {
    /// Create a new fuel validator announce contract
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: FuelWallets,
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
            .get_announced_storage_locations(validators.iter().map(Bits256::from_h256).collect())
            .simulate(Execution::state_read_only())
            .await
            .map(|res| res.value)
            .map_err(|e| {
                ChainCommunicationError::from_other_str(format!(
                    "Failed to fetch announced storage locations from ValidatorAnnounce contract at 0x{:?} - {:?}",
                    self.contract.contract_id().hash,
                    e
                ).as_str())
            })
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
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                    "Failed to announce validator in ValidatorAnnounce contract at 0x{:?} - {:?}",
                    self.contract.contract_id().hash,
                    e
                )
                    .as_str(),
                )
            })?;

        // Extract transaction success from the receipts
        let success = call_res
            .tx_status
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
            gas_used: call_res.tx_status.total_gas.into(),
            gas_price: gas_price.into(),
        })
    }

    async fn announce_tokens_needed(&self, announcement: SignedType<Announcement>) -> Option<U256> {
        let simulate_call = self
            .contract
            .methods()
            .announce(
                announcement.value.validator.into_evm_address(),
                announcement.value.storage_location,
                Bytes(announcement.signature.to_vec()),
            )
            .simulate(Execution::realistic())
            .await;

        match simulate_call {
            Ok(simulation) => {
                let signer = Address::from(self.contract.account().address()).to_string();
                let signer_balance = self.provider.get_balance(signer).await;
                if let Err(err) = signer_balance {
                    trace!("Failed to get signer balance: {:?}", err);
                    return None;
                }
                Some(
                    U256::from(simulation.tx_status.total_gas)
                        .saturating_sub(signer_balance.unwrap()),
                )
            }
            Err(err) => {
                trace!("Failed to simulate validator announcement: {:?}", err);
                return None;
            }
        }
    }
}
