use async_trait::async_trait;

use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};
use tracing::{info, instrument, warn};

use crate::{
    solana::{commitment_config::CommitmentConfig, pubkey::Pubkey},
    validator_storage_locations_pda_seeds, ConnectionConf, RpcClientWithDebug,
};

/// A reference to a ValidatorAnnounce contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelValidatorAnnounce {
    program_id: Pubkey,
    rpc_client: RpcClientWithDebug,
    domain: HyperlaneDomain,
}

impl SealevelValidatorAnnounce {
    /// Create a new Sealevel ValidatorAnnounce
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> Self {
        let rpc_client = RpcClientWithDebug::new(conf.url.to_string());
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            program_id,
            rpc_client,
            domain: locator.domain.clone(),
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
        Box::new(crate::SealevelProvider::new(self.domain.clone()))
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
            .rpc_client
            .get_multiple_accounts_with_commitment(&account_pubkeys, CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value;

        // Parse the storage locations from each account.
        // If a validator's account doesn't exist, its storage locations will
        // be returned as an empty list.
        let storage_locations: Vec<Vec<String>> = accounts
            .into_iter()
            .map(|account| {
                account
                    .map(|account| {
                        match contract::ValidatorStorageLocationsAccount::fetch(
                            &mut &account.data[..],
                        ) {
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
    ) -> Option<U256> {
        Some(U256::zero())
    }

    #[instrument(err, ret, skip(self))]
    async fn announce(
        &self,
        _announcement: SignedType<Announcement>,
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        warn!(
            "Announcing validator storage locations within the agents is not supported on Sealevel"
        );
        Ok(TxOutcome {
            txid: H256::zero(),
            executed: false,
            gas_used: U256::zero(),
            gas_price: U256::zero(),
        })
    }
}

// Copied from the validator-announce contract
mod contract {
    use crate::mailbox::contract::AccountData;
    use borsh::{BorshDeserialize, BorshSerialize};

    /// An account that holds a validator's announced storage locations.
    /// It is a PDA based off the validator's address, and can therefore
    /// hold up to 10 KiB of data.
    pub type ValidatorStorageLocationsAccount = AccountData<ValidatorStorageLocations>;

    /// Storage locations for a validator.
    #[derive(BorshSerialize, BorshDeserialize, Debug, Default, Clone, PartialEq, Eq)]
    pub struct ValidatorStorageLocations {
        pub bump_seed: u8,
        pub storage_locations: Vec<String>,
    }

    /// PDA seeds for validator-specific ValidatorStorageLocations accounts.
    #[macro_export]
    macro_rules! validator_storage_locations_pda_seeds {
        ($validator_h160:expr) => {{
            &[
                b"hyperlane_validator_announce",
                b"-",
                b"storage_locations",
                b"-",
                $validator_h160.as_bytes(),
            ]
        }};

        ($validator_h160:expr, $bump_seed:expr) => {{
            &[
                b"hyperlane_validator_announce",
                b"-",
                b"storage_locations",
                b"-",
                $validator_h160.as_bytes(),
                &[$bump_seed],
            ]
        }};
    }
}
