use std::ffi::CStr;

use async_trait::async_trait;

use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};
use snarkvm_console_account::{Address, FromBytes};

use crate::{
    aleo_args, AleoEthAddress, AleoProvider, ConnectionConf, CurrentNetwork, HyperlaneAleoError,
    StorageLocationKey,
};

/// Aleo Ism
#[derive(Debug, Clone)]
pub struct AleoValidatorAnnounce {
    provider: AleoProvider,
    address: H256,
    program: String,
    domain: HyperlaneDomain,
}

impl AleoValidatorAnnounce {
    /// Aleo Validator Announce
    pub fn new(provider: AleoProvider, locator: &ContractLocator, conf: &ConnectionConf) -> Self {
        Self {
            provider,
            address: locator.address,
            program: conf.validator_announce_program.clone(),
            domain: locator.domain.clone(),
        }
    }
}

#[async_trait]
impl HyperlaneChain for AleoValidatorAnnounce {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for AleoValidatorAnnounce {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

impl AleoValidatorAnnounce {
    /// Get announcement inputs
    /// Converts the announcement into fixed size inputs for the Aleo announce function
    fn get_announcement_inputs(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<Vec<String>> {
        let validator = *announcement.value.validator.as_fixed_bytes();

        // Storage location as C string bytes
        let storage_location: [u8; 480] = announcement
            .value
            .storage_location
            .as_bytes()
            .try_into()
            .map_err(HyperlaneAleoError::from)?;

        let sig: [u8; 65] = announcement
            .signature
            .to_vec()
            .as_slice()
            .try_into()
            .map_err(HyperlaneAleoError::from)?;

        aleo_args!(validator, storage_location, sig)
    }
}

#[async_trait]
impl ValidatorAnnounce for AleoValidatorAnnounce {
    /// Returns the announced storage locations for the provided validators.
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let mut storage_locations = Vec::new();
        for validator in validators {
            let bytes = H160::from(*validator);
            let validator = AleoEthAddress {
                bytes: *bytes.as_fixed_bytes(),
            };
            let last_sequence: ChainResult<u8> = self
                .provider
                .get_mapping_value(&self.program, "storage_sequences", &validator)
                .await;

            let last_sequence = match last_sequence {
                Ok(value) => value,
                Err(_) => {
                    storage_locations.push(Vec::new());
                    continue;
                }
            };

            let mut validator_locations = Vec::new();
            for index in 0..last_sequence {
                let key = StorageLocationKey {
                    validator: validator.bytes,
                    index,
                };
                let location: [u8; 480] = self
                    .provider
                    .get_mapping_value(&self.program, "storage_locations", &key)
                    .await?;

                let location =
                    CStr::from_bytes_until_nul(&location).map_err(HyperlaneAleoError::from)?;
                let location = location.to_str().map_err(HyperlaneAleoError::from)?;
                validator_locations.push(location.to_owned());
            }
            storage_locations.push(validator_locations);
        }
        Ok(storage_locations)
    }

    /// Announce a storage location for a validator
    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let args = self.get_announcement_inputs(announcement)?;
        let outcome = self
            .provider
            .submit_tx(&self.program, "announce", args)
            .await?;

        Ok(outcome)
    }

    /// Returns the number of additional tokens needed to pay for the announce
    /// transaction. Return `None` if the needed tokens cannot be determined.
    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
        chain_signer: H256,
    ) -> Option<U256> {
        let address = Address::<CurrentNetwork>::from_bytes_le(chain_signer.as_bytes())
            .ok()?
            .to_string();
        let balance = self.provider.get_balance(address).await.ok()?;
        let args = self.get_announcement_inputs(announcement).ok()?;
        let estimate = self
            .provider
            .estimate_tx(&self.program, "announcer", args)
            .await
            .ok()?;
        Some(balance.saturating_sub(estimate.total_fee.into()))
    }
}
