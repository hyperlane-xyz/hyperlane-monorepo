//! Router instruction enum for non-Hyperlane entry points.
//!
//! Encoded as a Borsh enum (1-byte variant index + fields). The processor
//! first tries `MessageRecipientInstruction::decode()` for Hyperlane mailbox
//! calls, then falls through to this enum.
//!
//! Account layouts per instruction:
//!
//! Execute / ExecuteWithDeadline:
//!   [0] authority          signer
//!   [1] system_program
//!   [2..] remaining_accounts for commands (consumed by dispatcher)
//!
//! Reveal (direct — not via Hyperlane mailbox):
//!   [0] pending_swap PDA   writable (closed on success, rent → fee_payer_pda)
//!   [1] pda_token_ata      writable (input tokens owned by pending_swap PDA)
//!   [2] fee_payer_pda      writable (receives pending_swap rent on close)
//!   [3] system_program
//!   [4..] swap command accounts
//!
//! ClosePendingSwap:
//!   [0] pending_swap PDA   writable (closed; rent → recipient)
//!   [1] recipient          writable signer (must match PendingSwap.recipient)
//!   [2] pda_ata            writable (ATA owned by PDA; tokens → recipient_ata, rent → recipient)
//!   [3] recipient_ata      writable (receives tokens)
//!   [4] token_program      readonly (SPL Token or Token-2022)
//!   [5] mint               readonly (required for transfer_checked; supports Token-2022 extensions)

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::program_error::ProgramError;

#[derive(BorshSerialize, BorshDeserialize)]
pub enum RouterInstruction {
    /// Execute a batch of commands with no deadline.
    Execute(ExecuteIxn),
    /// Execute a batch of commands; reverts if `deadline` (Unix seconds) has passed.
    ExecuteWithDeadline(ExecuteWithDeadlineIxn),
    /// Directly execute a committed cross-chain swap (without going through the mailbox).
    Reveal(RevealIxn),
    /// Close a stale PendingSwap PDA; only the stored recipient may call this.
    ClosePendingSwap(ClosePendingSwapIxn),
}

impl RouterInstruction {
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct ExecuteIxn {
    pub commands: Vec<u8>,
    pub inputs: Vec<Vec<u8>>,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct ExecuteWithDeadlineIxn {
    pub commands: Vec<u8>,
    pub inputs: Vec<Vec<u8>>,
    pub deadline: i64,
}

/// Direct reveal — mirrors the Anchor `reveal` instruction.
///
/// PDA seeds: [PENDING_SWAP_SEED, origin, sender (EVM UR), user_salt (msgSender bytes32), commitment]
/// `salt` is the random commitment salt: keccak256(message || salt) == stored commitment.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct RevealIxn {
    pub origin: u32,
    pub sender: [u8; 32],
    pub user_salt: [u8; 32],
    pub message: Vec<u8>,
    pub salt: [u8; 32],
}

/// Close a stale PendingSwap and return tokens + rent to `recipient`.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct ClosePendingSwapIxn {
    pub origin: u32,
    pub sender: [u8; 32],
    pub user_salt: [u8; 32],
    pub commitment: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::{BorshDeserialize, BorshSerialize};

    fn roundtrip<T: BorshSerialize + BorshDeserialize>(value: &T) -> T {
        let bytes = borsh::to_vec(value).unwrap();
        T::try_from_slice(&bytes).unwrap()
    }

    #[test]
    fn test_execute_ixn_roundtrip() {
        let ixn = ExecuteIxn {
            commands: vec![0x08, 0x09, 0x0a],
            inputs: vec![vec![1, 2, 3], vec![], vec![4, 5]],
        };
        let decoded = roundtrip(&ixn);
        assert_eq!(decoded.commands, ixn.commands);
        assert_eq!(decoded.inputs, ixn.inputs);
    }

    #[test]
    fn test_execute_ixn_empty() {
        let ixn = ExecuteIxn {
            commands: vec![],
            inputs: vec![],
        };
        let decoded = roundtrip(&ixn);
        assert!(decoded.commands.is_empty());
        assert!(decoded.inputs.is_empty());
    }

    #[test]
    fn test_execute_with_deadline_ixn_roundtrip() {
        let ixn = ExecuteWithDeadlineIxn {
            commands: vec![0x12],
            inputs: vec![vec![9, 8, 7]],
            deadline: 9_999_999_999i64,
        };
        let decoded = roundtrip(&ixn);
        assert_eq!(decoded.commands, ixn.commands);
        assert_eq!(decoded.inputs, ixn.inputs);
        assert_eq!(decoded.deadline, ixn.deadline);
    }

    #[test]
    fn test_execute_with_deadline_negative_deadline() {
        // Deadline can be negative (already-passed timestamp, checked at runtime)
        let ixn = ExecuteWithDeadlineIxn {
            commands: vec![],
            inputs: vec![],
            deadline: -1i64,
        };
        let decoded = roundtrip(&ixn);
        assert_eq!(decoded.deadline, -1i64);
    }

    #[test]
    fn test_reveal_ixn_roundtrip() {
        let ixn = RevealIxn {
            origin: 1234,
            sender: [0xAAu8; 32],
            user_salt: [0xCCu8; 32],
            message: vec![1, 2, 3, 4, 5],
            salt: [0xBBu8; 32],
        };
        let decoded = roundtrip(&ixn);
        assert_eq!(decoded.origin, ixn.origin);
        assert_eq!(decoded.sender, ixn.sender);
        assert_eq!(decoded.user_salt, ixn.user_salt);
        assert_eq!(decoded.message, ixn.message);
        assert_eq!(decoded.salt, ixn.salt);
    }

    #[test]
    fn test_close_pending_swap_ixn_roundtrip() {
        let ixn = ClosePendingSwapIxn {
            origin: 99,
            sender: [0xCCu8; 32],
            user_salt: [0xEEu8; 32],
            commitment: [0xDDu8; 32],
        };
        let decoded = roundtrip(&ixn);
        assert_eq!(decoded.origin, ixn.origin);
        assert_eq!(decoded.sender, ixn.sender);
        assert_eq!(decoded.user_salt, ixn.user_salt);
        assert_eq!(decoded.commitment, ixn.commitment);
    }

    #[test]
    fn test_router_instruction_execute_roundtrip() {
        let ixn = RouterInstruction::Execute(ExecuteIxn {
            commands: vec![0x00, 0x01],
            inputs: vec![vec![10], vec![20]],
        });
        let bytes = borsh::to_vec(&ixn).unwrap();
        let decoded = RouterInstruction::from_instruction_data(&bytes).unwrap();
        match decoded {
            RouterInstruction::Execute(e) => {
                assert_eq!(e.commands, vec![0x00, 0x01]);
                assert_eq!(e.inputs, vec![vec![10], vec![20]]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_router_instruction_execute_with_deadline_roundtrip() {
        let ixn = RouterInstruction::ExecuteWithDeadline(ExecuteWithDeadlineIxn {
            commands: vec![0x08],
            inputs: vec![vec![1, 2, 3, 4, 5, 6, 7, 8]],
            deadline: 1_700_000_000i64,
        });
        let bytes = borsh::to_vec(&ixn).unwrap();
        let decoded = RouterInstruction::from_instruction_data(&bytes).unwrap();
        match decoded {
            RouterInstruction::ExecuteWithDeadline(e) => {
                assert_eq!(e.deadline, 1_700_000_000i64);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_router_instruction_reveal_roundtrip() {
        let ixn = RouterInstruction::Reveal(RevealIxn {
            origin: 7,
            sender: [0x01u8; 32],
            user_salt: [0x03u8; 32],
            message: b"borsh_encoded_payload".to_vec(),
            salt: [0x02u8; 32],
        });
        let bytes = borsh::to_vec(&ixn).unwrap();
        let decoded = RouterInstruction::from_instruction_data(&bytes).unwrap();
        match decoded {
            RouterInstruction::Reveal(r) => {
                assert_eq!(r.origin, 7);
                assert_eq!(r.user_salt, [0x03u8; 32]);
                assert_eq!(r.salt, [0x02u8; 32]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_router_instruction_close_pending_swap_roundtrip() {
        let ixn = RouterInstruction::ClosePendingSwap(ClosePendingSwapIxn {
            origin: 3,
            sender: [0x11u8; 32],
            user_salt: [0x33u8; 32],
            commitment: [0x22u8; 32],
        });
        let bytes = borsh::to_vec(&ixn).unwrap();
        let decoded = RouterInstruction::from_instruction_data(&bytes).unwrap();
        match decoded {
            RouterInstruction::ClosePendingSwap(c) => {
                assert_eq!(c.origin, 3);
                assert_eq!(c.user_salt, [0x33u8; 32]);
                assert_eq!(c.commitment, [0x22u8; 32]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn test_router_instruction_from_invalid_data() {
        assert!(RouterInstruction::from_instruction_data(&[]).is_err());
        assert!(RouterInstruction::from_instruction_data(&[0xFF, 0xFF, 0xFF]).is_err());
    }
}
