use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// Command byte layout (mirrors EVM UniversalRouter):
///   bit 7: FLAG_ALLOW_REVERT — if set a failed command does not revert the tx
///   bits 0-5: COMMAND_TYPE_MASK — 6-bit command identifier
pub mod commands {
    pub const FLAG_ALLOW_REVERT: u8 = 0x80;
    pub const COMMAND_TYPE_MASK: u8 = 0x3f;

    pub const RAYDIUM_CLMM_SWAP_EXACT_IN: u8 = 0x00;
    pub const RAYDIUM_AMM_SWAP_EXACT_IN: u8 = 0x01;

    pub const WRAP_SOL: u8 = 0x08;
    pub const UNWRAP_WSOL: u8 = 0x09;
    pub const SWEEP: u8 = 0x0a;
    pub const TRANSFER: u8 = 0x0b;

    pub const BRIDGE_TOKEN: u8 = 0x12;
    pub const EXECUTE_CROSS_CHAIN: u8 = 0x13;

    pub const EXECUTE_SUB_PLAN: u8 = 0x21;
}

/// `amount = u64::MAX` means "use the entire balance of the source account"
pub mod amount_sentinels {
    pub const CONTRACT_BALANCE: u64 = u64::MAX;
}

/// Supported Hyperlane bridge asset types
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[borsh(use_discriminant = true)]
pub enum BridgeType {
    HypXerc20 = 0x01,
    HypErc20Collateral = 0x03,
}

impl BridgeType {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0x01 => Some(BridgeType::HypXerc20),
            0x03 => Some(BridgeType::HypErc20Collateral),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Per-command input structs (Borsh-encoded in the `inputs` vector)
// ---------------------------------------------------------------------------

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct RaydiumClmmSwapInput {
    pub amount_in: u64,
    pub amount_out_minimum: u64,
    pub sqrt_price_limit_x64: u128,
    pub is_base_input: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct RaydiumAmmSwapInput {
    pub amount_in: u64,
    pub amount_out_minimum: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct WrapSolInput {
    pub amount: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct SweepInput {
    pub amount_min: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct TransferInput {
    pub amount: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct BridgeTokenInput {
    pub bridge_type: u8,
    pub destination_domain: u32,
    /// bytes32 recipient on destination chain
    pub recipient: [u8; 32],
    pub amount: u64,
    // msg_fee removed: the token router CPI handles IGP payment internally
    /// Random nonce used to derive the unique-message PDA. The encoder generates 8 random bytes
    /// so that repeated bridges to the same recipient produce distinct dispatched-message accounts.
    pub nonce: [u8; 8],
}

/// EXECUTE_CROSS_CHAIN input (0x13)
///
/// Dispatches commit + reveal Hyperlane messages to the EVM ICA router.
/// `commitment` is keccak256(borsh(evm_calldata) || salt), computed off-chain.
#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct ExecuteCrossChainInput {
    pub destination_domain: u32,
    /// EVM ICA router address as bytes32
    pub ica_router: [u8; 32],
    /// OffChainLookupISM address as bytes32 (zero → default)
    pub ism: [u8; 32],
    /// keccak256(abi.encode(evm_calldata) || salt) — pre-computed by SDK
    pub commitment: [u8; 32],
    pub commit_msg_fee: u64,
    pub reveal_msg_fee: u64,
}

// ---------------------------------------------------------------------------
// PendingSwap — on-chain state for in-flight EVM→Solana destination swaps
// ---------------------------------------------------------------------------
//
// PDA seeds: [b"pending_swap", &origin_domain.to_le_bytes(), sender, userSalt, commitment]
// where sender     = EVM UR address (bytes32),
//       userSalt   = TypeCasts.addressToBytes32(msgSender()) — EVM caller, mirrors ICA userSalt,
//       commitment = keccak256(borsh(swap_commands, swap_inputs) || random_salt).
// Body layout: commitment(0..32) || userSalt(32..64) || recipient(64..96) — matches EVM Dispatcher.
//
// Including userSalt as an explicit seed ensures different EVM callers get
// distinct PDAs, mirroring the ICA derivation pattern. Each unique commitment
// gets its own PDA, so multiple in-flight swaps from the same caller coexist.
//
// Stored as raw Borsh (no discriminator prefix). The PDA address itself is
// the commitment proof — no need to store the commitment hash in the account.

#[derive(BorshSerialize, BorshDeserialize, Clone, Default, Debug)]
pub struct PendingSwap {
    /// Solana wallet that receives output tokens (or input tokens on fallback)
    pub recipient: Pubkey,
    /// Origin Hyperlane domain that sent the commitment message
    pub origin_domain: u32,
    /// PDA bump used for signing CPIs on behalf of the PDA
    pub bump: u8,
    /// Unix timestamp (i64) when the commit message was processed on-chain.
    /// Used to gate permissionless ClosePendingSwap: anyone may close after 1 minute.
    pub commit_time: i64,
}

impl PendingSwap {
    /// Serialized size — no discriminator prefix
    pub const LEN: usize = 32 + 4 + 1 + 8; // = 45

    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidAccountData)
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, ProgramError> {
        borsh::to_vec(self).map_err(|_| ProgramError::BorshIoError)
    }

    /// Write `self` into `data[..Self::LEN]`.
    pub fn write_into(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        let serialized = self.to_bytes()?;
        if serialized.len() > data.len() {
            return Err(ProgramError::AccountDataTooSmall);
        }
        data[..serialized.len()].copy_from_slice(&serialized);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::BorshDeserialize;

    // -----------------------------------------------------------------------
    // Command byte constants
    // -----------------------------------------------------------------------

    #[test]
    fn test_flag_allow_revert_is_bit7() {
        assert_eq!(commands::FLAG_ALLOW_REVERT, 0x80);
        // Applying mask strips the flag
        assert_eq!(commands::FLAG_ALLOW_REVERT & commands::COMMAND_TYPE_MASK, 0);
    }

    #[test]
    fn test_command_type_mask_strips_flag() {
        let cmd_with_flag = commands::WRAP_SOL | commands::FLAG_ALLOW_REVERT;
        assert_eq!(
            cmd_with_flag & commands::COMMAND_TYPE_MASK,
            commands::WRAP_SOL
        );
    }

    #[test]
    fn test_command_bytes_no_overlap_with_flag() {
        let all_cmds = [
            commands::RAYDIUM_CLMM_SWAP_EXACT_IN,
            commands::RAYDIUM_AMM_SWAP_EXACT_IN,
            commands::WRAP_SOL,
            commands::UNWRAP_WSOL,
            commands::SWEEP,
            commands::TRANSFER,
            commands::BRIDGE_TOKEN,
            commands::EXECUTE_CROSS_CHAIN,
            commands::EXECUTE_SUB_PLAN,
        ];
        for cmd in all_cmds {
            // No command byte should have bit 7 set (that's the flag)
            assert_eq!(
                cmd & commands::FLAG_ALLOW_REVERT,
                0,
                "cmd 0x{:02x} overlaps with FLAG_ALLOW_REVERT",
                cmd
            );
        }
    }

    #[test]
    fn test_contract_balance_sentinel_is_u64_max() {
        assert_eq!(amount_sentinels::CONTRACT_BALANCE, u64::MAX);
    }

    // -----------------------------------------------------------------------
    // BridgeType
    // -----------------------------------------------------------------------

    #[test]
    fn test_bridge_type_from_u8_valid() {
        assert_eq!(BridgeType::from_u8(0x01), Some(BridgeType::HypXerc20));
        assert_eq!(
            BridgeType::from_u8(0x03),
            Some(BridgeType::HypErc20Collateral)
        );
    }

    #[test]
    fn test_bridge_type_from_u8_invalid() {
        assert_eq!(BridgeType::from_u8(0x00), None);
        assert_eq!(BridgeType::from_u8(0x02), None);
        assert_eq!(BridgeType::from_u8(0xFF), None);
    }

    #[test]
    fn test_bridge_type_borsh_roundtrip() {
        for bt in [BridgeType::HypXerc20, BridgeType::HypErc20Collateral] {
            let encoded = borsh::to_vec(&bt).unwrap();
            let decoded = BridgeType::try_from_slice(&encoded).unwrap();
            assert_eq!(bt, decoded);
        }
    }

    // -----------------------------------------------------------------------
    // PendingSwap
    // -----------------------------------------------------------------------

    #[test]
    fn test_pending_swap_len_matches_serialized() {
        let swap = PendingSwap {
            recipient: Pubkey::new_unique(),
            origin_domain: 1,
            bump: 255,
            commit_time: 0,
        };
        let serialized = swap.to_bytes().unwrap();
        assert_eq!(serialized.len(), PendingSwap::LEN);
        assert_eq!(PendingSwap::LEN, 45);
    }

    #[test]
    fn test_pending_swap_borsh_roundtrip() {
        let original = PendingSwap {
            recipient: Pubkey::new_unique(),
            origin_domain: 42,
            bump: 200,
            commit_time: 1_700_000_000,
        };
        let bytes = original.to_bytes().unwrap();
        let decoded = PendingSwap::from_bytes(&bytes).unwrap();
        assert_eq!(decoded.recipient, original.recipient);
        assert_eq!(decoded.origin_domain, original.origin_domain);
        assert_eq!(decoded.bump, original.bump);
        assert_eq!(decoded.commit_time, original.commit_time);
    }

    #[test]
    fn test_pending_swap_from_bytes_too_short() {
        assert!(PendingSwap::from_bytes(&[0u8; 10]).is_err());
    }

    #[test]
    fn test_pending_swap_from_bytes_empty() {
        assert!(PendingSwap::from_bytes(&[]).is_err());
    }

    #[test]
    fn test_pending_swap_write_into() {
        let swap = PendingSwap {
            recipient: Pubkey::new_unique(),
            origin_domain: 99,
            bump: 1,
            commit_time: 1_000_000,
        };
        let mut buf = vec![0u8; PendingSwap::LEN];
        swap.write_into(&mut buf).unwrap();
        let decoded = PendingSwap::from_bytes(&buf).unwrap();
        assert_eq!(decoded.recipient, swap.recipient);
        assert_eq!(decoded.origin_domain, swap.origin_domain);
        assert_eq!(decoded.bump, swap.bump);
    }

    #[test]
    fn test_pending_swap_write_into_buffer_too_small() {
        let swap = PendingSwap {
            recipient: Pubkey::new_unique(),
            origin_domain: 1,
            bump: 0,
            commit_time: 0,
        };
        let mut buf = vec![0u8; 5]; // smaller than PendingSwap::LEN
        assert!(swap.write_into(&mut buf).is_err());
    }

    // -----------------------------------------------------------------------
    // Input struct Borsh roundtrips
    // -----------------------------------------------------------------------

    #[test]
    fn test_raydium_clmm_swap_input_roundtrip() {
        let input = RaydiumClmmSwapInput {
            amount_in: 1_000_000,
            amount_out_minimum: 900_000,
            sqrt_price_limit_x64: 12345678901234567890,
            is_base_input: true,
        };
        let bytes = borsh::to_vec(&input).unwrap();
        let decoded = RaydiumClmmSwapInput::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.amount_in, input.amount_in);
        assert_eq!(decoded.amount_out_minimum, input.amount_out_minimum);
        assert_eq!(decoded.sqrt_price_limit_x64, input.sqrt_price_limit_x64);
        assert_eq!(decoded.is_base_input, input.is_base_input);
    }

    #[test]
    fn test_raydium_amm_swap_input_roundtrip() {
        let input = RaydiumAmmSwapInput {
            amount_in: 500_000,
            amount_out_minimum: 490_000,
        };
        let bytes = borsh::to_vec(&input).unwrap();
        let decoded = RaydiumAmmSwapInput::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.amount_in, input.amount_in);
        assert_eq!(decoded.amount_out_minimum, input.amount_out_minimum);
    }

    #[test]
    fn test_wrap_sol_input_roundtrip() {
        let input = WrapSolInput { amount: u64::MAX };
        let bytes = borsh::to_vec(&input).unwrap();
        let decoded = WrapSolInput::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.amount, input.amount);
    }

    #[test]
    fn test_sweep_input_roundtrip() {
        let input = SweepInput { amount_min: 0 };
        let bytes = borsh::to_vec(&input).unwrap();
        let decoded = SweepInput::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.amount_min, input.amount_min);
    }

    #[test]
    fn test_transfer_input_roundtrip() {
        let input = TransferInput { amount: 999_999 };
        let bytes = borsh::to_vec(&input).unwrap();
        let decoded = TransferInput::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.amount, input.amount);
    }

    #[test]
    fn test_bridge_token_input_roundtrip() {
        let input = BridgeTokenInput {
            bridge_type: BridgeType::HypXerc20 as u8,
            destination_domain: 1,
            recipient: [0xABu8; 32],
            amount: 1_000_000,
            nonce: [0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04],
        };
        let bytes = borsh::to_vec(&input).unwrap();
        let decoded = BridgeTokenInput::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.bridge_type, input.bridge_type);
        assert_eq!(decoded.destination_domain, input.destination_domain);
        assert_eq!(decoded.recipient, input.recipient);
        assert_eq!(decoded.amount, input.amount);
        assert_eq!(decoded.nonce, input.nonce);
    }

    #[test]
    fn test_execute_cross_chain_input_roundtrip() {
        let input = ExecuteCrossChainInput {
            destination_domain: 1337,
            ica_router: [0x11u8; 32],
            ism: [0x22u8; 32],
            commitment: [0x33u8; 32],
            commit_msg_fee: 10_000,
            reveal_msg_fee: 20_000,
        };
        let bytes = borsh::to_vec(&input).unwrap();
        let decoded = ExecuteCrossChainInput::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.destination_domain, input.destination_domain);
        assert_eq!(decoded.ica_router, input.ica_router);
        assert_eq!(decoded.ism, input.ism);
        assert_eq!(decoded.commitment, input.commitment);
        assert_eq!(decoded.commit_msg_fee, input.commit_msg_fee);
        assert_eq!(decoded.reveal_msg_fee, input.reveal_msg_fee);
    }
}
