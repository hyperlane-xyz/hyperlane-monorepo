// Silence a clippy bug https://github.com/rust-lang/rust-clippy/issues/12281
#![allow(clippy::blocks_in_conditions)]

use std::{collections::HashMap, str::FromStr as _, sync::Arc};

use async_trait::async_trait;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use hyperlane_sealevel_mailbox::{
    accounts::{Inbox, InboxAccount},
    instruction::InboxProcess,
    mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds, mailbox_process_authority_pda_seeds,
    mailbox_processed_message_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use lazy_static::lazy_static;
use serializable_account_meta::SimulationReturnData;
use solana_commitment_config::CommitmentConfig;
use solana_program::pubkey;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signer::Signer as _,
};
use tracing::{debug, instrument, warn};

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Encode as _, FixedPointNumber,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    Mailbox, MerkleTreeHook, Metadata, ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::priority_fee::PriorityFeeOracle;
use crate::tx_submitter::TransactionSubmitter;
use crate::utils::sanitize_dynamic_accounts;
use crate::{
    ConnectionConf, ProcessAltOverride, SealevelKeypair, SealevelProvider,
    SealevelProviderForLander,
};

const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
const SPL_NOOP: &str = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";

// Earlier versions of collateral warp routes were deployed off a version where the mint
// was requested as a writeable account for handle instruction. This is not necessary,
// and generally requires a higher priority fee to be paid.
// This is a HashMap of of (collateral warp route recipient -> mint address) that is
// used to force the mint address to be readonly.
lazy_static! {
    static ref RECIPIENT_FORCED_READONLY_ACCOUNTS: HashMap<Pubkey, Pubkey> = HashMap::from([
        // EZSOL
        (pubkey!("b5pMgizA9vrGRt3hVqnU7vUVGBQUnLpwPzcJhG1ucyQ"), pubkey!("ezSoL6fY1PVdJcJsUpe5CM3xkfmy3zoVCABybm5WtiC")),
        // ORCA
        (pubkey!("8acihSm2QTGswniKgdgr4JBvJihZ1cakfvbqWCPBLoSp"), pubkey!("orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE")),
        // USDC
        (pubkey!("3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm"), pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")),
        // USDT
        (pubkey!("Bk79wMjvpPCh5iQcCEjPWFcG1V2TfgdwaBsWBEYFYSNU"), pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")),
        // WIF
        (pubkey!("CuQmsT4eSF4dYiiGUGYYQxJ7c58pUAD5ADE3BbFGzQKx"), pubkey!("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm")),
    ]);
}

/// Sealevel process instruction payload with optional ALT address.
///
/// ALT (Address Lookup Table) is optional and helps reduce transaction size
/// by allowing accounts to be referenced by 1-byte index rather than 32-byte pubkey.
/// When provided, the ALT is assumed to be static and lazily loaded by the tx builder.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SealevelProcessPayload {
    /// The process instruction to execute
    pub instruction: Instruction,
    /// Optional ALT address for versioned transactions
    pub alt_address: Option<Pubkey>,
}

/// A reference to a Mailbox contract on some Sealevel chain
pub struct SealevelMailbox {
    pub(crate) program_id: Pubkey,
    inbox: (Pubkey, u8),
    pub(crate) outbox: (Pubkey, u8),
    pub(crate) provider: Arc<SealevelProvider>,
    payer: Option<SealevelKeypair>,
    priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
    tx_submitter: Arc<dyn TransactionSubmitter>,
    /// Optional ALT address for versioned transactions (from config)
    mailbox_process_alt: Option<Pubkey>,
    /// Per-message ALT overrides (first match wins, falls back to mailbox_process_alt)
    process_alt_overrides: Vec<ProcessAltOverride>,

    system_program: Pubkey,
    spl_noop: Pubkey,
}

impl SealevelMailbox {
    /// Create a new sealevel mailbox
    pub fn new(
        provider: Arc<SealevelProvider>,
        tx_submitter: Arc<dyn TransactionSubmitter>,
        conf: &ConnectionConf,
        locator: &ContractLocator,
        payer: Option<SealevelKeypair>,
    ) -> ChainResult<Self> {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        let domain = locator.domain.id();
        let inbox = Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), &program_id);
        let outbox = Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), &program_id);

        debug!(
            "domain={}\nmailbox={}\ninbox=({}, {})\noutbox=({}, {})",
            domain, program_id, inbox.0, inbox.1, outbox.0, outbox.1,
        );

        let system_program = Pubkey::from_str(SYSTEM_PROGRAM)
            .map_err(|err| ChainCommunicationError::CustomError(err.to_string()))?;
        let spl_noop = Pubkey::from_str(SPL_NOOP)
            .map_err(|err| ChainCommunicationError::CustomError(err.to_string()))?;

        Ok(SealevelMailbox {
            program_id,
            inbox,
            outbox,
            payer,
            priority_fee_oracle: conf.priority_fee_oracle.create_oracle(),
            tx_submitter,
            mailbox_process_alt: conf.mailbox_process_alt,
            process_alt_overrides: conf.process_alt_overrides.clone(),
            provider,

            system_program,
            spl_noop,
        })
    }

    /// Get the Inbox account pubkey and bump seed.
    pub fn inbox(&self) -> (Pubkey, u8) {
        self.inbox
    }

    /// Get the Outbox account pubkey and bump seed.
    pub fn outbox(&self) -> (Pubkey, u8) {
        self.outbox
    }

    /// Get the sealevel provider client.
    pub fn get_provider(&self) -> &SealevelProvider {
        &self.provider
    }

    /// Simulates an instruction, and attempts to deserialize it into a T.
    /// If no return data at all was returned, returns Ok(None).
    /// If some return data was returned but deserialization was unsuccessful,
    /// an Err is returned.
    pub async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
        &self,
        instruction: Instruction,
    ) -> ChainResult<Option<T>> {
        let payer = self
            .payer
            .as_ref()
            .map(|p| p.pubkey())
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        self.provider
            .simulate_instruction(&payer, instruction)
            .await
    }

    /// Simulates an Instruction that will return a list of AccountMetas.
    pub async fn get_account_metas(
        &self,
        instruction: Instruction,
    ) -> ChainResult<Vec<AccountMeta>> {
        let payer = self
            .payer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;
        self.provider.get_account_metas(payer, instruction).await
    }

    /// Gets the recipient ISM given a recipient program id and the ISM getter account metas.
    pub async fn get_recipient_ism(
        &self,
        recipient_program_id: Pubkey,
        ism_getter_account_metas: Vec<AccountMeta>,
    ) -> ChainResult<Pubkey> {
        let mut accounts = vec![
            // Inbox PDA
            AccountMeta::new_readonly(self.inbox.0, false),
            // The recipient program.
            AccountMeta::new_readonly(recipient_program_id, false),
        ];
        accounts.extend(ism_getter_account_metas);

        let instruction = Instruction::new_with_borsh(
            self.program_id,
            &hyperlane_sealevel_mailbox::instruction::Instruction::InboxGetRecipientIsm(
                recipient_program_id,
            ),
            accounts,
        );
        let ism = self
            .simulate_instruction::<SimulationReturnData<Pubkey>>(instruction)
            .await?
            .ok_or(ChainCommunicationError::from_other_str(
                "No return data from InboxGetRecipientIsm instruction",
            ))?
            .return_data;
        Ok(ism)
    }

    /// Gets the account metas required for the recipient's
    /// `MessageRecipientInstruction::InterchainSecurityModule` instruction.
    pub async fn get_ism_getter_account_metas(
        &self,
        recipient_program_id: Pubkey,
    ) -> ChainResult<Vec<AccountMeta>> {
        let instruction =
            hyperlane_sealevel_message_recipient_interface::MessageRecipientInstruction::InterchainSecurityModuleAccountMetas;
        self.get_non_signer_account_metas_with_instruction_bytes(
            recipient_program_id,
            &instruction
                .encode()
                .map_err(ChainCommunicationError::from_other)?,
                hyperlane_sealevel_message_recipient_interface::INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
        ).await
    }

    /// Gets the account metas required for the ISM's `Verify` instruction.
    pub async fn get_ism_verify_account_metas(
        &self,
        ism: Pubkey,
        metadata: Vec<u8>,
        message: Vec<u8>,
    ) -> ChainResult<Vec<AccountMeta>> {
        let instruction =
            InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction {
                metadata,
                message,
            });
        self.get_non_signer_account_metas_with_instruction_bytes(
            ism,
            &instruction
                .encode()
                .map_err(ChainCommunicationError::from_other)?,
            hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS,
        )
        .await
    }

    /// Gets the account metas required for the recipient's `MessageRecipientInstruction::Handle` instruction.
    pub async fn get_handle_account_metas(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<Vec<AccountMeta>> {
        let recipient_program_id = Pubkey::new_from_array(message.recipient.into());
        let instruction = MessageRecipientInstruction::HandleAccountMetas(HandleInstruction {
            sender: message.sender,
            origin: message.origin,
            message: message.body.clone(),
        });

        let mut account_metas = self
            .get_non_signer_account_metas_with_instruction_bytes(
                recipient_program_id,
                &instruction
                    .encode()
                    .map_err(ChainCommunicationError::from_other)?,
                hyperlane_sealevel_message_recipient_interface::HANDLE_ACCOUNT_METAS_PDA_SEEDS,
            )
            .await?;

        if let Some(forced_readonly_account) =
            RECIPIENT_FORCED_READONLY_ACCOUNTS.get(&recipient_program_id)
        {
            account_metas
                .iter_mut()
                .filter(|account_meta| account_meta.pubkey == *forced_readonly_account)
                .for_each(|account_meta| account_meta.is_writable = false);
        }

        Ok(account_metas)
    }

    async fn get_non_signer_account_metas_with_instruction_bytes(
        &self,
        program_id: Pubkey,
        instruction_data: &[u8],
        account_metas_pda_seeds: &[&[u8]],
    ) -> ChainResult<Vec<AccountMeta>> {
        let (account_metas_pda_key, _) =
            Pubkey::find_program_address(account_metas_pda_seeds, &program_id);
        let instruction = Instruction::new_with_bytes(
            program_id,
            instruction_data,
            vec![AccountMeta::new(account_metas_pda_key, false)],
        );

        let account_metas = self.get_account_metas(instruction).await?;

        // Ensure dynamically provided account metas are safe to prevent theft from the payer.
        sanitize_dynamic_accounts(account_metas, &self.get_payer()?.pubkey())
    }

    /// Resolve which ALT to use for a given message.
    /// Checks per-message overrides first (first match wins), then falls back to
    /// the static `mailbox_process_alt`.
    fn resolve_process_alt(&self, message: &HyperlaneMessage) -> Option<Pubkey> {
        resolve_process_alt(
            &self.process_alt_overrides,
            self.mailbox_process_alt,
            message,
        )
    }

    async fn get_process_payload(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<SealevelProcessPayload> {
        let recipient: Pubkey = message.recipient.0.into();
        let mut encoded_message = vec![];
        message
            .write_to(&mut encoded_message)
            .map_err(|err| ChainCommunicationError::CustomError(err.to_string()))?;

        let payer = self.get_payer()?;

        let (process_authority_key, _process_authority_bump) = Pubkey::try_find_program_address(
            mailbox_process_authority_pda_seeds!(&recipient),
            &self.program_id,
        )
        .ok_or_else(|| {
            ChainCommunicationError::from_other_str(
                "Could not find program address for process authority",
            )
        })?;
        let (processed_message_account_key, _processed_message_account_bump) =
            Pubkey::try_find_program_address(
                mailbox_processed_message_pda_seeds!(message.id()),
                &self.program_id,
            )
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str(
                    "Could not find program address for processed message account",
                )
            })?;

        // Get the account metas required for the recipient.InterchainSecurityModule instruction.
        let ism_getter_account_metas = self.get_ism_getter_account_metas(recipient).await?;

        // Get the recipient ISM.
        let ism = self
            .get_recipient_ism(recipient, ism_getter_account_metas.clone())
            .await?;

        let ixn =
            hyperlane_sealevel_mailbox::instruction::Instruction::InboxProcess(InboxProcess {
                metadata: metadata.to_vec(),
                message: encoded_message.clone(),
            });
        let ixn_data = ixn
            .into_instruction_data()
            .map_err(ChainCommunicationError::from_other)?;

        // Craft the accounts for the transaction.
        let mut accounts: Vec<AccountMeta> = vec![
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new_readonly(self.system_program, false),
            AccountMeta::new(self.inbox.0, false),
            AccountMeta::new_readonly(process_authority_key, false),
            AccountMeta::new(processed_message_account_key, false),
        ];
        accounts.extend(ism_getter_account_metas);
        accounts.extend([
            AccountMeta::new_readonly(self.spl_noop, false),
            AccountMeta::new_readonly(ism, false),
        ]);

        // Get the account metas required for the ISM.Verify instruction.
        let ism_verify_account_metas = self
            .get_ism_verify_account_metas(ism, metadata.into(), encoded_message)
            .await?;
        accounts.extend(ism_verify_account_metas);

        // The recipient.
        accounts.extend([AccountMeta::new_readonly(recipient, false)]);

        // Get account metas required for the Handle instruction
        let handle_account_metas = self.get_handle_account_metas(message).await?;
        accounts.extend(handle_account_metas);

        let instruction = Instruction {
            program_id: self.program_id,
            data: ixn_data,
            accounts,
        };

        Ok(SealevelProcessPayload {
            instruction,
            alt_address: self.resolve_process_alt(message),
        })
    }

    /// Get inbox account
    pub async fn get_inbox(&self) -> ChainResult<Box<Inbox>> {
        let account = self
            .provider
            .rpc_client()
            .get_account_with_finalized_commitment(self.inbox.0)
            .await?;
        let inbox = InboxAccount::fetch(&mut account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        Ok(inbox)
    }

    fn get_payer(&self) -> ChainResult<&SealevelKeypair> {
        self.payer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)
    }

    fn processed_message_account(&self, message_id: H256) -> Pubkey {
        let (processed_message_account_key, _processed_message_account_bump) =
            Pubkey::find_program_address(
                mailbox_processed_message_pda_seeds!(message_id),
                &self.program_id,
            );
        processed_message_account_key
    }

    async fn get_account(
        &self,
        processed_message_account_key: Pubkey,
    ) -> Result<Option<Account>, ChainCommunicationError> {
        let account = self
            .provider
            .rpc_client()
            .get_account_option_with_finalized_commitment(processed_message_account_key)
            .await?;
        Ok(account)
    }
}

impl HyperlaneContract for SealevelMailbox {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

impl std::fmt::Debug for SealevelMailbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self as &dyn HyperlaneContract)
    }
}

// TODO refactor the sealevel client into a lib and bin, pull in and use the lib here rather than
// duplicating.
#[async_trait]
impl Mailbox for SealevelMailbox {
    #[instrument(err, ret, skip(self))]
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        <Self as MerkleTreeHook>::count(self, reorg_period).await
    }

    #[instrument(err, ret, skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let processed_message_account_key = self.processed_message_account(id);
        let account = self.get_account(processed_message_account_key).await?;

        Ok(account.is_some())
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        let inbox = self.get_inbox().await?;
        Ok(inbox.default_ism.to_bytes().into())
    }

    #[instrument(err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let recipient_program_id = Pubkey::new_from_array(recipient.0);

        // Get the account metas required for the recipient.InterchainSecurityModule instruction.
        let ism_getter_account_metas = self
            .get_ism_getter_account_metas(recipient_program_id)
            .await?;

        // Get the ISM to use.
        let ism_pubkey = self
            .get_recipient_ism(recipient_program_id, ism_getter_account_metas)
            .await?;

        Ok(ism_pubkey.to_bytes().into())
    }

    #[instrument(err, ret, skip(self))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        // "processed" level commitment does not guarantee finality.
        // roughly 5% of blocks end up on a dropped fork.
        // However we don't want this function to be a bottleneck and there already
        // is retry logic in the agents.
        let commitment = CommitmentConfig::processed();

        let payload = self.get_process_payload(message, metadata).await?;

        let payer = self.get_payer()?;
        let tx = self
            .provider
            .build_estimated_tx_for_instruction(
                payload.instruction,
                payer,
                self.tx_submitter.clone(),
                self.priority_fee_oracle.clone(),
                payload.alt_address,
            )
            .await?;

        tracing::info!(?tx, "Created sealevel transaction to process message");

        let signature = self.tx_submitter.send_transaction(&tx, true).await?;
        tracing::info!(?tx, ?signature, "Sealevel transaction sent");

        let send_instant = std::time::Instant::now();

        // Wait for the transaction to be confirmed.
        self.tx_submitter
            .wait_for_transaction_confirmation(&tx)
            .await?;

        // We expect time_to_confirm to fluctuate depending on the commitment level when submitting the
        // tx, but still use it as a proxy for tx latency to help debug.
        tracing::info!(?tx, ?signature, time_to_confirm=?send_instant.elapsed(), "Sealevel transaction confirmed");

        // TODO: not sure if this actually checks if the transaction was executed / reverted?
        // Confirm the transaction.
        let executed = self
            .tx_submitter
            .confirm_transaction(signature, commitment)
            .await
            .map_err(|err| warn!("Failed to confirm inbox process transaction: {}", err))
            .unwrap_or(false);
        let txid = signature.into();

        Ok(TxOutcome {
            transaction_id: txid,
            executed,
            // TODO use correct data upon integrating IGP support
            gas_price: U256::zero().try_into()?,
            gas_used: U256::zero(),
        })
    }

    #[instrument(err, ret, skip(self))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
    ) -> ChainResult<TxCostEstimate> {
        // Getting a process payload in Sealevel is a pretty expensive operation
        // that involves some view calls. Consider reusing the payload with subsequent
        // calls to `process` to avoid this cost.
        let payload = self.get_process_payload(message, metadata).await?;

        let payer = self.get_payer()?;
        // The returned costs are unused at the moment - we simply want to perform a simulation to
        // determine if the message will revert or not.
        let _ = self
            .provider
            .get_estimated_costs_for_instruction(
                payload.instruction,
                payer,
                self.tx_submitter.clone(),
                self.priority_fee_oracle.clone(),
                payload.alt_address,
            )
            .await?;

        // TODO use correct data upon integrating IGP support.
        // NOTE: providing a real gas limit here will result in accurately enforcing
        // gas payments. Be careful rolling this out to not impact existing contracts
        // that may not be paying for super accurate gas amounts.
        Ok(TxCostEstimate {
            gas_limit: U256::zero(),
            gas_price: FixedPointNumber::zero(),
            l2_gas_limit: None,
        })
    }

    async fn process_calldata(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
    ) -> ChainResult<Vec<u8>> {
        let payload = self.get_process_payload(message, metadata).await?;
        serde_json::to_vec(&payload).map_err(Into::into)
    }

    fn delivered_calldata(&self, message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        let account = self.processed_message_account(message_id);
        serde_json::to_vec(&account).map(Some).map_err(Into::into)
    }
}

/// Resolve which ALT to use for a given message.
/// Checks per-message overrides first (first match wins), then falls back to
/// the given fallback ALT.
fn resolve_process_alt(
    overrides: &[ProcessAltOverride],
    fallback: Option<Pubkey>,
    message: &HyperlaneMessage,
) -> Option<Pubkey> {
    for entry in overrides {
        if entry.matching_list.msg_matches(message, false) {
            debug!(alt = ?entry.alt_address, "Using per-message ALT override");
            return Some(entry.alt_address);
        }
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::matching_list::MatchingList;

    fn test_message(recipient: H256) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: 1,
            sender: H256::zero(),
            destination: 2,
            recipient,
            body: vec![],
        }
    }

    // Note: serde field names for MatchingList are all lowercase (e.g. "recipientaddress", not "recipientAddress")
    const ADDR_A: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";
    #[allow(dead_code)]
    const ADDR_B: &str = "0x0000000000000000000000000000000000000000000000000000000000000002";

    fn h256_from_u8(v: u8) -> H256 {
        let mut bytes = [0u8; 32];
        bytes[31] = v;
        H256::from(bytes)
    }

    #[test]
    fn test_resolve_alt_override_match() {
        let alt_key = Pubkey::new_unique();
        let fallback_key = Pubkey::new_unique();
        let recipient = h256_from_u8(1);

        let overrides = vec![ProcessAltOverride {
            matching_list: serde_json::from_str::<MatchingList>(&format!(
                r#"[{{"recipientaddress": "{ADDR_A}"}}]"#
            ))
            .unwrap(),
            alt_address: alt_key,
        }];

        let msg = test_message(recipient);
        let result = resolve_process_alt(&overrides, Some(fallback_key), &msg);
        assert_eq!(result, Some(alt_key));
    }

    #[test]
    fn test_resolve_alt_no_match_uses_fallback() {
        let alt_key = Pubkey::new_unique();
        let fallback_key = Pubkey::new_unique();

        let overrides = vec![ProcessAltOverride {
            matching_list: serde_json::from_str::<MatchingList>(&format!(
                r#"[{{"recipientaddress": "{ADDR_A}"}}]"#
            ))
            .unwrap(),
            alt_address: alt_key,
        }];

        // ADDR_B recipient - should not match ADDR_A
        let msg = test_message(h256_from_u8(2));
        let result = resolve_process_alt(&overrides, Some(fallback_key), &msg);
        assert_eq!(result, Some(fallback_key));
    }

    #[test]
    fn test_resolve_alt_no_match_no_fallback() {
        let overrides = vec![];
        let msg = test_message(H256::zero());
        let result = resolve_process_alt(&overrides, None, &msg);
        assert_eq!(result, None);
    }

    #[test]
    fn test_resolve_alt_first_match_wins() {
        let alt1 = Pubkey::new_unique();
        let alt2 = Pubkey::new_unique();

        // Both overrides match any message (empty matching list = match all)
        let overrides = vec![
            ProcessAltOverride {
                matching_list: serde_json::from_str::<MatchingList>(r#"[{}]"#).unwrap(),
                alt_address: alt1,
            },
            ProcessAltOverride {
                matching_list: serde_json::from_str::<MatchingList>(r#"[{}]"#).unwrap(),
                alt_address: alt2,
            },
        ];

        let msg = test_message(H256::zero());
        let result = resolve_process_alt(&overrides, None, &msg);
        assert_eq!(result, Some(alt1));
    }

    /// Integration test: builds a process payload for a real sepolia->solanatestnet message
    /// using a per-message ALT override and simulates the transaction.
    ///
    /// Requires:
    ///   SOLANA_TESTNET_RPC_URL - private RPC endpoint for solanatestnet
    ///   SOLANA_PAYER_KEYPAIR   - path to funded keypair JSON (default: ~/solana-devnet-deployer-key.json)
    #[tokio::test]
    #[ignore] // requires network + funded keypair
    async fn test_alt_override_process_payload_simulation() {
        use hyperlane_core::{
            config::OpSubmissionConfig, Decode, KnownHyperlaneDomain, NativeToken,
        };
        use solana_sdk::signer::keypair::read_keypair_file;
        use url::Url;

        use crate::{
            fallback::SealevelFallbackRpcClient,
            tx_submitter::{config::TransactionSubmitterConfig, RpcTransactionSubmitter},
            ConnectionConf, PriorityFeeOracleConfig, SealevelKeypair, SealevelProvider,
        };

        // -- env / config --
        let rpc_url = std::env::var("SOLANA_TESTNET_RPC_URL")
            .expect("set SOLANA_TESTNET_RPC_URL to run this test");
        let keypair_path = std::env::var("SOLANA_PAYER_KEYPAIR").unwrap_or_else(|_| {
            let home = std::env::var("HOME").expect("HOME not set");
            format!("{home}/solana-devnet-deployer-key.json")
        });

        // -- raw message 0xea6317dba7e9296e0a9f9fd0316d7e17644802ab5d76b2d33f4c4679a1839a17 --
        // sepolia (11155111) -> solanatestnet (1399811150)
        // recipient = mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X
        let raw_msg = hex::decode(
            "03000d3b8600aa36a7000000000000000000000000fcc1d596ad6cab0b5394eaa447d8626813180f32\
             536f6c4e0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f79400536f6c\
             4e0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f794c570254a0acb1c\
             105e3ee95bfa090fdf7c1a07aaa0f42f2d31f9bd9c34c650be0000000000000000000000f3f30bd2bd\
             000000000000000000000000000000640b86be66bc1f98b47d20a3be615a4905a825b826864e2a0f4c\
             948467d33ee70900000000000000000000000012b1a4226ba7d9ad492779c924b0fc00bdcb6217b3dc\
             7b5c135c62861a3325626976f36c3e71b9140285505789ef064922bc4ff6",
        )
        .expect("valid hex");

        let metadata = hex::decode(
            "0000000000000000000000004917a9746a7b6e0a57159ccb7f5a6744247f2d0d901b5650ea0806a2d1\
             981d0237a4151613f918ecf4801bdedf13ee78dd0f5656000d369e40ea673622027fa546cb751280f6\
             5e7b43f40706eb4a2effb51ae3101548edeb46d38849ceb1852362b89c63eca8a4e7d057bbca7aa1ba\
             6914d46d69a1648f751b0a650d682d9d358bf8a367e26b224be5f7f13178a08ce161ab39b614ead45a\
             843194a1049bbb8c9c39878b20525c1b87f06593dbf49b549ab173bacc6653abe61c",
        )
        .expect("valid hex");

        let message =
            HyperlaneMessage::read_from(&mut raw_msg.as_slice()).expect("valid HyperlaneMessage");
        assert_eq!(message.version, 3);
        assert_eq!(message.origin, 11155111, "origin should be sepolia");
        assert_eq!(
            message.destination, 1399811150,
            "destination should be solanatestnet"
        );

        // -- ALT override config --
        // recipient = mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X
        //           = 0x0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f794
        let expected_alt =
            Pubkey::from_str("4zybokQ8gLLPWUawXaw1JhrPZZsTaTGeaHZhLLb5nPhS").expect("valid pubkey");

        let overrides = vec![ProcessAltOverride {
            matching_list: serde_json::from_str::<MatchingList>(
                r#"[{"recipientaddress": "0x0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f794"}]"#,
            )
            .unwrap(),
            alt_address: expected_alt,
        }];

        // -- construct mailbox --
        let url = Url::parse(&rpc_url).expect("valid URL");
        let domain = HyperlaneDomain::from(KnownHyperlaneDomain::SolanaTestnet);
        let mailbox_program_id =
            Pubkey::from_str("75HBBLae3ddeneJVrZeyrDfv6vb7SMC3aCpBucSXS5aR").unwrap();
        let mailbox_h256 = H256::from(mailbox_program_id.to_bytes());

        let conf = ConnectionConf {
            urls: vec![url.clone()],
            op_submission_config: OpSubmissionConfig::default(),
            native_token: NativeToken::default(),
            priority_fee_oracle: PriorityFeeOracleConfig::Constant(0),
            transaction_submitter: TransactionSubmitterConfig::default(),
            mailbox_process_alt: None,
            process_alt_overrides: overrides,
        };

        let rpc_client = SealevelFallbackRpcClient::from_urls(None, vec![url], Default::default());
        let provider = Arc::new(SealevelProvider::new(
            rpc_client,
            domain.clone(),
            &[mailbox_h256],
            &conf,
        ));
        let locator = hyperlane_core::ContractLocator::new(&domain, mailbox_h256);
        let tx_submitter: Arc<dyn crate::tx_submitter::TransactionSubmitter> =
            Arc::new(RpcTransactionSubmitter::new(provider.clone()));

        let keypair =
            read_keypair_file(&keypair_path).expect("read keypair from SOLANA_PAYER_KEYPAIR");
        let payer = SealevelKeypair::new(keypair);

        let mailbox =
            SealevelMailbox::new(provider, tx_submitter.clone(), &conf, &locator, Some(payer))
                .expect("mailbox construction");

        // -- get_process_payload should resolve ALT via override --
        let payload = mailbox
            .get_process_payload(&message, &metadata)
            .await
            .expect("get_process_payload should succeed");

        assert_eq!(
            payload.alt_address,
            Some(expected_alt),
            "ALT override should match for this recipient"
        );

        // -- simulate delivery with the ALT --
        // Build an unsigned versioned tx and simulate it. The simulation may return
        // an application-level error (e.g. InvalidPeer) but that's fine — we're
        // proving the tx isn't "too large" (i.e. the ALT is working).
        let payer_ref = mailbox.get_payer().expect("payer");
        let tx = mailbox
            .provider
            .create_transaction_for_instruction(
                1_400_000,
                0,
                payload.instruction,
                payer_ref,
                tx_submitter,
                false, // unsigned for simulation
                payload.alt_address,
            )
            .await
            .expect("versioned tx construction should succeed");

        assert!(
            matches!(&tx, crate::tx_type::SealevelTxType::Versioned(_)),
            "Expected versioned transaction when ALT is provided"
        );

        let sim_result = mailbox
            .provider
            .rpc_client()
            .simulate_sealevel_tx(&tx)
            .await
            .expect("simulate_sealevel_tx RPC call should not fail");

        // The simulation ran. It may have an application error (e.g. InvalidPeer 0x1773)
        // but it must NOT be a transaction-too-large / account lookup failure.
        println!("Simulation result: {sim_result:?}");
        if let Some(ref err) = sim_result.err {
            let err_str = format!("{err:?}");
            assert!(
                !err_str.contains("TransactionTooLarge") && !err_str.contains("AddressLookupTable"),
                "ALT-related failure: {err_str}"
            );
        }
        assert!(
            sim_result.units_consumed.unwrap_or(0) > 0,
            "Simulation should have consumed compute units"
        );

        println!(
            "Integration test passed: simulation consumed {} CUs (err={:?})",
            sim_result.units_consumed.unwrap_or(0),
            sim_result.err,
        );
    }

    /// Integration test: same message/metadata as above but WITHOUT an ALT.
    /// Proves the transaction is too large without the Address Lookup Table.
    #[tokio::test]
    #[ignore] // requires network + funded keypair
    async fn test_no_alt_process_payload_too_large() {
        use hyperlane_core::{
            config::OpSubmissionConfig, Decode, KnownHyperlaneDomain, NativeToken,
        };
        use solana_sdk::signer::keypair::read_keypair_file;
        use url::Url;

        use crate::{
            fallback::SealevelFallbackRpcClient,
            tx_submitter::{config::TransactionSubmitterConfig, RpcTransactionSubmitter},
            ConnectionConf, PriorityFeeOracleConfig, SealevelKeypair, SealevelProvider,
        };

        // -- env / config --
        let rpc_url = std::env::var("SOLANA_TESTNET_RPC_URL")
            .expect("set SOLANA_TESTNET_RPC_URL to run this test");
        let keypair_path = std::env::var("SOLANA_PAYER_KEYPAIR").unwrap_or_else(|_| {
            let home = std::env::var("HOME").expect("HOME not set");
            format!("{home}/solana-devnet-deployer-key.json")
        });

        // -- same message 0xea6317dba7e9296e0a9f9fd0316d7e17644802ab5d76b2d33f4c4679a1839a17 --
        let raw_msg = hex::decode(
            "03000d3b8600aa36a7000000000000000000000000fcc1d596ad6cab0b5394eaa447d8626813180f32\
             536f6c4e0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f79400536f6c\
             4e0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f794c570254a0acb1c\
             105e3ee95bfa090fdf7c1a07aaa0f42f2d31f9bd9c34c650be0000000000000000000000f3f30bd2bd\
             000000000000000000000000000000640b86be66bc1f98b47d20a3be615a4905a825b826864e2a0f4c\
             948467d33ee70900000000000000000000000012b1a4226ba7d9ad492779c924b0fc00bdcb6217b3dc\
             7b5c135c62861a3325626976f36c3e71b9140285505789ef064922bc4ff6",
        )
        .expect("valid hex");

        let metadata = hex::decode(
            "0000000000000000000000004917a9746a7b6e0a57159ccb7f5a6744247f2d0d901b5650ea0806a2d1\
             981d0237a4151613f918ecf4801bdedf13ee78dd0f5656000d369e40ea673622027fa546cb751280f6\
             5e7b43f40706eb4a2effb51ae3101548edeb46d38849ceb1852362b89c63eca8a4e7d057bbca7aa1ba\
             6914d46d69a1648f751b0a650d682d9d358bf8a367e26b224be5f7f13178a08ce161ab39b614ead45a\
             843194a1049bbb8c9c39878b20525c1b87f06593dbf49b549ab173bacc6653abe61c",
        )
        .expect("valid hex");

        let message =
            HyperlaneMessage::read_from(&mut raw_msg.as_slice()).expect("valid HyperlaneMessage");

        // -- NO ALT overrides, NO mailbox_process_alt --
        let url = Url::parse(&rpc_url).expect("valid URL");
        let domain = HyperlaneDomain::from(KnownHyperlaneDomain::SolanaTestnet);
        let mailbox_program_id =
            Pubkey::from_str("75HBBLae3ddeneJVrZeyrDfv6vb7SMC3aCpBucSXS5aR").unwrap();
        let mailbox_h256 = H256::from(mailbox_program_id.to_bytes());

        let conf = ConnectionConf {
            urls: vec![url.clone()],
            op_submission_config: OpSubmissionConfig::default(),
            native_token: NativeToken::default(),
            priority_fee_oracle: PriorityFeeOracleConfig::Constant(0),
            transaction_submitter: TransactionSubmitterConfig::default(),
            mailbox_process_alt: None,
            process_alt_overrides: vec![],
        };

        let rpc_client = SealevelFallbackRpcClient::from_urls(None, vec![url], Default::default());
        let provider = Arc::new(SealevelProvider::new(
            rpc_client,
            domain.clone(),
            &[mailbox_h256],
            &conf,
        ));
        let locator = hyperlane_core::ContractLocator::new(&domain, mailbox_h256);
        let tx_submitter: Arc<dyn crate::tx_submitter::TransactionSubmitter> =
            Arc::new(RpcTransactionSubmitter::new(provider.clone()));

        let keypair =
            read_keypair_file(&keypair_path).expect("read keypair from SOLANA_PAYER_KEYPAIR");
        let payer = SealevelKeypair::new(keypair);

        let mailbox =
            SealevelMailbox::new(provider, tx_submitter.clone(), &conf, &locator, Some(payer))
                .expect("mailbox construction");

        // -- get_process_payload should have NO ALT --
        let payload = mailbox
            .get_process_payload(&message, &metadata)
            .await
            .expect("get_process_payload should succeed");

        assert_eq!(
            payload.alt_address, None,
            "No ALT should be resolved when no overrides are configured"
        );

        // -- build legacy tx (no ALT) and attempt simulation --
        let payer_ref = mailbox.get_payer().expect("payer");
        let tx_result = mailbox
            .provider
            .create_transaction_for_instruction(
                1_400_000,
                0,
                payload.instruction,
                payer_ref,
                tx_submitter,
                false, // unsigned
                None,  // no ALT
            )
            .await;

        // Either tx construction fails (too large to serialize) or simulation fails
        match tx_result {
            Err(e) => {
                let err_str = format!("{e:?}");
                println!("Transaction construction failed (expected): {err_str}");
                assert!(
                    err_str.contains("too large")
                        || err_str.contains("Too large")
                        || err_str.contains("TransactionTooLarge")
                        || err_str.contains("transaction is too large"),
                    "Expected a 'too large' error without ALT, got: {err_str}"
                );
            }
            Ok(tx) => {
                assert!(
                    matches!(&tx, crate::tx_type::SealevelTxType::Legacy(_)),
                    "Expected legacy transaction when no ALT is provided"
                );

                let sim_result = mailbox
                    .provider
                    .rpc_client()
                    .simulate_sealevel_tx(&tx)
                    .await;

                match sim_result {
                    Err(e) => {
                        let err_str = format!("{e:?}");
                        println!("Simulation RPC failed (expected): {err_str}");
                        assert!(
                            err_str.contains("too large")
                                || err_str.contains("Too large")
                                || err_str.contains("TransactionTooLarge"),
                            "Expected a 'too large' error without ALT, got: {err_str}"
                        );
                    }
                    Ok(sim) => {
                        panic!(
                            "Expected transaction to fail without ALT, but simulation succeeded: {sim:?}"
                        );
                    }
                }
            }
        }

        println!("Integration test passed: transaction is too large without ALT, as expected");
    }
}
