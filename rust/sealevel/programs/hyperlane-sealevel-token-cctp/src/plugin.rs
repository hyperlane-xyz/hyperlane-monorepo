//! The `HyperlaneSealevelTokenPlugin` implementation for CCTP.
//!
//! `transfer_out` is a no-op here — unlike `CollateralPlugin`, this plugin
//! doesn't hold any pooled balance to release: the mint happens via a direct
//! CPI into Circle's real `MessageTransmitterV2.receive_message` (receiver =
//! `TokenMessengerMinterV2`), done inside this program's own `Verify()` (its
//! `InterchainSecurityModuleInstruction` implementation, in `ism.rs`) — by
//! the time the generic `Handle()` flow reaches `transfer_out`, the
//! recipient's tokens have already arrived.
//!
//! `transfer_in`, by contrast, does the real work: it escrows the sender's
//! USDC into this program's `ata_payer` PDA's own associated token account,
//! then burns from there via a direct CPI into Circle's real
//! `TokenMessengerMinterV2.deposit_for_burn` — passing `ata_payer` itself as
//! Circle's `owner`, so Circle records `ata_payer` as the burn's
//! `messageSender`. This is what lets the EVM side recognize the burn:
//! `TokenBridgeCctpBase.cctpAuthorityOverrides` is configured with this exact
//! `ata_payer` PDA per Sealevel origin domain, since a Solana program can
//! never make its own literal address appear as a CPI signer — only PDAs
//! derived from it, which is why `owner` can't be this program's
//! `program_id` and must instead be a PDA it signs for via `invoke_signed`.
//!
//! This only works because the generic `HyperlaneSealevelTokenPlugin::
//! transfer_in` signature carries `destination_domain`/`recipient` — unlike
//! every other plugin, CCTP's custody step *is* the cross-chain leg (the
//! burn embeds the Circle destination domain and mint recipient directly),
//! so it needs to know both at the point value is taken into custody, not
//! just later when the generic dispatch machinery formats the outbound
//! Hyperlane message.

use account_utils::{create_pda_account, verify_rent_exempt};
use hyperlane_core::H256;
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneToken, processor::HyperlaneSealevelTokenPlugin,
};
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::SerializableAccountMeta;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use spl_token_2022::instruction::transfer_checked;

use crate::{
    accounts::{derive_ata_payer_pda, derive_remote_config_pda, CctpPlugin, RemoteConfigAccount},
    circle::{self, deposit_for_burn_instruction, DepositForBurnParams},
    hyperlane_token_cctp_ata_payer_pda_seeds,
};

impl HyperlaneSealevelTokenPlugin for CctpPlugin {
    /// Accounts:
    /// 0. `[executable]` The SPL token program for the mint (token or
    ///    token-2022).
    /// 1. `[]` The USDC mint.
    /// 2. `[writeable]` The ATA-payer PDA account.
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        system_program: &'a AccountInfo<'b>,
        _token_account_info: &'a AccountInfo<'b>,
        payer_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        let spl_token_account_info = next_account_info(accounts_iter)?;
        if spl_token_account_info.key != &spl_token_2022::id()
            && spl_token_account_info.key != &spl_token::id()
        {
            return Err(ProgramError::IncorrectProgramId);
        }

        let mint_account_info = next_account_info(accounts_iter)?;
        if mint_account_info.owner != spl_token_account_info.key {
            return Err(ProgramError::IllegalOwner);
        }

        let ata_payer_account_info = next_account_info(accounts_iter)?;
        let (ata_payer_key, ata_payer_bump) = crate::accounts::derive_ata_payer_pda(program_id);
        if &ata_payer_key != ata_payer_account_info.key {
            return Err(ProgramError::IncorrectProgramId);
        }
        // Owned by the system program (same reasoning as
        // CollateralPlugin's ata_payer): the ATA program requires its payer
        // to hold no data, and calls into the system program with this PDA
        // as payer via invoke_signed.
        let rent = Rent::get()?;
        create_pda_account(
            payer_account_info,
            &rent,
            0,
            &solana_system_interface::program::ID,
            system_program,
            ata_payer_account_info,
            crate::hyperlane_token_cctp_ata_payer_pda_seeds!(ata_payer_bump),
        )?;

        Ok(Self {
            spl_token_program: *spl_token_account_info.key,
            mint: *mint_account_info.key,
            ata_payer_bump,
        })
    }

    /// Escrows the sender's USDC into `ata_payer`'s own ATA, then burns from
    /// there via a direct CPI into Circle's real
    /// `TokenMessengerMinterV2.deposit_for_burn`. See module docs.
    ///
    /// Accounts, in order:
    /// 0.  `[]` The remote-config PDA for `destination_domain`.
    /// 1.  `[writable]` The sender's USDC token account (escrow transfer
    ///     source) — `sender_wallet` (given directly, not via `accounts_iter`)
    ///     is its authority.
    /// 2.  `[signer, writable]` The event-rent payer for Circle's CPI.
    /// 3.  `[writable]` This program's `ata_payer` PDA (derived, checked) —
    ///     funds idempotent escrow-ATA creation and signs, via
    ///     `invoke_signed`, both the escrow ATA creation and Circle's `owner`
    ///     role below.
    /// 4.  `[writable]` `ata_payer`'s own associated token account for the
    ///     USDC mint (escrow account — burned from).
    /// 5.  `[]` `TokenMessengerMinterV2`'s `sender_authority` PDA (Circle
    ///     signs this internally via its own `invoke_signed` — we never sign
    ///     it).
    /// 6.  `[]` `ata_payer`'s `denylist_account` PDA.
    /// 7.  `[writable]` Circle's `message_transmitter` global config PDA.
    /// 8.  `[]` Circle's `token_messenger` singleton config (trusted as
    ///     supplied — seeds not independently confirmed, same open item noted
    ///     in `ism.rs`).
    /// 9.  `[]` The `remote_token_messenger` PDA for the destination Circle
    ///     domain.
    /// 10. `[]` Circle's `token_minter` singleton config (same caveat as 8).
    /// 11. `[writable]` The `local_token` PDA for the USDC mint.
    /// 12. `[writable]` The USDC mint.
    /// 13. `[signer, writable]` A fresh, uninitialized account for Circle's
    ///     `message_sent_event_data`.
    /// 14. `[]` `MessageTransmitterV2`'s own program account.
    /// 15. `[]` `TokenMessengerMinterV2`'s own program account.
    /// 16. `[executable]` The SPL token program.
    /// 17. `[executable]` The system program.
    /// 18. `[]` `TokenMessengerMinterV2`'s `event_authority` PDA.
    /// 19. `[executable]` The SPL associated-token-account program (needed
    ///     for idempotent escrow-ATA creation).
    fn transfer_in<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
        _fee: Option<(u64, &'a AccountInfo<'b>)>,
        destination_domain: u32,
        recipient: H256,
    ) -> Result<(), ProgramError> {
        // Account 0: The remote-config PDA for `destination_domain`.
        let remote_config_info = next_account_info(accounts_iter)?;
        let (remote_config_key, _) = derive_remote_config_pda(program_id, destination_domain);
        if *remote_config_info.key != remote_config_key {
            return Err(ProgramError::InvalidArgument);
        }
        let remote_config =
            RemoteConfigAccount::fetch_data(&mut &remote_config_info.data.borrow()[..])?
                .ok_or(ProgramError::UninitializedAccount)?;

        // Account 1: The sender's USDC token account (escrow transfer source).
        let owner_token_account_info = next_account_info(accounts_iter)?;

        // Account 2: The event-rent payer for Circle's CPI.
        let event_rent_payer_info = next_account_info(accounts_iter)?;

        // Account 3: This program's `ata_payer` PDA.
        let ata_payer_info = next_account_info(accounts_iter)?;
        let (ata_payer_key, ata_payer_bump) = derive_ata_payer_pda(program_id);
        if *ata_payer_info.key != ata_payer_key {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 4: `ata_payer`'s own associated token account for the USDC mint.
        let ata_payer_ata_info = next_account_info(accounts_iter)?;

        // Account 5: `TokenMessengerMinterV2`'s `sender_authority` PDA.
        let sender_authority_info = next_account_info(accounts_iter)?;
        let (expected_sender_authority, _) = circle::derive_token_messenger_sender_authority_pda();
        if *sender_authority_info.key != expected_sender_authority {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 6: `ata_payer`'s `denylist_account` PDA. Circle's denylist
        // is keyed by whatever `owner` we pass it below — `ata_payer`, not
        // the real sender — so this can only ever block the whole route,
        // never an individual end user.
        let denylist_account_info = next_account_info(accounts_iter)?;
        let (expected_denylist_account, _) = circle::derive_denylist_account_pda(&ata_payer_key);
        if *denylist_account_info.key != expected_denylist_account {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 7: Circle's `message_transmitter` global config PDA.
        let message_transmitter_info = next_account_info(accounts_iter)?;
        let (expected_message_transmitter, _) = circle::derive_message_transmitter_pda();
        if *message_transmitter_info.key != expected_message_transmitter {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 8: Circle's `token_messenger` singleton config.
        let token_messenger_info = next_account_info(accounts_iter)?;

        // Account 9: The `remote_token_messenger` PDA for the destination Circle domain.
        let remote_token_messenger_info = next_account_info(accounts_iter)?;
        let (expected_remote_token_messenger, _) =
            circle::derive_remote_token_messenger_pda(remote_config.circle_domain);
        if *remote_token_messenger_info.key != expected_remote_token_messenger {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 10: Circle's `token_minter` singleton config.
        let token_minter_info = next_account_info(accounts_iter)?;

        // Account 11: The `local_token` PDA for the USDC mint.
        let local_token_info = next_account_info(accounts_iter)?;
        let (expected_local_token, _) = circle::derive_local_token_pda(&token.plugin_data.mint);
        if *local_token_info.key != expected_local_token {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 12: The USDC mint.
        let burn_token_mint_info = next_account_info(accounts_iter)?;
        if *burn_token_mint_info.key != token.plugin_data.mint {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 13: A fresh account for Circle's `message_sent_event_data`.
        let message_sent_event_data_info = next_account_info(accounts_iter)?;

        // Account 14: `MessageTransmitterV2`'s own program account.
        let message_transmitter_program_info = next_account_info(accounts_iter)?;
        if *message_transmitter_program_info.key != circle::message_transmitter::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 15: `TokenMessengerMinterV2`'s own program account.
        let token_messenger_minter_program_info = next_account_info(accounts_iter)?;
        if *token_messenger_minter_program_info.key != circle::token_messenger_minter::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 16: The SPL token program.
        let token_program_info = next_account_info(accounts_iter)?;
        if *token_program_info.key != token.plugin_data.spl_token_program {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 17: The system program.
        let system_program_info = next_account_info(accounts_iter)?;
        if *system_program_info.key != solana_system_interface::program::ID {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 18: `TokenMessengerMinterV2`'s `event_authority` PDA.
        let event_authority_info = next_account_info(accounts_iter)?;
        let (expected_event_authority, _) =
            circle::derive_event_authority_pda(&circle::token_messenger_minter::ID);
        if *event_authority_info.key != expected_event_authority {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 19: The SPL associated-token-account program (idempotent
        // escrow-ATA creation). Not referenced directly — `invoke_signed()`
        // resolves the CPI target from the built `Instruction`'s own
        // `program_id`, cross-checked against the current instruction's full
        // account set — this account just needs to be present somewhere in
        // that set, which consuming it here satisfies.
        let _ata_program_info = next_account_info(accounts_iter)?;

        // Ensure `ata_payer`'s own escrow ATA exists before transferring into it.
        invoke_signed(
            &create_associated_token_account_idempotent(
                ata_payer_info.key,
                ata_payer_info.key,
                burn_token_mint_info.key,
                token_program_info.key,
            ),
            &[
                ata_payer_info.clone(),
                ata_payer_ata_info.clone(),
                ata_payer_info.clone(),
                burn_token_mint_info.clone(),
                system_program_info.clone(),
                token_program_info.clone(),
            ],
            &[hyperlane_token_cctp_ata_payer_pda_seeds!(ata_payer_bump)],
        )?;
        verify_rent_exempt(ata_payer_info, &Rent::get()?)?;

        // Move the sender's USDC into escrow — authorized by the sender
        // themselves, who is a normal signer of this transaction.
        invoke(
            &transfer_checked(
                token_program_info.key,
                owner_token_account_info.key,
                burn_token_mint_info.key,
                ata_payer_ata_info.key,
                sender_wallet.key,
                &[],
                amount,
                token.decimals,
            )?,
            &[
                owner_token_account_info.clone(),
                burn_token_mint_info.clone(),
                ata_payer_ata_info.clone(),
                sender_wallet.clone(),
            ],
        )?;

        let params = DepositForBurnParams {
            amount,
            destination_domain: remote_config.circle_domain,
            mint_recipient: Pubkey::new_from_array(recipient.into()),
            // Permissionless — Hyperlane relaying/delivery is permissionless
            // by design, so this hook never restricts who can deliver the
            // attested CCTP message downstream.
            destination_caller: Pubkey::new_from_array([0u8; 32]),
            max_fee: remote_config.max_fee,
            min_finality_threshold: remote_config.min_finality_threshold,
        };

        let ixn = deposit_for_burn_instruction(
            ata_payer_key,
            *event_rent_payer_info.key,
            *ata_payer_ata_info.key,
            *message_transmitter_info.key,
            *token_messenger_info.key,
            *token_minter_info.key,
            *burn_token_mint_info.key,
            *message_sent_event_data_info.key,
            *token_program_info.key,
            *system_program_info.key,
            params,
        )?;

        invoke_signed(
            &ixn,
            &[
                ata_payer_info.clone(),
                event_rent_payer_info.clone(),
                sender_authority_info.clone(),
                ata_payer_ata_info.clone(),
                denylist_account_info.clone(),
                message_transmitter_info.clone(),
                token_messenger_info.clone(),
                remote_token_messenger_info.clone(),
                token_minter_info.clone(),
                local_token_info.clone(),
                burn_token_mint_info.clone(),
                message_sent_event_data_info.clone(),
                message_transmitter_program_info.clone(),
                token_messenger_minter_program_info.clone(),
                token_program_info.clone(),
                system_program_info.clone(),
                event_authority_info.clone(),
            ],
            &[hyperlane_token_cctp_ata_payer_pda_seeds!(ata_payer_bump)],
        )?;

        Ok(())
    }

    fn fee_beneficiary_pubkey(
        _token: &HyperlaneToken<Self>,
        _beneficiary_owner: &Pubkey,
    ) -> Result<Pubkey, ProgramError> {
        // Hyperlane-level fees aren't supported for this route — Circle's
        // own fee mechanism (RemoteConfig.max_fee) is the only fee that
        // applies. Fail closed rather than silently accepting a fee config
        // that would never actually be collected.
        Err(ProgramError::InvalidInstructionData)
    }

    /// No-op — the mint already happened via this program's own `Verify()`
    /// CPI into Circle's real `receive_message` before `Handle()` (and thus
    /// this) runs. See module docs.
    fn transfer_out<'a, 'b>(
        _program_id: &Pubkey,
        _token: &HyperlaneToken<Self>,
        _system_program: &'a AccountInfo<'b>,
        _recipient_wallet: &'a AccountInfo<'b>,
        _accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        _amount: u64,
    ) -> Result<(), ProgramError> {
        Ok(())
    }

    fn transfer_out_account_metas(
        _program_id: &Pubkey,
        _token: &HyperlaneToken<Self>,
        _token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError> {
        // No accounts needed — transfer_out is a no-op.
        Ok((vec![], false))
    }
}
