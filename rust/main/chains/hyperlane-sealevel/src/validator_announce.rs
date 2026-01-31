use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};
use hyperlane_sealevel_validator_announce::{
    accounts::ValidatorStorageLocationsAccount,
    instruction::{AnnounceInstruction, Instruction as ValidatorAnnounceInstruction},
    replay_protection_pda_seeds, validator_announce_pda_seeds,
    validator_storage_locations_pda_seeds,
};

use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signer::Signer as _,
    system_program,
};
use tracing::{info, instrument};

use crate::{ConnectionConf, SealevelKeypair, SealevelProvider, TransactionSubmitter};

/// A reference to a ValidatorAnnounce contract on some Sealevel chain
pub struct SealevelValidatorAnnounce {
    provider: Arc<SealevelProvider>,
    tx_submitter: Arc<dyn TransactionSubmitter>,
    program_id: Pubkey,
    domain: HyperlaneDomain,
    conn: ConnectionConf,
    signer: Option<SealevelKeypair>,
}

impl std::fmt::Debug for SealevelValidatorAnnounce {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealevelValidatorAnnounce")
            .field("provider", &self.provider)
            .field("tx_submitter", &"Arc<dyn TransactionSubmitter>")
            .field("program_id", &self.program_id)
            .field("domain", &self.domain)
            .field("conn", &self.conn)
            .field("signer_pubkey", &self.signer.as_ref().map(|s| s.pubkey()))
            .finish()
    }
}

impl SealevelValidatorAnnounce {
    /// Create a new Sealevel ValidatorAnnounce
    pub fn new(
        provider: Arc<SealevelProvider>,
        tx_submitter: Arc<dyn TransactionSubmitter>,
        conn: ConnectionConf,
        locator: &ContractLocator,
        signer: Option<SealevelKeypair>,
    ) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            program_id,
            domain: locator.domain.clone(),
            provider,
            tx_submitter,
            conn,
            signer,
        }
    }

    fn get_signer(&self) -> ChainResult<&SealevelKeypair> {
        self.signer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)
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
    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let payer = self.get_signer()?;

        let announce_instruction = AnnounceInstruction {
            validator: announcement.value.validator,
            storage_location: announcement.value.storage_location.clone(),
            signature: announcement.signature.to_vec(),
        };

        let (validator_announce_account, _validator_announce_bump) =
            Pubkey::find_program_address(validator_announce_pda_seeds!(), &self.program_id);

        let (validator_storage_locations_key, _validator_storage_locations_bump_seed) =
            Pubkey::find_program_address(
                validator_storage_locations_pda_seeds!(announce_instruction.validator),
                &self.program_id,
            );

        let replay_id = announce_instruction.replay_id();
        let (replay_protection_pda_key, _replay_protection_bump_seed) =
            Pubkey::find_program_address(replay_protection_pda_seeds!(replay_id), &self.program_id);

        let ixn = ValidatorAnnounceInstruction::Announce(announce_instruction);

        // Accounts:
        // 0. [signer] The payer.
        // 1. [executable] The system program.
        // 2. [] The ValidatorAnnounce PDA account.
        // 3. [writeable] The validator-specific ValidatorStorageLocationsAccount PDA account.
        // 4. [writeable] The ReplayProtection PDA account specific to the announcement being made.
        let accounts = vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(validator_announce_account, false),
            AccountMeta::new(validator_storage_locations_key, false),
            AccountMeta::new(replay_protection_pda_key, false),
        ];

        let data = ixn
            .into_instruction_data()
            .map_err(|e| ChainCommunicationError::CustomError(e.to_string()))?;
        let instruction = Instruction {
            program_id: self.program_id,
            data,
            accounts,
        };

        info!(?instruction, "Created validator announce instruction");

        let tx = self
            .provider
            .build_estimated_tx_for_instruction(
                instruction,
                payer,
                self.tx_submitter.clone(),
                self.conn.priority_fee_oracle.create_oracle(),
            )
            .await?;

        info!(?tx, "Built transaction for validator announcement");

        let signature = self.tx_submitter.send_transaction(&tx, true).await?;

        info!(?signature, "Sent validator announcement transaction");

        self.tx_submitter
            .wait_for_transaction_confirmation(&tx)
            .await?;

        info!(?signature, "Validator announcement transaction confirmed");

        Ok(TxOutcome {
            transaction_id: signature.into(),
            executed: true,
            gas_used: U256::zero(),
            gas_price: U256::zero().try_into()?,
        })
    }

    async fn announce_calldata(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<Vec<u8>> {
        let payer = self.get_signer()?;

        let announce_instruction = AnnounceInstruction {
            validator: announcement.value.validator,
            storage_location: announcement.value.storage_location.clone(),
            signature: announcement.signature.to_vec(),
        };

        let (validator_announce_account, _validator_announce_bump) =
            Pubkey::find_program_address(validator_announce_pda_seeds!(), &self.program_id);

        let (validator_storage_locations_key, _validator_storage_locations_bump_seed) =
            Pubkey::find_program_address(
                validator_storage_locations_pda_seeds!(announce_instruction.validator),
                &self.program_id,
            );

        let replay_id = announce_instruction.replay_id();
        let (replay_protection_pda_key, _replay_protection_bump_seed) =
            Pubkey::find_program_address(replay_protection_pda_seeds!(replay_id), &self.program_id);

        let ixn = ValidatorAnnounceInstruction::Announce(announce_instruction);

        let accounts = vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(validator_announce_account, false),
            AccountMeta::new(validator_storage_locations_key, false),
            AccountMeta::new(replay_protection_pda_key, false),
        ];

        let data = ixn
            .into_instruction_data()
            .map_err(|e| ChainCommunicationError::CustomError(e.to_string()))?;

        let instruction = Instruction {
            program_id: self.program_id,
            data,
            accounts,
        };

        serde_json::to_vec(&instruction).map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::{Announcement, Signature, SignedType, U256};

    fn create_test_signed_announcement() -> SignedType<Announcement> {
        let announcement = Announcement {
            validator: H256::from_low_u64_be(1).into(),
            mailbox_address: H256::from_low_u64_be(2),
            mailbox_domain: 1399811149, // Solana mainnet domain
            storage_location: "s3://test-bucket/validator".to_string(),
        };

        // Create a mock signature
        let signature = Signature {
            r: U256::from(1),
            s: U256::from(2),
            v: 27,
        };

        SignedType {
            value: announcement,
            signature,
        }
    }

    #[test]
    fn test_announce_instruction_construction() {
        // Test that the AnnounceInstruction can be properly constructed and serialized
        let signed_announcement = create_test_signed_announcement();

        let validator_address: H160 = signed_announcement.value.validator.into();
        let storage_location = signed_announcement.value.storage_location.clone();
        let serialized_signature = signed_announcement.signature.to_vec();

        let announce_instruction = AnnounceInstruction {
            validator: validator_address,
            storage_location: storage_location.clone(),
            signature: serialized_signature.clone(),
        };

        let instruction = ValidatorAnnounceInstruction::Announce(announce_instruction);
        let ixn_data = borsh::to_vec(&instruction).expect("Failed to serialize instruction");

        // Verify the instruction data is not empty and contains expected content
        assert!(!ixn_data.is_empty());
        // Can't check directly as it's borsh encoded, but verify length is reasonable
        assert!(ixn_data.len() > storage_location.len());
    }

    #[test]
    fn test_pda_derivation_consistency() {
        // Test that PDA derivation is consistent
        let program_id = Pubkey::new_unique();
        let validator_address = H160::from_low_u64_be(12345);

        // Derive storage locations PDA
        let (storage_pda_1, bump_1) = Pubkey::find_program_address(
            validator_storage_locations_pda_seeds!(validator_address),
            &program_id,
        );

        // Derive again with same parameters
        let (storage_pda_2, bump_2) = Pubkey::find_program_address(
            validator_storage_locations_pda_seeds!(validator_address),
            &program_id,
        );

        // PDAs should be identical for same inputs
        assert_eq!(storage_pda_1, storage_pda_2);
        assert_eq!(bump_1, bump_2);

        // Test replay protection PDA with a replay_id
        let replay_id: [u8; 32] = [1u8; 32];
        let (replay_pda_1, _) =
            Pubkey::find_program_address(replay_protection_pda_seeds!(replay_id), &program_id);

        let (replay_pda_2, _) =
            Pubkey::find_program_address(replay_protection_pda_seeds!(replay_id), &program_id);

        assert_eq!(replay_pda_1, replay_pda_2);
    }
}
