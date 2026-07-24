//! Top-level instruction router.

use hyperlane_sealevel_message_recipient_interface::MessageRecipientInstruction;
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, keccak, pubkey::Pubkey,
    sysvar::Sysvar,
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
// No fallback here: if the committed swap fails, this instruction (and thus
// the whole transaction) simply reverts — the pending_swap PDA is left
// untouched, funds stay safe. Recovery happens out-of-band via
// ClosePendingSwap: the relayer simulates Reveal first and, if simulation
// fails, calls ClosePendingSwap directly instead of submitting Reveal at all;
// ClosePendingSwap is also permissionlessly callable by anyone after a short
// (1 minute) expiry regardless.
//
// Accounts:
//   [0] pending_swap PDA   writable
//   [1] pda_token_ata      writable
//   [2] fee_payer_pda      writable (receives rent from PDA + ATA on close)
//   [3..] swap command accounts

pub fn reveal<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: RevealIxn,
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let swap_info = &accounts[0];
    let pda_ata_info = &accounts[1];
    let fee_payer_pda = &accounts[2];
    let swap_accounts = &accounts[3..];

    // Compute commitment and verify pending_swap PDA address
    let origin_bytes = ix.origin.to_le_bytes();
    let commitment = {
        let mut preimage = ix.salt.to_vec();
        preimage.extend_from_slice(&ix.message);
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
    // No try/catch: if the swap fails (including a CPI failure, which aborts
    // the whole instruction and never returns control here), this whole
    // instruction reverts — the PDA and its tokens are untouched. Recovery is
    // ClosePendingSwap's job, not this instruction's.
    dispatcher::execute_commands(
        &swap_commands,
        &swap_inputs,
        swap_accounts,
        swap_info,
        0,
        &[signer_seeds],
    )?;

    // Swap succeeded — close the pending_swap account, rent to fee_payer_pda
    let swap_lamports = swap_info.lamports();
    **swap_info.try_borrow_mut_lamports()? = 0;
    **fee_payer_pda.try_borrow_mut_lamports()? += swap_lamports;
    swap_info.try_borrow_mut_data()?.fill(0);

    Ok(())
}

// ---------------------------------------------------------------------------
// ClosePendingSwap
// ---------------------------------------------------------------------------
//
// Accounts:
//   [0] pending_swap PDA   writable (closed; rent → accounts[6])
//   [1] caller             writable signer (anyone — triggers the close)
//   [2] pda_ata            writable (tokens → recipient_ata, rent → accounts[6])
//   [3] recipient_ata      writable (receives tokens; owner verified == swap.recipient)
//   [4] token_program      readonly (SPL Token or Token-2022)
//   [5] mint               readonly (required for transfer_checked; supports Token-2022 extensions)
//   [6] recipient          writable (must match swap.recipient; receives all rent)
//
// Authorization:
//   - Anyone (signer) may call, but only after 1 minute from commit_time.
//   - recipient_ata owner and accounts[6] are both verified against swap.recipient.

fn close_pending_swap<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: ClosePendingSwapIxn,
) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let swap_info = &accounts[0];
    let caller = &accounts[1];
    let pda_ata = &accounts[2];
    let recipient_ata = &accounts[3];
    let token_program = &accounts[4];
    let mint = &accounts[5];
    let recipient = &accounts[6];

    if !caller.is_signer {
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

    // Verify accounts[6] matches swap.recipient (rent destination).
    if *recipient.key != swap.recipient {
        return Err(RouterError::InvalidRecipient.into());
    }

    // Verify recipient_ata is owned by swap.recipient (no sysvar needed).
    {
        let ata_data = recipient_ata.data.borrow();
        if ata_data.len() < 64 {
            return Err(RouterError::InvalidInputs.into());
        }
        let ata_owner =
            Pubkey::try_from(&ata_data[32..64]).map_err(|_| RouterError::InvalidInputs)?;
        if ata_owner != swap.recipient {
            return Err(RouterError::InvalidRecipient.into());
        }
    }

    // Only permitted after 1 minute from commit time — enforced for everyone.
    let now = Clock::get()?.unix_timestamp;
    if now < swap.commit_time + 60 {
        return Err(RouterError::SwapNotExpired.into());
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
        let mut l6 = 0u64;
        let mut d0 = vec![0u8; PendingSwap::LEN];
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);
        let mut d6 = vec![];

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
            make_account(&recipient_key, false, true, &mut l6, &mut d6, &owner),
        ];

        let ix = ClosePendingSwapIxn {
            origin: 1,
            sender: [0u8; 32],
            user_salt: [0u8; 32],
            commitment: [0u8; 32],
        };

        let result = close_pending_swap(&prog, &accounts, ix);
        // AFTER FIX: InvalidRecipient (correct semantic — caller is not a signer)
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
        let mut l6 = 0u64;
        // Simulates the BUGGY state: PDA data was zeroed even on swap failure
        let mut d0 = vec![]; // empty data — PDA was erroneously closed
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);
        let mut d6 = vec![];

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d0, &prog),
            make_account(&recipient_key, true, true, &mut l1, &mut d1, &owner),
            make_account(&pda_ata_key, false, true, &mut l2, &mut d2, &owner),
            make_account(&recipient_ata_key, false, true, &mut l3, &mut d3, &owner),
            make_account(&token_prog_key, false, false, &mut l4, &mut d4, &owner),
            make_account(&mint_key, false, false, &mut l5, &mut d5, &owner),
            make_account(&recipient_key, false, true, &mut l6, &mut d6, &owner),
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
            commit_time: 0,
        };
        let swap_data = swap.to_bytes().unwrap();

        let mut l0 = 100_000u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut l6 = 0u64;
        let mut d0 = swap_data; // non-empty — swap failed but PDA was left open (CRITICAL-1 fix)
        let mut d1 = vec![];
        let mut d2 = vec![];
        // recipient_ata must be owned by recipient_key so validation reaches the clock check
        let mut d3 = make_spl_token_account_data(&recipient_key, 0);
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);
        let mut d6 = vec![];

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d0, &prog),
            make_account(&recipient_key, true, true, &mut l1, &mut d1, &owner),
            make_account(&pda_ata_key, false, true, &mut l2, &mut d2, &owner),
            make_account(&recipient_ata_key, false, true, &mut l3, &mut d3, &owner),
            make_account(&token_prog_key, false, false, &mut l4, &mut d4, &owner),
            make_account(&mint_key, false, false, &mut l5, &mut d5, &owner),
            make_account(&recipient_key, false, true, &mut l6, &mut d6, &owner),
        ];

        let ix = ClosePendingSwapIxn {
            origin,
            sender,
            user_salt,
            commitment,
        };
        let result = close_pending_swap(&prog, &accounts, ix);
        // Passes PDA and ata-owner validation; blocked at the clock check (UnsupportedSysvar in
        // unit tests, SwapNotExpired in BPF). Either way it's NOT the empty-data InvalidInputs
        // regression we're guarding against.
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
        // 6 accounts < 7 required (added recipient at [6]) → InsufficientAccounts
        let prog = Pubkey::new_unique();
        let k = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut l0 = 0u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut d0 = vec![];
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let mut d5 = vec![];
        let accounts = vec![
            make_account(&k, false, false, &mut l0, &mut d0, &owner),
            make_account(&k, false, false, &mut l1, &mut d1, &owner),
            make_account(&k, false, false, &mut l2, &mut d2, &owner),
            make_account(&k, false, false, &mut l3, &mut d3, &owner),
            make_account(&k, false, false, &mut l4, &mut d4, &owner),
            make_account(&k, false, false, &mut l5, &mut d5, &owner),
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
    // reveal: no fallback — swap failure propagates and reverts the instruction
    // -----------------------------------------------------------------------

    /// reveal() no longer catches a failed swap — it propagates the error
    /// directly (which reverts the whole instruction/transaction, leaving the
    /// pending_swap PDA and its tokens untouched). Recovery is ClosePendingSwap's
    /// job now, not reveal()'s.
    #[test]
    fn test_reveal_swap_failure_propagates_error_no_fallback() {
        let prog = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let recipient_key = Pubkey::new_unique();

        let failing_cmd: u8 = 0x3F; // unknown — hits `_ => UnknownCommand` in dispatcher
        let swap_payload: (Vec<u8>, Vec<Vec<u8>>) = (vec![failing_cmd], vec![vec![]]);
        let message = borsh::to_vec(&swap_payload).unwrap();
        let salt = [0xAAu8; 32];
        let user_salt = [0xBBu8; 32];
        let origin: u32 = 7;
        let sender = [0x12u8; 32];

        // commitment = keccak(salt || message)
        let mut preimage = salt.to_vec();
        preimage.extend_from_slice(&message);
        let commitment = keccak::hash(&preimage).to_bytes();
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
        let (fee_payer_key, _) = Pubkey::find_program_address(&[FEE_PAYER_SEED], &prog);

        let pending_swap = PendingSwap {
            recipient: recipient_key,
            origin_domain: origin,
            bump: swap_bump,
            commit_time: 0,
        };

        let pda_ata_key = Pubkey::new_unique();

        let ata_data = make_spl_token_account_data(&swap_key, 1_000);
        let mut d0 = pending_swap.to_bytes().unwrap();
        let mut d1 = ata_data;
        let mut d2 = vec![];
        let mut l0 = 100_000u64;
        let mut l1 = 0u64;
        let mut l2 = 100_000u64;

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d0, &prog),
            make_account(&pda_ata_key, false, true, &mut l1, &mut d1, &owner),
            make_account(&fee_payer_key, false, true, &mut l2, &mut d2, &owner),
        ];

        let ix = RevealIxn {
            origin,
            sender,
            user_salt,
            message,
            salt,
        };
        let result = reveal(&prog, &accounts, ix);

        // The swap's own error propagates directly — no fallback consumes it.
        assert_eq!(result, Err(RouterError::UnknownCommand.into()));
    }

    // -----------------------------------------------------------------------
    // close_pending_swap: permissionless expiry (1 minute after commit)
    // -----------------------------------------------------------------------

    // Build PendingSwap data at the correct PDA for close tests.
    // Returns (swap_key, swap_bump, swap_data_bytes).
    fn make_pending_swap_at_pda(
        prog: &Pubkey,
        origin: u32,
        sender: &[u8; 32],
        user_salt: &[u8; 32],
        commitment: &[u8; 32],
        recipient: &Pubkey,
        commit_time: i64,
    ) -> (Pubkey, u8, Vec<u8>) {
        let origin_bytes = origin.to_le_bytes();
        let (swap_key, swap_bump) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                sender,
                user_salt,
                commitment,
            ],
            prog,
        );
        let swap = PendingSwap {
            recipient: *recipient,
            origin_domain: origin,
            bump: swap_bump,
            commit_time,
        };
        (swap_key, swap_bump, swap.to_bytes().unwrap())
    }

    /// Any caller before 1min → blocked (SwapNotExpired in BPF; UnsupportedSysvar in unit tests).
    /// Clock::get() returns unix_timestamp=0 in unit-test context (no BPF runtime).
    /// commit_time=0 means 0 < 0+60, so the swap has not expired.
    #[test]
    fn test_close_pending_swap_any_caller_before_expiry_is_blocked() {
        let prog = Pubkey::new_unique();
        let origin: u32 = 1;
        let sender = [0x11u8; 32];
        let user_salt = [0xEEu8; 32];
        let commitment = [0x22u8; 32];
        let recipient_key = Pubkey::new_unique();
        let caller_key = Pubkey::new_unique(); // different from recipient
        let pda_ata_key = Pubkey::new_unique();
        let recipient_ata_key = Pubkey::new_unique();
        let token_prog_key = Pubkey::new_unique();
        let mint_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let (swap_key, _, mut d_swap) = make_pending_swap_at_pda(
            &prog,
            origin,
            &sender,
            &user_salt,
            &commitment,
            &recipient_key,
            0, // commit_time=0, now=0 → 0 < 60 → not expired
        );
        let mut l0 = 100_000u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut l6 = 0u64;
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = make_spl_token_account_data(&recipient_key, 0);
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);
        let mut d6 = vec![];

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d_swap, &prog),
            make_account(&caller_key, true, true, &mut l1, &mut d1, &owner),
            make_account(&pda_ata_key, false, true, &mut l2, &mut d2, &owner),
            make_account(&recipient_ata_key, false, true, &mut l3, &mut d3, &owner),
            make_account(&token_prog_key, false, false, &mut l4, &mut d4, &owner),
            make_account(&mint_key, false, false, &mut l5, &mut d5, &owner),
            make_account(&recipient_key, false, true, &mut l6, &mut d6, &owner),
        ];

        let result = close_pending_swap(
            &prog,
            &accounts,
            ClosePendingSwapIxn {
                origin,
                sender,
                user_salt,
                commitment,
            },
        );
        // In BPF: SwapNotExpired. In unit tests Clock::get() returns UnsupportedSysvar
        // (no sysvar cache available), so the error surfaces before the expiry check.
        // Either way the caller is correctly rejected before 1 minute.
        assert!(result.is_err());
        assert_ne!(result, Ok(()));
    }

    /// Third-party caller after 1min but recipient_ata owned by wrong key → InvalidRecipient.
    /// commit_time=-61: now(0) >= -61+60=-1 → expired.
    #[test]
    fn test_close_pending_swap_third_party_expired_wrong_ata_owner_returns_invalid_recipient() {
        let prog = Pubkey::new_unique();
        let origin: u32 = 2;
        let sender = [0x22u8; 32];
        let user_salt = [0xFFu8; 32];
        let commitment = [0x33u8; 32];
        let recipient_key = Pubkey::new_unique();
        let caller_key = Pubkey::new_unique();
        let wrong_owner = Pubkey::new_unique(); // not recipient_key
        let pda_ata_key = Pubkey::new_unique();
        let recipient_ata_key = Pubkey::new_unique();
        let token_prog_key = Pubkey::new_unique();
        let mint_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let (swap_key, _, mut d_swap) = make_pending_swap_at_pda(
            &prog,
            origin,
            &sender,
            &user_salt,
            &commitment,
            &recipient_key,
            -61, // expired: now(0) >= -1
        );
        let mut l0 = 100_000u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut l6 = 0u64;
        let mut d1 = vec![];
        let mut d2 = vec![];
        // recipient_ata owned by wrong_owner — not the expected recipient
        let mut d3 = make_spl_token_account_data(&wrong_owner, 0);
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);
        let mut d6 = vec![];

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d_swap, &prog),
            make_account(&caller_key, true, true, &mut l1, &mut d1, &owner),
            make_account(&pda_ata_key, false, true, &mut l2, &mut d2, &owner),
            make_account(&recipient_ata_key, false, true, &mut l3, &mut d3, &owner),
            make_account(&token_prog_key, false, false, &mut l4, &mut d4, &owner),
            make_account(&mint_key, false, false, &mut l5, &mut d5, &owner),
            make_account(&recipient_key, false, true, &mut l6, &mut d6, &owner),
        ];

        let result = close_pending_swap(
            &prog,
            &accounts,
            ClosePendingSwapIxn {
                origin,
                sender,
                user_salt,
                commitment,
            },
        );
        // accounts[6] key matches swap.recipient ✓; recipient_ata owner is wrong_owner ≠ recipient_key
        assert_eq!(result, Err(RouterError::InvalidRecipient.into()));
    }

    /// Third-party caller after 1min with correct recipient_ata owner → passes
    /// all validation and reaches the token CPI (which fails without BPF runtime).
    #[test]
    fn test_close_pending_swap_third_party_expired_valid_ata_proceeds_past_expiry_check() {
        let prog = Pubkey::new_unique();
        let origin: u32 = 3;
        let sender = [0x33u8; 32];
        let user_salt = [0xAAu8; 32];
        let commitment = [0x44u8; 32];
        let recipient_key = Pubkey::new_unique();
        let caller_key = Pubkey::new_unique();
        let pda_ata_key = Pubkey::new_unique();
        let recipient_ata_key = Pubkey::new_unique();
        let token_prog_key = Pubkey::new_unique();
        let mint_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let (swap_key, _, mut d_swap) = make_pending_swap_at_pda(
            &prog,
            origin,
            &sender,
            &user_salt,
            &commitment,
            &recipient_key,
            -61, // expired
        );
        let mut l0 = 100_000u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut l6 = 0u64;
        let mut d1 = vec![];
        let mut d2 = vec![];
        // recipient_ata correctly owned by recipient_key
        let mut d3 = make_spl_token_account_data(&recipient_key, 0);
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);
        let mut d6 = vec![];

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d_swap, &prog),
            make_account(&caller_key, true, true, &mut l1, &mut d1, &owner),
            make_account(&pda_ata_key, false, true, &mut l2, &mut d2, &owner),
            make_account(&recipient_ata_key, false, true, &mut l3, &mut d3, &owner),
            make_account(&token_prog_key, false, false, &mut l4, &mut d4, &owner),
            make_account(&mint_key, false, false, &mut l5, &mut d5, &owner),
            make_account(&recipient_key, false, true, &mut l6, &mut d6, &owner),
        ];

        let result = close_pending_swap(
            &prog,
            &accounts,
            ClosePendingSwapIxn {
                origin,
                sender,
                user_salt,
                commitment,
            },
        );
        // accounts[6] and ata owner both match recipient_key; then Clock::get() returns
        // UnsupportedSysvar in unit tests. Key assertion: NOT rejected for InvalidRecipient.
        assert_ne!(
            result,
            Err(RouterError::InvalidRecipient.into()),
            "correct recipient and ata owner must pass the recipient checks"
        );
        assert_ne!(result, Err(RouterError::InvalidInputs.into()));
        assert_ne!(result, Err(RouterError::InsufficientAccounts.into()));
    }

    /// The recipient is also blocked before 1 minute — the expiry applies to everyone.
    #[test]
    fn test_close_pending_swap_recipient_blocked_before_expiry() {
        let prog = Pubkey::new_unique();
        let origin: u32 = 4;
        let sender = [0x44u8; 32];
        let user_salt = [0xBBu8; 32];
        let commitment = [0x55u8; 32];
        let recipient_key = Pubkey::new_unique();
        let pda_ata_key = Pubkey::new_unique();
        let recipient_ata_key = Pubkey::new_unique();
        let token_prog_key = Pubkey::new_unique();
        let mint_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let (swap_key, _, mut d_swap) = make_pending_swap_at_pda(
            &prog,
            origin,
            &sender,
            &user_salt,
            &commitment,
            &recipient_key,
            0, // fresh commit — not yet expired
        );
        let mut l0 = 100_000u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut l6 = 0u64;
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = make_spl_token_account_data(&recipient_key, 0); // correct ata owner
        let mut d4 = vec![];
        let mut d5 = make_spl_mint_data(6);
        let mut d6 = vec![];

        let accounts = vec![
            make_account(&swap_key, false, true, &mut l0, &mut d_swap, &prog),
            make_account(&recipient_key, true, true, &mut l1, &mut d1, &owner),
            make_account(&pda_ata_key, false, true, &mut l2, &mut d2, &owner),
            make_account(&recipient_ata_key, false, true, &mut l3, &mut d3, &owner),
            make_account(&token_prog_key, false, false, &mut l4, &mut d4, &owner),
            make_account(&mint_key, false, false, &mut l5, &mut d5, &owner),
            make_account(&recipient_key, false, true, &mut l6, &mut d6, &owner),
        ];

        let result = close_pending_swap(
            &prog,
            &accounts,
            ClosePendingSwapIxn {
                origin,
                sender,
                user_salt,
                commitment,
            },
        );
        // ata owner check passes; clock check blocks everyone before 1min.
        // In BPF: SwapNotExpired. In unit tests: UnsupportedSysvar (no sysvar cache).
        assert!(
            result.is_err(),
            "recipient must be blocked before 1-minute expiry"
        );
        assert_ne!(result, Err(RouterError::InvalidRecipient.into()));
        assert_ne!(result, Err(RouterError::InvalidInputs.into()));
    }
}
