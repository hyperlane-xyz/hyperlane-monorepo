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
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, PartialEq, Eq)]
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
    /// Lamports for Hyperlane IGP gas payment
    pub msg_fee: u64,
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
// PDA seeds: [b"pending_swap", &origin_domain.to_le_bytes(), sender, salt]
// where sender = EVM router address (bytes32), salt = bytes32(msgSender()).
//
// Stored as raw Borsh (no discriminator prefix). Uninitialized accounts have
// all-zero data; commitment == [0u8;32] signals "commit not yet received".

#[derive(BorshSerialize, BorshDeserialize, Clone, Default, Debug)]
pub struct PendingSwap {
    /// Solana wallet that receives output tokens (or input tokens on fallback)
    pub recipient: Pubkey,
    /// Salt used to derive this PDA and compute the commitment
    pub salt: [u8; 32],
    /// keccak256(borsh(swap_commands, swap_inputs) || salt) — zero until handle() called
    pub commitment: [u8; 32],
    /// Origin Hyperlane domain that sent the commitment message
    pub origin_domain: u32,
    /// PDA bump used for signing CPIs on behalf of the PDA
    pub bump: u8,
}

impl PendingSwap {
    /// Serialized size — no discriminator prefix
    pub const LEN: usize = 32 + 32 + 32 + 4 + 1; // = 101

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
