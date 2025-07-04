use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    SignedType, TxOutcome, ValidatorAnnounce, H160, H256, H512, U256,
};
use hyperlane_sealevel_validator_announce::{
    accounts::ValidatorStorageLocationsAccount, validator_storage_locations_pda_seeds,
};
use solana_sdk::pubkey::Pubkey;
use tracing::{info, instrument, warn};

use crate::SealevelProvider;

/// A reference to a ValidatorAnnounce contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelValidatorAnnounce {
    provider: Arc<SealevelProvider>,
    program_id: Pubkey,
    domain: HyperlaneDomain,
}

impl SealevelValidatorAnnounce {
    /// Create a new Sealevel ValidatorAnnounce
    pub fn new(provider: Arc<SealevelProvider>, locator: &ContractLocator) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            program_id,
            domain: locator.domain.clone(),
            provider,
        }
    }
}

impl HyperlaneContract for SealevelValidatorAnnounce {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl ValidatorAnnounce for SealevelValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        info!(program_id=?self.program_id, validators=?validators, "Getting validator storage locations");

        // Get the validator storage location PDAs for each validator.
        let account_pubkeys: Vec<Pubkey> = validators
            .iter()
            .map(|v| {
                let (key, _bump) = Pubkey::find_program_address(
                    // The seed is based off the H160 representation of the validator address.
                    validator_storage_locations_pda_seeds!(H160::from_slice(&v.as_bytes()[12..])),
                    &self.program_id,
                );
                key
            })
            .collect();

        // Get all validator storage location accounts.
        // If an account doesn't exist, it will be returned as None.
        let accounts = self
            .provider
            .rpc_client()
            .get_multiple_accounts_with_finalized_commitment(&account_pubkeys)
            .await?;

        // Parse the storage locations from each account.
        // If a validator's account doesn't exist, its storage locations will
        // be returned as an empty list.
        let storage_locations: Vec<Vec<String>> = accounts
            .into_iter()
            .map(|account| {
                account
                    .map(|account| {
                        match ValidatorStorageLocationsAccount::fetch(&mut &account.data[..]) {
                            Ok(v) => v.into_inner().storage_locations,
                            Err(err) => {
                                // If there's an error parsing the account, gracefully return an empty list
                                info!(?account, ?err, "Unable to parse validator announce account");
                                vec![]
                            }
                        }
                    })
                    .unwrap_or_default()
            })
            .collect();

        Ok(storage_locations)
    }

    async fn announce_tokens_needed(
        &self,
        _announcement: SignedType<Announcement>,
        _chain_signer: H256,
    ) -> Option<U256> {
        Some(U256::zero())
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn announce(&self, _announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        warn!(
            "Announcing validator storage locations within the agents is not supported on Sealevel"
        );
        Ok(TxOutcome {
            transaction_id: H512::zero(),
            executed: false,
            gas_used: U256::zero(),
            gas_price: U256::zero().try_into()?,
        })
    }
}
