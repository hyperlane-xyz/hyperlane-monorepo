use std::ffi::CStr;

use async_trait::async_trait;
use snarkvm::prelude::Itertools;
use snarkvm::prelude::U8;

use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome,
    ValidatorAnnounce, H160, H256, U256,
};

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
        return Self {
            provider,
            address: locator.address,
            program: conf.validator_announce_program.clone(),
            domain: locator.domain.clone(),
        };
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
                    validator: validator.bytes.clone(),
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
        let validator = *announcement.value.validator.as_fixed_bytes();

        let storage_location = announcement
            .value
            .storage_location
            .as_bytes()
            .into_iter()
            .map(|x| U8::<CurrentNetwork>::new(*x))
            .collect_vec();
        let storage_location: [_; 480] = storage_location.try_into().map_err(|_| {
            ChainCommunicationError::from_other_str(
                "Aleo expects validator storage locations to be length 480",
            )
        })?;

        let sig = announcement
            .signature
            .to_vec()
            .iter()
            .map(|x| U8::<CurrentNetwork>::new(*x))
            .collect_vec();
        let sig: [_; 65] = sig.try_into().map_err(|_| {
            ChainCommunicationError::from_other_str("Expected 65 byte long signature length")
        })?;

        let outcome = self
            .provider
            .submit_tx(
                &self.program,
                aleo_args![validator, storage_location, sig]?,
                "announce",
            )
            .await?;
        Ok(outcome)
    }

    /// Returns the number of additional tokens needed to pay for the announce
    /// transaction. Return `None` if the needed tokens cannot be determined.
    async fn announce_tokens_needed(
        &self,
        _announcement: SignedType<Announcement>,
        _chain_signer: H256,
    ) -> Option<U256> {
        // TODO:
        Some(U256::zero())
    }
}
