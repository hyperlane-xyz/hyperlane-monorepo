use std::{sync::Arc, time::Duration};

use solana_commitment_config::CommitmentConfig;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signer::Signer as _,
};

use hyperlane_core::{ChainCommunicationError, ChainResult, ContractLocator, H256};

use crate::{
    priority_fee::PriorityFeeOracle, tx_submitter::TransactionSubmitter, SealevelKeypair,
    SealevelProvider,
};

/// How long to poll for the staging tx to reach `finalized` commitment
/// before giving up. Discovery (`get_ism_verify_account_metas`) reads the
/// staged account under `finalized`, so returning any earlier — e.g. once
/// `wait_for_transaction_confirmation` is satisfied, which only requires
/// *some* status (effectively `processed`) — leaves a window where the
/// account isn't visible yet to that finalized-commitment read. The
/// discovery fixpoint loop can't distinguish "not staged yet" from "staged
/// but not finalized yet" and silently converges on an incomplete account
/// list in the latter case, so this has to be a real wait, not best-effort.
const FINALIZED_POLL_TIMEOUT: Duration = Duration::from_secs(60);
const FINALIZED_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Submits `hyperlane-sealevel-token-cctp`'s `StageVerifyMetadata` instruction
/// ahead of the Mailbox `Process` call for CCTP v2 messages — see that
/// program's module docs (`ism.rs`) for why: the CCTP message + Circle
/// attestation, plus the raw Hyperlane message, plus the ~23 Circle CPI
/// accounts `Verify()` needs, together exceed Solana's transaction size
/// limit. Staging moves the CCTP-specific payload out of the `Process`
/// instruction's data into a PDA `Verify()` reads instead.
///
/// Deliberately NOT part of `SealevelMailbox`: staging is only ever needed
/// for this one ISM, and this program is the only one whose destination is
/// ever the Sealevel CCTP token program. Called directly from
/// `CctpV2MetadataBuilder::build()` (the relayer's chain-agnostic metadata
/// builder for `ModuleType::CctpV2`), which already knows it's CCTP with no
/// need for `SealevelMailbox`'s `Process` path to rediscover that.
pub struct SealevelCctpStager {
    payer: Option<SealevelKeypair>,
    program_id: Pubkey,
    provider: Arc<SealevelProvider>,
    tx_submitter: Arc<dyn TransactionSubmitter>,
    priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
}

impl std::fmt::Debug for SealevelCctpStager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealevelCctpStager")
            .field("program_id", &self.program_id)
            .finish()
    }
}

impl SealevelCctpStager {
    /// Create a new stager for the CCTP token program at `locator.address`.
    pub fn new(
        provider: Arc<SealevelProvider>,
        tx_submitter: Arc<dyn TransactionSubmitter>,
        priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
        locator: ContractLocator,
        payer: Option<SealevelKeypair>,
    ) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            payer,
            program_id,
            provider,
            tx_submitter,
            priority_fee_oracle,
        }
    }

    /// Writes `{message, attestation}` into the PDA keyed by `message_id`,
    /// submitting and waiting for confirmation before returning. Idempotent
    /// on the program side, so safe to call again on a reprepare retry.
    pub async fn stage_verify_metadata(
        &self,
        message_id: H256,
        message: Vec<u8>,
        attestation: Vec<u8>,
    ) -> ChainResult<()> {
        let payer = self
            .payer
            .as_ref()
            .ok_or(ChainCommunicationError::SignerUnavailable)?;

        let (stage_key, _) = hyperlane_sealevel_token_cctp::accounts::derive_stage_metadata_pda(
            &self.program_id,
            &message_id.0,
        );

        let ixn_data =
            hyperlane_sealevel_token_cctp::instruction::CctpInstruction::StageVerifyMetadata(
                hyperlane_sealevel_token_cctp::instruction::StageVerifyMetadata {
                    message_id: message_id.0,
                    message,
                    attestation,
                },
            )
            .encode()
            .map_err(|err| ChainCommunicationError::CustomError(err.to_string()))?;

        let instruction = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(stage_key, false),
                AccountMeta::new_readonly(solana_system_interface::program::ID, false),
            ],
            data: ixn_data,
        };

        let tx = self
            .provider
            .build_estimated_tx_for_instruction(
                instruction,
                payer,
                self.tx_submitter.clone(),
                self.priority_fee_oracle.clone(),
                None,
                &[],
            )
            .await?;
        self.tx_submitter.send_transaction(&tx, true).await?;
        self.tx_submitter
            .wait_for_transaction_confirmation(&tx)
            .await?;

        let signature = *tx.signature().ok_or_else(|| {
            ChainCommunicationError::from_other_str("No signature in staging transaction")
        })?;
        let started_waiting = tokio::time::Instant::now();
        loop {
            if self
                .tx_submitter
                .confirm_transaction(signature, CommitmentConfig::finalized())
                .await?
            {
                break;
            }
            if started_waiting.elapsed() >= FINALIZED_POLL_TIMEOUT {
                return Err(ChainCommunicationError::from_other_str(
                    "Timed out waiting for CCTP v2 staging transaction to finalize",
                ));
            }
            tokio::time::sleep(FINALIZED_POLL_INTERVAL).await;
        }

        Ok(())
    }
}
