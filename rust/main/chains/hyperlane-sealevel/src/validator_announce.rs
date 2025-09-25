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
            .field("signer", &self.signer)
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
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(validator_announce_account, false),
            AccountMeta::new(validator_storage_locations_key, false),
            AccountMeta::new(replay_protection_pda_key, false),
        ];

        let instruction = Instruction {
            program_id: self.program_id,
            data: ixn.into_instruction_data().unwrap(),
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
}
