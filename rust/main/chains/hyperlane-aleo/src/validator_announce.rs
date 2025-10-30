use std::{str::FromStr, sync::OnceLock};

use crate::{
    to_h256, AleoEthAddress, AleoMailboxStruct, AleoMessage, AleoProvider, AleoSigner,
    ConnectionConf, CurrentNetwork, Delivery, HttpClient, HyperlaneAleoError, StorageLocationKey,
};
use aleo_serialize::AleoSerialize;
use async_trait::async_trait;
use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox, ReorgPeriod,
    SignedType, TxCostEstimate, TxOutcome, ValidatorAnnounce, H128, H160, H256, U256,
};
use snarkvm::prelude::Itertools;
use snarkvm::prelude::{
    Address, Boolean, FromBytes, Literal, Plaintext, ProgramID, TestnetV0, U128, U32, U8,
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
    /// TODO: parse settings
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
                bytes: bytes.as_fixed_bytes().map(|x| U8::<CurrentNetwork>::new(x)),
            };
            let plaintext = validator.to_plaintext().map_err(HyperlaneAleoError::from)?;
            let last_sequence: ChainResult<U8<CurrentNetwork>> = self
                .provider
                .get_mapping_value(&self.program, "storage_sequences", &plaintext.to_string())
                .await;
            if last_sequence.is_err() {
                storage_locations.push(Vec::new());
                continue;
            }
            let last_sequence = last_sequence.unwrap();
            let mut validator_locations = Vec::new();
            for index in 0..*last_sequence {
                let key = StorageLocationKey {
                    validator: validator.bytes.clone(),
                    index: U8::new(index),
                };
                let plaintext = key.to_plaintext().map_err(HyperlaneAleoError::from)?;

                let location: [U8<CurrentNetwork>; 480] = self
                    .provider
                    .get_mapping_value(&self.program, "storage_locations", &plaintext.to_string())
                    .await?;

                // Convert [U8; 480] into a UTF-8 string (trim trailing nulls)
                let bytes = location.map(|b| *b);
                let end = bytes
                    .iter()
                    .rposition(|&c| c != 0)
                    .map(|i| i + 1)
                    .unwrap_or(0);
                let location = String::from_utf8(bytes[..end].to_vec()).unwrap_or_default();
                validator_locations.push(location);
            }
            storage_locations.push(validator_locations);
        }
        Ok(storage_locations)
    }

    /// Announce a storage location for a validator
    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let program_id = ProgramID::<CurrentNetwork>::from_str(&self.program)
            .map_err(HyperlaneAleoError::from)?;
        let validator = announcement
            .value
            .validator
            .as_fixed_bytes()
            .map(|x| U8::<CurrentNetwork>::new(x))
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;

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
        let storage_location = storage_location
            .to_plaintext()
            .map_err(HyperlaneAleoError::from)?;

        let sig = announcement
            .signature
            .to_vec()
            .iter()
            .map(|x| U8::<CurrentNetwork>::new(*x))
            .collect_vec();
        let sig: [_; 65] = sig.try_into().map_err(|_| {
            ChainCommunicationError::from_other_str("Expected 65 byte long signature length")
        })?;
        let sig = sig.to_plaintext().map_err(HyperlaneAleoError::from)?;

        let outcome = self
            .provider
            .submit_tx(
                &program_id,
                vec![validator, storage_location, sig],
                "announce",
            )
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
        Some(U256::zero())
    }
}
