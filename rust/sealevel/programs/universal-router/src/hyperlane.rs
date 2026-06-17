//! Hyperlane mailbox message-recipient interface.
//!
//! The mailbox calls four discriminated instructions on recipient programs.
//! Only commit messages arrive via the Handle path — reveal is always called
//! directly by the relayer (RouterInstruction::Reveal), never via the mailbox.
//!
//! Uses `MessageRecipientInstruction` from `hyperlane-sealevel-message-recipient-interface`
//! for decoding and uses `SimulationReturnData<Vec<SerializableAccountMeta>>` from
//! `serializable-account-meta` for the HandleAccountMetas return value.
//!
//! Mailbox Handle account layout (commit only):
//!   [0] process_authority  signer
//!   [1] fee_payer_pda      writable
//!   [2] pending_swap       writable  (created here)
//!   [3] system_program

use hyperlane_sealevel_mailbox::mailbox_process_authority_pda_seeds;
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    msg,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::instruction as system_instruction;

use crate::{
    constants::{FEE_PAYER_SEED, HYPERLANE_MAILBOX_PROGRAM_ID, PENDING_SWAP_SEED},
    error::RouterError,
    types::PendingSwap,
};

/// Commit message body: commitment(32) || userSalt(32) || recipient(32) = 96 bytes.
/// userSalt = TypeCasts.addressToBytes32(msgSender()) on EVM — mirrors the ICA userSalt.
/// No discriminant needed — only commit messages arrive via the mailbox.
const COMMIT_BODY_LEN: usize = 96;

// ---------------------------------------------------------------------------
// Entry point from processor.rs
// ---------------------------------------------------------------------------

pub fn process_message_recipient<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: MessageRecipientInstruction,
) -> ProgramResult {
    match ix {
        MessageRecipientInstruction::InterchainSecurityModule => {
            // Return None — mailbox uses its default ISM
            let none: Option<Pubkey> = None;
            let encoded = borsh::to_vec(&none).map_err(|_| ProgramError::BorshIoError)?;
            set_return_data(&encoded);
            Ok(())
        }
        MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
            let empty: Vec<SerializableAccountMeta> = vec![];
            let ret = SimulationReturnData::new(empty);
            let encoded = borsh::to_vec(&ret).map_err(|_| ProgramError::BorshIoError)?;
            set_return_data(&encoded);
            Ok(())
        }
        MessageRecipientInstruction::Handle(handle) => {
            handle_dispatch(program_id, accounts, handle)
        }
        MessageRecipientInstruction::HandleAccountMetas(handle) => {
            handle_account_metas_dispatch(program_id, &handle)
        }
    }
}

// ---------------------------------------------------------------------------
// Handle — route by discriminant byte then length
// ---------------------------------------------------------------------------

fn handle_dispatch<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    handle: HandleInstruction,
) -> ProgramResult {
    if handle.message.len() == COMMIT_BODY_LEN {
        handle_commit(program_id, accounts, handle)
    } else {
        Err(RouterError::InvalidInputs.into())
    }
}

// ---------------------------------------------------------------------------
// Commit handler
//
// Body (96 bytes): commitment(0..32) || userSalt(32..64) || recipient(64..96)
// userSalt = TypeCasts.addressToBytes32(msgSender()) — EVM caller, mirrors ICA userSalt.
// ---------------------------------------------------------------------------

fn handle_commit<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    handle: HandleInstruction,
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let process_authority = &accounts[0];
    let fee_payer = &accounts[1];
    let swap_info = &accounts[2];
    let system_prog = &accounts[3];

    // Verify the caller is the mailbox process authority PDA
    require_mailbox_process_authority(program_id, process_authority)?;

    let commitment: [u8; 32] = handle.message[0..32]
        .try_into()
        .map_err(|_| RouterError::InvalidInputs)?;
    let user_salt: [u8; 32] = handle.message[32..64]
        .try_into()
        .map_err(|_| RouterError::InvalidInputs)?;
    let recipient =
        Pubkey::try_from(&handle.message[64..96]).map_err(|_| RouterError::InvalidInputs)?;

    // Verify fee_payer is our program PDA
    let (fee_payer_key, fee_payer_bump) =
        Pubkey::find_program_address(&[FEE_PAYER_SEED], program_id);
    if *fee_payer.key != fee_payer_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Derive PDA — seeds include userSalt so different EVM callers get different PDAs
    // even for identical swap payloads, mirroring the ICA derivation pattern.
    let origin_bytes = handle.origin.to_le_bytes();
    let sender_bytes = handle.sender.as_bytes();
    let (swap_key, swap_bump) = Pubkey::find_program_address(
        &[
            PENDING_SWAP_SEED,
            &origin_bytes,
            sender_bytes,
            &user_salt,
            &commitment,
        ],
        program_id,
    );
    if *swap_info.key != swap_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Reject duplicate commits for the same commitment hash
    if !swap_info.data.borrow().is_empty() {
        return Err(RouterError::CommitmentAlreadySet.into());
    }

    // Create the pending_swap account
    let lamports = Rent::get()?.minimum_balance(PendingSwap::LEN);
    invoke_signed(
        &system_instruction::create_account(
            fee_payer.key,
            swap_info.key,
            lamports,
            PendingSwap::LEN as u64,
            program_id,
        ),
        &[fee_payer.clone(), swap_info.clone(), system_prog.clone()],
        &[
            &[FEE_PAYER_SEED, &[fee_payer_bump]],
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                sender_bytes,
                &user_salt,
                &commitment,
                &[swap_bump],
            ],
        ],
    )?;

    let swap = PendingSwap {
        recipient,
        origin_domain: handle.origin,
        bump: swap_bump,
    };
    let mut data = swap_info.data.borrow_mut();
    swap.write_into(&mut data)?;

    msg!(
        "handle_commit: origin={} recipient={}",
        handle.origin,
        recipient
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// HandleAccountMetas
// ---------------------------------------------------------------------------

fn handle_account_metas_dispatch(program_id: &Pubkey, handle: &HandleInstruction) -> ProgramResult {
    if handle.message.len() == COMMIT_BODY_LEN {
        handle_account_metas_commit(program_id, handle)
    } else {
        Err(RouterError::InvalidInputs.into())
    }
}

fn handle_account_metas_commit(program_id: &Pubkey, handle: &HandleInstruction) -> ProgramResult {
    let (fee_payer_key, _) = Pubkey::find_program_address(&[FEE_PAYER_SEED], program_id);
    let origin_bytes = handle.origin.to_le_bytes();
    let commitment: [u8; 32] = handle.message[0..32]
        .try_into()
        .map_err(|_| RouterError::InvalidInputs)?;
    let user_salt: [u8; 32] = handle.message[32..64]
        .try_into()
        .map_err(|_| RouterError::InvalidInputs)?;
    let sender_bytes = handle.sender.as_bytes();
    let (swap_key, _) = Pubkey::find_program_address(
        &[
            PENDING_SWAP_SEED,
            &origin_bytes,
            sender_bytes,
            &user_salt,
            &commitment,
        ],
        program_id,
    );
    let metas: Vec<SerializableAccountMeta> = vec![
        SerializableAccountMeta {
            pubkey: fee_payer_key,
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: swap_key,
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: solana_system_interface::program::id(),
            is_signer: false,
            is_writable: false,
        },
    ];
    let encoded =
        borsh::to_vec(&SimulationReturnData::new(metas)).map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&encoded);
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Verify that `account` is the Hyperlane mailbox process authority PDA for this program.
/// Seeds (from the mailbox program): ["hyperlane", "-", "process_authority", "-", recipient_program_id]
fn require_mailbox_process_authority(program_id: &Pubkey, account: &AccountInfo) -> ProgramResult {
    if !account.is_signer {
        return Err(RouterError::UnauthorizedMailbox.into());
    }
    let (expected_pa, _) = Pubkey::find_program_address(
        mailbox_process_authority_pda_seeds!(program_id),
        &HYPERLANE_MAILBOX_PROGRAM_ID,
    );
    if *account.key != expected_pa {
        return Err(RouterError::UnauthorizedMailbox.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        constants::{FEE_PAYER_SEED, PENDING_SWAP_SEED},
        error::RouterError,
    };
    use hyperlane_core::H256;
    use hyperlane_sealevel_message_recipient_interface::HandleInstruction;
    use solana_program::{account_info::AccountInfo, keccak, pubkey::Pubkey};

    fn make_account<'a>(
        key: &'a Pubkey,
        is_signer: bool,
        lamports: &'a mut u64,
        data: &'a mut Vec<u8>,
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(
            key,
            is_signer,
            false,
            lamports,
            data.as_mut_slice(),
            owner,
            false,
        )
    }

    fn make_handle(origin: u32, sender: [u8; 32], message: Vec<u8>) -> HandleInstruction {
        HandleInstruction {
            origin,
            sender: H256::from(sender),
            message,
        }
    }

    // -----------------------------------------------------------------------
    // handle_dispatch: routing by length only
    // -----------------------------------------------------------------------

    #[test]
    fn test_handle_dispatch_invalid_body_wrong_length() {
        let prog = Pubkey::new_unique();
        // Only 96-byte bodies are valid; all other lengths return InvalidInputs
        for len in [0usize, 1, 32, 63, 64, 65, 95, 97] {
            let handle = make_handle(1, [0u8; 32], vec![0u8; len]);
            let result = handle_dispatch(&prog, &[], handle);
            assert_eq!(
                result,
                Err(RouterError::InvalidInputs.into()),
                "body len {} should be InvalidInputs",
                len
            );
        }
    }

    #[test]
    fn test_handle_dispatch_commit_body_routes_to_commit() {
        let prog = Pubkey::new_unique();
        // 96-byte body routes to handle_commit → InsufficientAccounts (0 accounts passed)
        let handle = make_handle(1, [0u8; 32], vec![0u8; 96]);
        let result = handle_dispatch(&prog, &[], handle);
        assert_eq!(result, Err(RouterError::InsufficientAccounts.into()));
    }

    // -----------------------------------------------------------------------
    // require_mailbox_process_authority: non-signer is rejected
    // -----------------------------------------------------------------------

    #[test]
    fn test_require_mailbox_process_authority_not_signer() {
        let prog = Pubkey::new_unique();
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let account = make_account(
            &key,
            false, /* not signer */
            &mut lamports,
            &mut data,
            &owner,
        );

        let result = require_mailbox_process_authority(&prog, &account);
        assert_eq!(result, Err(RouterError::UnauthorizedMailbox.into()));
    }

    #[test]
    fn test_require_mailbox_process_authority_wrong_key() {
        let prog = Pubkey::new_unique();
        let wrong_key = Pubkey::new_unique(); // not the real PDA
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        // is_signer = true but wrong key
        let account = make_account(&wrong_key, true, &mut lamports, &mut data, &owner);

        let result = require_mailbox_process_authority(&prog, &account);
        assert_eq!(result, Err(RouterError::UnauthorizedMailbox.into()));
    }

    // -----------------------------------------------------------------------
    // handle_commit: unauthorized process authority
    // -----------------------------------------------------------------------

    #[test]
    fn test_handle_commit_unauthorized_when_not_signer() {
        let prog = Pubkey::new_unique();
        let key0 = Pubkey::new_unique();
        let key1 = Pubkey::new_unique();
        let key2 = Pubkey::new_unique();
        let key3 = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut l0 = 0u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut d0 = vec![];
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];

        // accounts[0] is not a signer → UnauthorizedMailbox (before any PDA check)
        let accounts = vec![
            make_account(&key0, false, &mut l0, &mut d0, &owner), // process_authority, not signer
            make_account(&key1, false, &mut l1, &mut d1, &owner),
            make_account(&key2, false, &mut l2, &mut d2, &owner),
            make_account(&key3, false, &mut l3, &mut d3, &owner),
        ];
        // Build correctly-formatted commit body (96 bytes: commitment || recipient || userSalt)
        let handle = make_handle(1, [0u8; 32], vec![0u8; 96]);
        let result = handle_commit(&prog, &accounts, handle);
        assert_eq!(result, Err(RouterError::UnauthorizedMailbox.into()));
    }

    // -----------------------------------------------------------------------
    // Commitment derivation: keccak256(cmd_bytes || salt)
    // -----------------------------------------------------------------------

    #[test]
    fn test_commitment_derivation_is_keccak_of_cmds_then_salt() {
        let cmd_bytes = b"borsh_encoded_commands";
        let salt = [0x42u8; 32];

        let mut preimage = cmd_bytes.to_vec();
        preimage.extend_from_slice(&salt);
        let commitment = keccak::hash(&preimage).to_bytes();

        // Changing the salt produces a different commitment
        let mut preimage2 = cmd_bytes.to_vec();
        preimage2.extend_from_slice(&[0x00u8; 32]);
        let commitment2 = keccak::hash(&preimage2).to_bytes();

        assert_ne!(
            commitment, commitment2,
            "different salts must produce different commitments"
        );

        // Changing cmd_bytes produces a different commitment
        let mut preimage3 = b"different_commands".to_vec();
        preimage3.extend_from_slice(&salt);
        let commitment3 = keccak::hash(&preimage3).to_bytes();

        assert_ne!(
            commitment, commitment3,
            "different payloads must produce different commitments"
        );
    }

    #[test]
    fn test_commitment_derivation_is_deterministic() {
        let cmd_bytes = b"some_payload";
        let salt = [0xFFu8; 32];
        let mut preimage = cmd_bytes.to_vec();
        preimage.extend_from_slice(&salt);

        let c1 = keccak::hash(&preimage).to_bytes();
        let c2 = keccak::hash(&preimage).to_bytes();
        assert_eq!(c1, c2);
    }

    // -----------------------------------------------------------------------
    // PDA derivation: pending_swap seeds are consistent
    // -----------------------------------------------------------------------

    #[test]
    fn test_pending_swap_pda_seeds_are_deterministic() {
        let program_id = Pubkey::new_unique();
        let origin: u32 = 42;
        let sender = [0xABu8; 32];
        let user_salt = [0xEEu8; 32];
        let commitment = [0xCDu8; 32];
        let origin_bytes = origin.to_le_bytes();

        let (key1, bump1) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                &sender,
                &user_salt,
                &commitment,
            ],
            &program_id,
        );
        let (key2, bump2) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                &sender,
                &user_salt,
                &commitment,
            ],
            &program_id,
        );
        assert_eq!(key1, key2);
        assert_eq!(bump1, bump2);
    }

    #[test]
    fn test_pending_swap_pda_differs_by_origin() {
        let program_id = Pubkey::new_unique();
        let sender = [0x11u8; 32];
        let user_salt = [0xFFu8; 32];
        let commitment = [0x22u8; 32];

        let (key1, _) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &1u32.to_le_bytes(),
                &sender,
                &user_salt,
                &commitment,
            ],
            &program_id,
        );
        let (key2, _) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &2u32.to_le_bytes(),
                &sender,
                &user_salt,
                &commitment,
            ],
            &program_id,
        );
        assert_ne!(key1, key2, "different origins produce different PDAs");
    }

    #[test]
    fn test_pending_swap_pda_differs_by_user_salt() {
        let program_id = Pubkey::new_unique();
        let origin_bytes = 1u32.to_le_bytes();
        let sender = [0x11u8; 32];
        let commitment = [0x22u8; 32];

        let (key1, _) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                &sender,
                &[0xAAu8; 32],
                &commitment,
            ],
            &program_id,
        );
        let (key2, _) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                &sender,
                &[0xBBu8; 32],
                &commitment,
            ],
            &program_id,
        );
        assert_ne!(key1, key2, "different userSalts produce different PDAs");
    }

    #[test]
    fn test_pending_swap_pda_differs_by_commitment() {
        let program_id = Pubkey::new_unique();
        let origin_bytes = 1u32.to_le_bytes();
        let sender = [0x11u8; 32];
        let user_salt = [0xFFu8; 32];

        let (key1, _) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                &sender,
                &user_salt,
                &[0xAAu8; 32],
            ],
            &program_id,
        );
        let (key2, _) = Pubkey::find_program_address(
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                &sender,
                &user_salt,
                &[0xBBu8; 32],
            ],
            &program_id,
        );
        assert_ne!(key1, key2, "different commitments produce different PDAs");
    }

    #[test]
    fn test_fee_payer_pda_is_deterministic() {
        let program_id = Pubkey::new_unique();
        let (key1, bump1) = Pubkey::find_program_address(&[FEE_PAYER_SEED], &program_id);
        let (key2, bump2) = Pubkey::find_program_address(&[FEE_PAYER_SEED], &program_id);
        assert_eq!(key1, key2);
        assert_eq!(bump1, bump2);
    }

    // -----------------------------------------------------------------------
    // handle_account_metas_dispatch: routing and invalid body handling
    // -----------------------------------------------------------------------

    #[test]
    fn test_handle_account_metas_dispatch_too_short_returns_invalid_inputs() {
        let prog = Pubkey::new_unique();
        // Only 96-byte bodies are accepted; all others return InvalidInputs
        for len in [0usize, 1, 32, 63, 64, 65, 95, 97] {
            let handle = make_handle(1, [0u8; 32], vec![0u8; len]);
            let result = handle_account_metas_dispatch(&prog, &handle);
            assert_eq!(
                result,
                Err(RouterError::InvalidInputs.into()),
                "body len {} should give InvalidInputs",
                len
            );
        }
    }

    #[test]
    fn test_handle_account_metas_dispatch_commit_body_succeeds() {
        let prog = Pubkey::new_unique();
        let handle = make_handle(1, [0u8; 32], vec![0u8; 96]);
        let result = handle_account_metas_dispatch(&prog, &handle);
        assert!(
            result.is_ok(),
            "valid 96-byte commit body should return Ok and set return data"
        );
    }

    #[test]
    fn test_handle_account_metas_dispatch_wrong_length_rejected() {
        let prog = Pubkey::new_unique();
        for len in [0usize, 64, 95, 97] {
            let handle = make_handle(1, [0u8; 32], vec![0u8; len]);
            let result = handle_account_metas_dispatch(&prog, &handle);
            assert_eq!(
                result,
                Err(RouterError::InvalidInputs.into()),
                "len {len} should be rejected"
            );
        }
    }
}
