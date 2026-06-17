//! Top-level instruction router.

use hyperlane_sealevel_message_recipient_interface::MessageRecipientInstruction;
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, keccak, msg,
    pubkey::Pubkey, sysvar::Sysvar,
};

use crate::{
    constants::{FEE_PAYER_SEED, PENDING_SWAP_SEED},
    dispatcher,
    error::RouterError,
    hyperlane,
    instruction::{
        ClosePendingSwapIxn, ExecuteIxn, ExecuteWithDeadlineIxn, RevealIxn, RouterInstruction,
    },
    modules::utils::{build_token_transfer_checked_ix, read_mint_decimals, read_token_amount},
    types::PendingSwap,
};

pub fn process<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    instruction_data: &[u8],
) -> ProgramResult {
    // Two-pass decode: Hyperlane mailbox discriminants (Handle=33, HandleAccountMetas=194,
    // InterchainSecurityModule=45, ISMAccountMetas=190) are checked first.
    // RouterInstruction Borsh variants use bytes 0-3 (Execute, ExecuteWithDeadline, Reveal,
    // ClosePendingSwap). Since all Hyperlane discriminants are ≥33, no collision is possible.
    if let Ok(msg_ix) = MessageRecipientInstruction::decode(instruction_data) {
        return hyperlane::process_message_recipient(program_id, accounts, msg_ix);
    }

    match RouterInstruction::from_instruction_data(instruction_data)? {
        RouterInstruction::Execute(ix) => execute(program_id, accounts, ix),
        RouterInstruction::ExecuteWithDeadline(ix) => {
            execute_with_deadline(program_id, accounts, ix)
        }
        RouterInstruction::Reveal(ix) => reveal(program_id, accounts, ix),
        RouterInstruction::ClosePendingSwap(ix) => close_pending_swap(program_id, accounts, ix),
    }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

fn execute<'info>(
    _program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: ExecuteIxn,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let authority = &accounts[0];
    if !authority.is_signer {
        return Err(RouterError::UnauthorizedMailbox.into());
    }
    let remaining = &accounts[2..];
    dispatcher::execute_commands(&ix.commands, &ix.inputs, remaining, authority, 0, &[])
}

fn execute_with_deadline<'info>(
    _program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: ExecuteWithDeadlineIxn,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let authority = &accounts[0];
    if !authority.is_signer {
        return Err(RouterError::UnauthorizedMailbox.into());
    }
    let clock = Clock::get()?;
    if clock.unix_timestamp > ix.deadline {
        return Err(RouterError::DeadlinePassed.into());
    }
    let remaining = &accounts[2..];
    dispatcher::execute_commands(&ix.commands, &ix.inputs, remaining, authority, 0, &[])
}

// ---------------------------------------------------------------------------
// Reveal (direct — not via Hyperlane mailbox)
// ---------------------------------------------------------------------------
//
// Accounts:
//   [0] pending_swap PDA   writable
//   [1] pda_token_ata      writable
//   [2] fee_payer_pda      writable (receives pending_swap rent on success)
//   [3] system_program
//   [4..] swap command accounts

pub fn reveal<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: RevealIxn,
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let swap_info = &accounts[0];
    let pda_ata_info = &accounts[1];
    let fee_payer_pda = &accounts[2];
    let swap_accounts = &accounts[4..];

    // Compute commitment and verify pending_swap PDA address
    let origin_bytes = ix.origin.to_le_bytes();
    let commitment = {
        let mut preimage = ix.message.clone();
        preimage.extend_from_slice(&ix.salt);
        keccak::hash(&preimage).to_bytes()
    };
    let (swap_key, swap_bump) = Pubkey::find_program_address(
        &[
            PENDING_SWAP_SEED,
            &origin_bytes,
            &ix.sender,
            &ix.user_salt,
            &commitment,
        ],
        program_id,
    );
    if *swap_info.key != swap_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Verify fee_payer_pda
    let (fee_payer_key, _) = Pubkey::find_program_address(&[FEE_PAYER_SEED], program_id);
    if *fee_payer_pda.key != fee_payer_key {
        return Err(RouterError::InvalidInputs.into());
    }

    if swap_info.data.borrow().is_empty() {
        return Err(RouterError::CommitmentMissing.into());
    }

    // Verify pda_token_ata ownership and non-zero balance
    {
        use solana_program::program_pack::Pack;
        let ata_data = pda_ata_info.data.borrow();
        let ata =
            spl_token::state::Account::unpack(&ata_data).map_err(|_| RouterError::InvalidInputs)?;
        if ata.owner != *swap_info.key {
            return Err(RouterError::InvalidRecipient.into());
        }
        if ata.amount == 0 {
            return Err(RouterError::InsufficientTokenBalance.into());
        }
    }

    // Decode swap payload: borsh((Vec<u8>, Vec<Vec<u8>>))
    let (swap_commands, swap_inputs): (Vec<u8>, Vec<Vec<u8>>) =
        borsh::from_slice(&ix.message).map_err(|_| RouterError::InvalidInputs)?;

    // Execute with pending_swap PDA as signing authority
    // PDA address already proves the commitment — no separate hash check needed
    let bump_bytes = [swap_bump];
    let signer_seeds: &[&[u8]] = &[
        PENDING_SWAP_SEED,
        &origin_bytes,
        ix.sender.as_ref(),
        &ix.user_salt,
        &commitment,
        &bump_bytes,
    ];
    let result = dispatcher::execute_commands(
        &swap_commands,
        &swap_inputs,
        swap_accounts,
        swap_info,
        0,
        &[signer_seeds],
    );

    if result.is_ok() {
        // Close the pending_swap account and return rent to fee_payer_pda
        let swap_lamports = swap_info.lamports();
        **swap_info.try_borrow_mut_lamports()? = 0;
        **fee_payer_pda.try_borrow_mut_lamports()? += swap_lamports;
        swap_info.try_borrow_mut_data()?.fill(0);
    } else {
        // Leave PDA open so recipient can call ClosePendingSwap to recover tokens
        msg!("Swap failed; tokens remain in PDA ATA — recipient calls ClosePendingSwap");
    }

    // Propagate the error: unlike the mailbox path (handle_reveal) which must always
    // consume the message, the direct Reveal instruction should surface swap failures
    // to the caller so they can retry or take corrective action.
    result
}

// ---------------------------------------------------------------------------
// ClosePendingSwap
// ---------------------------------------------------------------------------
//
// Accounts:
//   [0] pending_swap PDA   writable (closed; rent → recipient)
//   [1] recipient          writable signer (must match PendingSwap.recipient)
//   [2] pda_ata            writable (token ATA owned by PDA; tokens → recipient_ata, rent → recipient)
//   [3] recipient_ata      writable (receives tokens from pda_ata)
//   [4] token_program      readonly (SPL Token or Token-2022)
//   [5] mint               readonly (required for transfer_checked; supports Token-2022 extensions)

fn close_pending_swap<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: ClosePendingSwapIxn,
) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let swap_info = &accounts[0];
    let recipient = &accounts[1];
    let pda_ata = &accounts[2];
    let recipient_ata = &accounts[3];
    let token_program = &accounts[4];
    let mint = &accounts[5];

    if !recipient.is_signer {
        return Err(RouterError::InvalidRecipient.into());
    }

    // Verify PDA
    let origin_bytes = ix.origin.to_le_bytes();
    let (swap_key, _) = Pubkey::find_program_address(
        &[
            PENDING_SWAP_SEED,
            &origin_bytes,
            &ix.sender,
            &ix.user_salt,
            &ix.commitment,
        ],
        program_id,
    );
    if *swap_info.key != swap_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Load pending_swap state
    let swap = {
        let data = swap_info.data.borrow();
        if data.is_empty() {
            return Err(RouterError::InvalidInputs.into());
        }
        PendingSwap::from_bytes(&data)?
    };

    if swap.recipient != *recipient.key {
        return Err(RouterError::InvalidRecipient.into());
    }

    // Build PDA signer seeds for token CPI
    let bump_bytes = [swap.bump];
    let signer_seeds: &[&[u8]] = &[
        PENDING_SWAP_SEED,
        &origin_bytes,
        &ix.sender,
        &ix.user_salt,
        &ix.commitment,
        &bump_bytes,
    ];

    // Transfer any remaining tokens from the PDA's ATA to recipient_ata.
    // Uses transfer_checked (requires mint) to correctly handle Token-2022 extensions
    // (e.g. TransferFee, PermanentDelegate, TransferHook) that plain transfer skips.
    {
        let balance = read_token_amount(&pda_ata.data.borrow()).unwrap_or(0);
        if balance > 0 {
            let decimals = read_mint_decimals(&mint.data.borrow())?;
            let transfer_ix = build_token_transfer_checked_ix(
                token_program.key,
                pda_ata.key,
                mint.key,
                recipient_ata.key,
                swap_info.key, // authority = pending_swap PDA
                balance,
                decimals,
            )?;
            solana_program::program::invoke_signed(
                &transfer_ix,
                &[
                    pda_ata.clone(),
                    mint.clone(),
                    recipient_ata.clone(),
                    swap_info.clone(),
                    token_program.clone(),
                ],
                &[signer_seeds],
            )?;
        }
    }

    // Close the pda_ata — sends its rent lamports to recipient
    let close_ata_ix = spl_token::instruction::close_account(
        token_program.key,
        pda_ata.key,
        recipient.key,
        swap_info.key,
        &[],
    )?;
    solana_program::program::invoke_signed(
        &close_ata_ix,
        &[
            pda_ata.clone(),
            recipient.clone(),
            swap_info.clone(),
            token_program.clone(),
        ],
        &[signer_seeds],
    )?;

    // Close the pending_swap PDA — transfer lamports to recipient, zero data
    let swap_lamports = swap_info.lamports();
    **swap_info.try_borrow_mut_lamports()? = 0;
    **recipient.try_borrow_mut_lamports()? += swap_lamports;
    swap_info.try_borrow_mut_data()?.fill(0);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        constants::{FEE_PAYER_SEED, PENDING_SWAP_SEED},
        error::RouterError,
        instruction::{ClosePendingSwapIxn, RevealIxn},
        types::PendingSwap,
    };
    use solana_program::{account_info::AccountInfo, keccak, pubkey::Pubkey};

    fn make_account<'a>(
        key: &'a Pubkey,
        is_signer: bool,
        is_writable: bool,
        lamports: &'a mut u64,
        data: &'a mut Vec<u8>,
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(
            key,
            is_signer,
            is_writable,
            lamports,
            data.as_mut_slice(),
            owner,
            false,
        )
    }

    // Build a minimal valid SPL Token account data buffer (165 bytes):
    // owner=[32..64], amount=[64..72], state=Initialized(1) at [108].
    fn make_spl_token_account_data(owner: &Pubkey, amount: u64) -> Vec<u8> {
        let mut data = vec![0u8; 165];
        data[32..64].copy_from_slice(&owner.to_bytes());
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1; // AccountState::Initialized
        data
    }

    // Build a minimal valid SPL Token mint data buffer (82 bytes):
    // decimals at byte [44].
    fn make_spl_mint_data(decimals: u8) -> Vec<u8> {
        let mut data = vec![0u8; 82];
        data[44] = decimals;
        data
    }

    // -----------------------------------------------------------------------
    // close_pending_swap: LOW-1 regression — wrong error variant
    // -----------------------------------------------------------------------

    /// Before the fix, a non-signer recipient returned `UnauthorizedMailbox`.
    /// After the fix it returns `InvalidRecipient`, which has the correct semantics.
    /// This test FAILS on the unfixed code and PASSES after the fix.
    #[test]
    fn test_close_pending_swap_non_signer_returns_invalid_recipient_not_unauthorized_mailbox() {
        let prog = Pubkey::new_unique();
        let swap_key = Pubkey::new_unique();
        let recipient_key = Pubkey::new_unique();
        let pda_ata_key = Pubkey::new_unique();
        let recipient_ata_key = Pubkey::new_unique();
        let token_prog_key = Pubkey::new_unique();
        let mint_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let mut l0 = 100_000u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut d0 = vec![0u8; PendingSwap::LEN];
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d0, &prog),
            make_account(
                &recipient_key,
                false, /* not signer */
                true,
                &mut l1,
                &mut d1,
                &owner,
            ),
            make_account(&pda_ata_key, false, true, &mut l2, &mut d2, &owner),
            make_account(&recipient_ata_key, false, true, &mut l3, &mut d3, &owner),
            make_account(&token_prog_key, false, false, &mut l4, &mut d4, &owner),
            make_account(&mint_key, false, false, &mut l5, &mut d5, &owner),
        ];

        let ix = ClosePendingSwapIxn {
            origin: 1,
            sender: [0u8; 32],
            user_salt: [0u8; 32],
            commitment: [0u8; 32],
        };

        let result = close_pending_swap(&prog, &accounts, ix);
        // AFTER FIX: InvalidRecipient (correct semantic — recipient is not a signer)
        // BEFORE FIX: UnauthorizedMailbox (wrong — that error is for mailbox auth failures)
        assert_eq!(result, Err(RouterError::InvalidRecipient.into()));
    }

    // -----------------------------------------------------------------------
    // close_pending_swap: CRITICAL-1 regression — empty PDA after failed swap
    // -----------------------------------------------------------------------

    /// After the CRITICAL-1 fix, a failed swap leaves the PDA data intact.
    /// ClosePendingSwap must detect empty data (which would mean the PDA was
    /// erroneously closed) and return InvalidInputs.
    /// This test verifies the invariant: if data IS empty, ClosePendingSwap errors.
    #[test]
    fn test_close_pending_swap_empty_pda_data_returns_invalid_inputs() {
        let prog = Pubkey::new_unique();
        let recipient_key = Pubkey::new_unique();
        let pda_ata_key = Pubkey::new_unique();
        let recipient_ata_key = Pubkey::new_unique();
        let token_prog_key = Pubkey::new_unique();
        let mint_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let origin: u32 = 1;
        let sender = [0x11u8; 32];
        let user_salt = [0xEEu8; 32];
        let commitment = [0x22u8; 32];
        let origin_bytes = origin.to_le_bytes();
        let (swap_key, _) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                &sender,
                &user_salt,
                &commitment,
            ],
            &prog,
        );

        let mut l0 = 0u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        // Simulates the BUGGY state: PDA data was zeroed even on swap failure
        let mut d0 = vec![]; // empty data — PDA was erroneously closed
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d0, &prog),
            make_account(&recipient_key, true, true, &mut l1, &mut d1, &owner),
            make_account(&pda_ata_key, false, true, &mut l2, &mut d2, &owner),
            make_account(&recipient_ata_key, false, true, &mut l3, &mut d3, &owner),
            make_account(&token_prog_key, false, false, &mut l4, &mut d4, &owner),
            make_account(&mint_key, false, false, &mut l5, &mut d5, &owner),
        ];

        let ix = ClosePendingSwapIxn {
            origin,
            sender,
            user_salt,
            commitment,
        };
        let result = close_pending_swap(&prog, &accounts, ix);
        // Empty data means the PDA was already closed (bug scenario) — should error
        assert_eq!(result, Err(RouterError::InvalidInputs.into()));
    }

    // -----------------------------------------------------------------------
    // close_pending_swap: CRITICAL-1 positive case — non-empty PDA data
    // -----------------------------------------------------------------------

    /// After the CRITICAL-1 fix, the PDA stays open on swap failure (data non-empty).
    /// ClosePendingSwap must succeed past data validation when data IS present.
    /// This test verifies the validation passes through to PDA key verification.
    #[test]
    fn test_close_pending_swap_valid_pda_data_proceeds_past_empty_check() {
        let prog = Pubkey::new_unique();
        let recipient_key = Pubkey::new_unique();
        let pda_ata_key = Pubkey::new_unique();
        let recipient_ata_key = Pubkey::new_unique();
        let token_prog_key = Pubkey::new_unique();
        let mint_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let origin: u32 = 42;
        let sender = [0xABu8; 32];
        let user_salt = [0xEEu8; 32];
        let commitment = [0xCDu8; 32];
        let origin_bytes = origin.to_le_bytes();
        let (swap_key, swap_bump) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                &sender,
                &user_salt,
                &commitment,
            ],
            &prog,
        );

        let swap = PendingSwap {
            recipient: recipient_key,
            origin_domain: origin,
            bump: swap_bump,
        };
        let swap_data = swap.to_bytes().unwrap();

        let mut l0 = 100_000u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut d0 = swap_data; // non-empty — swap failed but PDA was left open (CRITICAL-1 fix)
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d0, &prog),
            make_account(&recipient_key, true, true, &mut l1, &mut d1, &owner),
            make_account(&pda_ata_key, false, true, &mut l2, &mut d2, &owner),
            make_account(&recipient_ata_key, false, true, &mut l3, &mut d3, &owner),
            make_account(&token_prog_key, false, false, &mut l4, &mut d4, &owner),
            make_account(&mint_key, false, false, &mut l5, &mut d5, &owner),
        ];

        let ix = ClosePendingSwapIxn {
            origin,
            sender,
            user_salt,
            commitment,
        };
        let result = close_pending_swap(&prog, &accounts, ix);
        // Validation passes (swap_key and recipient match); fails at invoke_signed for ATA close.
        // NOT InvalidInputs (empty data) — that's the critical regression we're guarding against.
        assert_ne!(result, Err(RouterError::InvalidInputs.into()),
            "non-empty PDA data must NOT return InvalidInputs — the empty-data check is for the buggy pre-fix state");
    }

    // -----------------------------------------------------------------------
    // close_pending_swap: account count check (now requires 6 accounts)
    // -----------------------------------------------------------------------

    #[test]
    fn test_close_pending_swap_zero_accounts_returns_insufficient() {
        let prog = Pubkey::new_unique();
        let result = close_pending_swap(
            &prog,
            &[],
            ClosePendingSwapIxn {
                origin: 1,
                sender: [0u8; 32],
                user_salt: [0u8; 32],
                commitment: [0u8; 32],
            },
        );
        assert_eq!(result, Err(RouterError::InsufficientAccounts.into()));
    }

    #[test]
    fn test_close_pending_swap_five_accounts_returns_insufficient() {
        // 5 accounts < 6 required (added mint at [5]) → InsufficientAccounts
        let prog = Pubkey::new_unique();
        let k = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut l0 = 0u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut d0 = vec![];
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let accounts = vec![
            make_account(&k, false, false, &mut l0, &mut d0, &owner),
            make_account(&k, false, false, &mut l1, &mut d1, &owner),
            make_account(&k, false, false, &mut l2, &mut d2, &owner),
            make_account(&k, false, false, &mut l3, &mut d3, &owner),
            make_account(&k, false, false, &mut l4, &mut d4, &owner),
        ];
        let result = close_pending_swap(
            &prog,
            &accounts,
            ClosePendingSwapIxn {
                origin: 1,
                sender: [0u8; 32],
                user_salt: [0u8; 32],
                commitment: [0u8; 32],
            },
        );
        assert_eq!(result, Err(RouterError::InsufficientAccounts.into()));
    }

    // -----------------------------------------------------------------------
    // reveal: LOW regression — swap failure must propagate to caller
    // -----------------------------------------------------------------------

    /// Direct reveal() must return the swap error, not swallow it.
    /// BEFORE FIX: result.or(Ok(())) → swap failure returns Ok(()) to caller
    /// AFTER FIX:  result           → Err(UnknownCommand) propagates
    ///
    /// Setup: craft a message that borsh-decodes correctly but contains an
    /// unknown command (0x3F) so the dispatcher returns UnknownCommand.
    #[test]
    fn test_reveal_swap_failure_propagates_to_caller() {
        let prog = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        // Build a message that decodes as valid borsh but has a failing command
        let failing_cmd: u8 = 0x3F; // unknown — hits `_ => UnknownCommand` in dispatcher
        let swap_payload: (Vec<u8>, Vec<Vec<u8>>) = (vec![failing_cmd], vec![vec![]]);
        let message = borsh::to_vec(&swap_payload).unwrap();
        let salt = [0xAAu8; 32];
        let user_salt = [0xBBu8; 32];
        let origin: u32 = 7;
        let sender = [0x12u8; 32];

        // Derive commitment and PDA
        let mut preimage = message.clone();
        preimage.extend_from_slice(&salt);
        let commitment = keccak::hash(&preimage).to_bytes();
        let origin_bytes = origin.to_le_bytes();
        let (swap_key, _) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                &sender,
                &user_salt,
                &commitment,
            ],
            &prog,
        );
        let (fee_payer_key, _) = Pubkey::find_program_address(&[FEE_PAYER_SEED], &prog);

        // ATA data: owner = swap_key, amount = 1000, state = Initialized
        let ata_data = make_spl_token_account_data(&swap_key, 1000);

        let system_program_key = Pubkey::default();
        let pda_ata_key = Pubkey::new_unique();
        let mut l0 = 100_000u64;
        let mut l1 = 0u64;
        let mut l2 = 100_000u64;
        let mut l3 = 0u64;
        let mut d0 = vec![1u8; PendingSwap::LEN]; // non-empty swap data
        let mut d1 = ata_data;
        let mut d2 = vec![];
        let mut d3 = vec![];

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d0, &prog), // [0] pending_swap PDA
            make_account(&pda_ata_key, false, true, &mut l1, &mut d1, &owner), // [1] pda_ata (ATA with balance)
            make_account(&fee_payer_key, false, true, &mut l2, &mut d2, &owner), // [2] fee_payer_pda
            make_account(&system_program_key, false, false, &mut l3, &mut d3, &owner), // [3] system_program
                                                                                       // [4..] swap accounts — empty; failing_cmd 0x3F needs none
        ];

        let ix = RevealIxn {
            origin,
            sender,
            user_salt,
            message,
            salt,
        };
        let result = reveal(&prog, &accounts, ix);

        // BEFORE FIX: Ok(()) — error swallowed by result.or(Ok(()))
        // AFTER FIX:  Err(UnknownCommand) — propagates to caller
        assert_eq!(
            result,
            Err(RouterError::UnknownCommand.into()),
            "swap failure in direct reveal must propagate, not be swallowed"
        );
    }
}
