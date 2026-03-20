use std::ffi::CStr;

use async_trait::async_trait;

use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};
use snarkvm_console_account::{Address, FromBytes};
use tracing::debug;

use crate::{
    aleo_args,
    provider::{AleoClient, FallbackHttpClient},
    AleoEthAddress, AleoProvider, ConnectionConf, CurrentNetwork, HyperlaneAleoError,
    StorageLocationKey,
};

/// Aleo Validator Announce
#[derive(Debug, Clone)]
pub struct AleoValidatorAnnounce<C: AleoClient = FallbackHttpClient> {
    provider: AleoProvider<C>,
    address: H256,
    program: String,
    domain: HyperlaneDomain,
}

impl<C: AleoClient> AleoValidatorAnnounce<C> {
    /// Aleo Validator Announce
    pub fn new(
        provider: AleoProvider<C>,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> Self {
        Self {
            provider,
            address: locator.address,
            program: conf.validator_announce_program.clone(),
            domain: locator.domain.clone(),
        }
    }
}

#[async_trait]
impl<C: AleoClient> HyperlaneChain for AleoValidatorAnnounce<C> {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl<C: AleoClient> HyperlaneContract for AleoValidatorAnnounce<C> {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

impl<C: AleoClient> AleoValidatorAnnounce<C> {
    /// Get announcement inputs
    ///
    /// Converts the announcement into fixed size inputs for the Aleo announce function.
    ///
    /// # Requirements
    /// - `storage_location` must be exactly 480 bytes (C-string format with null terminator)
    /// - `signature` must be exactly 65 bytes
    ///
    /// # Errors
    /// Returns `HyperlaneAleoError` if size conversions fail    
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
impl<C: AleoClient> ValidatorAnnounce for AleoValidatorAnnounce<C> {
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
            let last_sequence: Option<u8> = self
                .provider
                .get_mapping_value(&self.program, "storage_sequences", &validator)
                .await?;

            let last_sequence = match last_sequence {
                Some(value) => value,
                None => {
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
                let location: Option<[u8; 480]> = self
                    .provider
                    .get_mapping_value(&self.program, "storage_locations", &key)
                    .await?;
                match location {
                    None => {
                        debug!("No storage location found for validator {:?} at index {}, this should never happen!", validator, index);
                        continue;
                    }
                    Some(location) => {
                        let location = CStr::from_bytes_until_nul(&location)
                            .map_err(HyperlaneAleoError::from)?;
                        let location = location.to_str().map_err(HyperlaneAleoError::from)?;
                        validator_locations.push(location.to_owned());
                    }
                };
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
            .submit_tx_and_wait(&self.program, "announce", args)
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
            .estimate_tx(&self.program, "announce", args)
            .await
            .ok()?;
        let estimated_fee: U256 = estimate.total_fee.into();
        Some(estimated_fee.saturating_sub(balance))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{provider::mock::MockHttpClient, AleoProvider, ConnectionConf};
    use std::{path::PathBuf, str::FromStr};
    const DOMAIN: HyperlaneDomain =
        HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Abstract);

    fn connection_conf() -> ConnectionConf {
        ConnectionConf {
            rpcs: vec![url::Url::from_str("http://localhost:3030").unwrap()],
            mailbox_program: "test_mailbox.aleo".to_string(),
            hook_manager_program: "test_hook_manager.aleo".to_string(),
            ism_manager_program: "test_ism_manager.aleo".to_string(),
            validator_announce_program: "test_validator_announce.aleo".to_string(),
            chain_id: 1u16,
            priority_fee_multiplier: 0f64,
            proving_service: vec![],
        }
    }

    fn get_mock_validator_announce() -> AleoValidatorAnnounce<MockHttpClient> {
        let base_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/mailbox/mock_responses");
        let client: MockHttpClient = MockHttpClient::new(base_path);

        let provider = AleoProvider::with_client(client, DOMAIN, 0u16, None);

        provider.register_value(
            "program/test_validator_announce.aleo/mapping/storage_locations/{validator:[0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8],index:0u8}", 
            "[\n  102u8,\n  105u8,\n  108u8,\n  101u8,\n  58u8,\n  47u8,\n  47u8,\n  47u8,\n  118u8,\n  97u8,\n  114u8,\n  47u8,\n  102u8,\n  111u8,\n  108u8,\n  100u8,\n  101u8,\n  114u8,\n  115u8,\n  47u8,\n  102u8,\n  50u8,\n  47u8,\n  116u8,\n  52u8,\n  103u8,\n  118u8,\n  115u8,\n  120u8,\n  118u8,\n  115u8,\n  48u8,\n  115u8,\n  51u8,\n  48u8,\n  120u8,\n  112u8,\n  99u8,\n  57u8,\n  104u8,\n  51u8,\n  113u8,\n  54u8,\n  122u8,\n  119u8,\n  53u8,\n  114u8,\n  48u8,\n  48u8,\n  48u8,\n  48u8,\n  103u8,\n  110u8,\n  47u8,\n  84u8,\n  47u8,\n  46u8,\n  116u8,\n  109u8,\n  112u8,\n  110u8,\n  79u8,\n  88u8,\n  70u8,\n  115u8,\n  115u8,\n  47u8,\n  99u8,\n  104u8,\n  101u8,\n  99u8,\n  107u8,\n  112u8,\n  111u8,\n  105u8,\n  110u8,\n  116u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8\n]",    
        );

        provider.register_value(
            "program/test_validator_announce.aleo/mapping/storage_sequences/{bytes:[0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8]}",
            "1u8"
        );

        provider.register_value(
            "program/test_validator_announce.aleo/mapping/storage_locations/{validator:[0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,1u8],index:1u8}", 
            "[\n  102u8,\n  105u8,\n  108u8,\n  101u8,\n  58u8,\n  47u8,\n  47u8,\n  47u8,\n  118u8,\n  97u8,\n  114u8,\n  47u8,\n  102u8,\n  111u8,\n  108u8,\n  100u8,\n  101u8,\n  114u8,\n  115u8,\n  47u8,\n  102u8,\n  50u8,\n  47u8,\n  116u8,\n  52u8,\n  103u8,\n  118u8,\n  115u8,\n  120u8,\n  118u8,\n  115u8,\n  48u8,\n  115u8,\n  51u8,\n  48u8,\n  120u8,\n  112u8,\n  99u8,\n  57u8,\n  104u8,\n  51u8,\n  113u8,\n  54u8,\n  122u8,\n  119u8,\n  53u8,\n  114u8,\n  48u8,\n  48u8,\n  48u8,\n  48u8,\n  103u8,\n  110u8,\n  47u8,\n  84u8,\n  47u8,\n  46u8,\n  116u8,\n  109u8,\n  112u8,\n  110u8,\n  79u8,\n  88u8,\n  70u8,\n  115u8,\n  115u8,\n  47u8,\n  99u8,\n  104u8,\n  101u8,\n  99u8,\n  107u8,\n  112u8,\n  111u8,\n  105u8,\n  110u8,\n  116u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8\n]",    
        );

        provider.register_value(
            "program/test_validator_announce.aleo/mapping/storage_locations/{validator:[0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,1u8],index:0u8}", 
            "[\n  102u8,\n  105u8,\n  108u8,\n  101u8,\n  58u8,\n  47u8,\n  47u8,\n  47u8,\n  118u8,\n  97u8,\n  114u8,\n  47u8,\n  102u8,\n  111u8,\n  108u8,\n  100u8,\n  101u8,\n  114u8,\n  115u8,\n  47u8,\n  102u8,\n  50u8,\n  47u8,\n  116u8,\n  52u8,\n  103u8,\n  118u8,\n  115u8,\n  120u8,\n  118u8,\n  115u8,\n  48u8,\n  115u8,\n  51u8,\n  48u8,\n  120u8,\n  112u8,\n  99u8,\n  57u8,\n  104u8,\n  51u8,\n  113u8,\n  54u8,\n  122u8,\n  119u8,\n  53u8,\n  114u8,\n  48u8,\n  48u8,\n  48u8,\n  48u8,\n  103u8,\n  110u8,\n  47u8,\n  84u8,\n  47u8,\n  46u8,\n  116u8,\n  109u8,\n  112u8,\n  110u8,\n  79u8,\n  88u8,\n  70u8,\n  115u8,\n  115u8,\n  47u8,\n  99u8,\n  104u8,\n  101u8,\n  99u8,\n  107u8,\n  112u8,\n  111u8,\n  105u8,\n  110u8,\n  116u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8,\n  0u8\n]",    
        );

        provider.register_value(
            "program/test_validator_announce.aleo/mapping/storage_sequences/{bytes:[0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,1u8]}",
            "2u8"
        );

        // Unknown validators
        provider.register_value(
            "program/test_validator_announce.aleo/mapping/storage_sequences/{bytes:[0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,2u8]}",
            serde_json::Value::Null
        );
        provider.register_value(
            "program/test_validator_announce.aleo/mapping/storage_sequences/{bytes:[0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,0u8,3u8]}",
            serde_json::Value::Null
        );

        let locator = ContractLocator::new(&DOMAIN, H256::zero());
        AleoValidatorAnnounce::new(provider, &locator, &connection_conf())
    }

    #[tokio::test]
    async fn test_get_announced_storage_locations() {
        let va = get_mock_validator_announce();
        let validators = [H256::from_low_u64_be(1), H256::zero()];
        let result = va.get_announced_storage_locations(&validators).await;
        assert!(result.is_ok(), "Get announced storage locations failed");
        let locations = result.unwrap();
        assert_eq!(locations.len(), 2, "Should have two validators' locations");
        assert_eq!(
            locations[0].len(),
            2,
            "First validator should have two locations"
        );
        assert_eq!(
            locations[1].len(),
            1,
            "Second validator should have one location"
        );
        for all_locations in &locations {
            for loc in all_locations {
                assert_eq!(
                    loc,
                    "file:///var/folders/f2/t4gvsxvs0s30xpc9h3q6zw5r0000gn/T/.tmpnOXFss/checkpoint",
                    "First validator location mismatch"
                );
            }
        }
    }

    #[tokio::test]
    async fn test_get_announced_storage_locations_unknown_validator() {
        let va = get_mock_validator_announce();
        let result = va
            .get_announced_storage_locations(&[H256::from_low_u64_be(2), H256::from_low_u64_be(3)])
            .await;
        assert!(result.is_ok(), "Get announced storage should not fail");
        let locations = result.unwrap();
        assert_eq!(
            locations[0].len(),
            0,
            "Should have no locations for unknown validator"
        );
        assert_eq!(
            locations[1].len(),
            0,
            "Should have no locations for unknown validator"
        );
    }
}
