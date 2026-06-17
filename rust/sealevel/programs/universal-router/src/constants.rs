use solana_program::pubkey;
use solana_program::pubkey::Pubkey;

/// Native SOL mint for wSOL
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// Raydium Concentrated Liquidity Market Maker (CLMM) program — Solana mainnet
pub const RAYDIUM_CLMM_PROGRAM_ID: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

/// Raydium AMM V4 program — Solana mainnet
pub const RAYDIUM_AMM_V4_PROGRAM_ID: Pubkey =
    pubkey!("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

/// Hyperlane Mailbox program — Solana mainnet
pub const HYPERLANE_MAILBOX_PROGRAM_ID: Pubkey =
    pubkey!("E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi");

/// Hyperlane IGP program — Solana mainnet
/// Source: rust/sealevel/environments/mainnet3/solanamainnet/core/program-ids.json igp_program_id
pub const HYPERLANE_IGP_PROGRAM_ID: Pubkey =
    pubkey!("BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv");

/// Hyperlane USDC warp route token router — Eclipse mainnet (USDC/eclipsemainnet)
pub const HYPERLANE_USDC_TOKEN_ROUTER: Pubkey =
    pubkey!("3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm");

/// Hyperlane USDT warp route token router — Eclipse mainnet (USDT/eclipsemainnet)
pub const HYPERLANE_USDT_TOKEN_ROUTER: Pubkey =
    pubkey!("Bk79wMjvpPCh5iQcCEjPWFcG1V2TfgdwaBsWBEYFYSNU");

/// USDC SPL token mint — Solana mainnet
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// USDT SPL token mint — Solana mainnet
pub const USDT_MINT: Pubkey = pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

/// Maximum nested sub-plan depth
pub const MAX_SUB_PLAN_DEPTH: u8 = 2;

/// PDA seed for pending cross-chain swap state accounts
pub const PENDING_SWAP_SEED: &[u8] = b"pending_swap";

/// PDA seed for the program-owned rent-payer.
/// Must be pre-funded with SOL before the first Handle (commit) call.
pub const FEE_PAYER_SEED: &[u8] = b"hyperlane_fee_payer";

/// Number of accounts consumed from remaining_accounts per command type.
pub mod account_counts {
    /// payer_wsol_ata, token_program, system_program
    pub const WRAP_SOL: usize = 3;
    /// wsol_ata, recipient, token_program
    pub const UNWRAP_WSOL: usize = 3;
    /// src_ata, dst_ata, mint, token_program
    pub const SWEEP: usize = 4;
    /// src_ata, dst_ata, token_program
    pub const TRANSFER: usize = 3;
    /// See raydium.rs — 17 accounts
    pub const RAYDIUM_CLMM_SWAP_EXACT_IN: usize = 17;
    /// See raydium.rs — 18 accounts
    pub const RAYDIUM_AMM_SWAP_EXACT_IN: usize = 18;
    /// See bridge.rs — 18 accounts
    pub const BRIDGE_TOKEN: usize = 18;
    /// See cross_chain.rs — 15 accounts (9 shared + 3 commit + 3 reveal)
    pub const EXECUTE_CROSS_CHAIN: usize = 15;
}
