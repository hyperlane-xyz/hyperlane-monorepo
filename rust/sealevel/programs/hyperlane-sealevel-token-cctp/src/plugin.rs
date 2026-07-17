//! The `HyperlaneSealevelTokenPlugin` implementation for CCTP.
//!
//! Both `transfer_in` and `transfer_out` are no-ops here — unlike
//! `CollateralPlugin`, this plugin doesn't move any tokens itself:
//! - The burn happens via a direct CPI into Circle's real
//!   `TokenMessengerMinterV2.deposit_for_burn`, done in this program's own
//!   `TransferRemote` handler *before* delegating to the generic
//!   `HyperlaneSealevelToken::transfer_remote_with_memo` (which is what
//!   calls `transfer_in` — by then the burn has already happened).
//! - The mint happens via a direct CPI into Circle's real
//!   `MessageTransmitterV2.receive_message` (receiver =
//!   `TokenMessengerMinterV2`), done inside this program's own
//!   `Verify()` (its `InterchainSecurityModuleInstruction` implementation,
//!   in `ism.rs`) — by the time the generic `Handle()` flow reaches
//!   `transfer_out`, the recipient's tokens have already arrived.
//!
//! `transfer_in`/`transfer_out`'s trait signatures don't carry
//! `destination_domain` or the raw `(burn_message, attestation)` bytes
//! Circle's CPIs need, which is why the real logic lives outside them.

use account_utils::create_pda_account;
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneToken, processor::HyperlaneSealevelTokenPlugin,
};
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::SerializableAccountMeta;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

use crate::accounts::CctpPlugin;

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

    /// No-op — the real burn CPI happens in this program's own
    /// `TransferRemote` handler before the generic dispatch machinery calls
    /// this. See module docs.
    fn transfer_in<'a, 'b>(
        _program_id: &Pubkey,
        _token: &HyperlaneToken<Self>,
        _sender_wallet: &'a AccountInfo<'b>,
        _accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        _amount: u64,
        _fee: Option<(u64, &'a AccountInfo<'b>)>,
    ) -> Result<(), ProgramError> {
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
