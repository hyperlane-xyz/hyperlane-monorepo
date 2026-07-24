//! Automated reveal submission for EVM→Solana CLMM swap commit-reveal pattern.
//!
//! After the Hyperlane mailbox delivers a COMMIT message to the Solana UR program,
//! `maybe_spawn_reveal` is called with the message. If the body is 96 bytes
//! (`commitment(32)|userSalt(32)|recipient(32)`) and `ur_reveal` is configured, a
//! `RouterInstruction::Reveal` (variant 2) is submitted in a spawned tokio task.
//!
//! `reveal()` has no fallback on-chain: a failed swap CPI aborts the whole
//! instruction (Solana CPI failures can't be caught and continued past), so
//! `submit_reveal` simulates the Reveal transaction first. If simulation
//! predicts failure, it submits `RouterInstruction::ClosePendingSwap` (variant
//! 3) instead of a doomed Reveal — safe either way (Solana tx atomicity means
//! a failed attempt never partially executes), though ClosePendingSwap only
//! actually succeeds once the program's 1-minute post-commit expiry has
//! passed; an earlier attempt just fails harmlessly with `SwapNotExpired` and
//! the outer retry loop tries again later.
//!
//! Instruction data layout:
//!   [0]       u8        variant = 2
//!   [1..5]    u32 LE    origin domain
//!   [5..37]   [u8;32]   sender  (EVM UR address as bytes32)
//!   [37..69]  [u8;32]   user_salt (TypeCasts.addressToBytes32(msgSender()))
//!   [69..73]  u32 LE    message length
//!   [73..N]   u8[]      message (borsh CCS calldata)
//!   [N..N+32] [u8;32]   salt (random revealSalt)

use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use eyre::{bail, eyre, Result};
use hyperlane_core::HyperlaneMessage;
use reqwest::Client;
use serde::Deserialize;
use solana_commitment_config::CommitmentConfig;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::Signer,
    transaction::Transaction,
};
use solana_transaction_status::TransactionStatus;
use tracing::{debug, error, info, warn, Instrument};

use crate::{
    priority_fee::PriorityFeeOracle, rpc::fallback::SealevelFallbackRpcClient, SealevelKeypair,
    SealevelTxType,
};

const REVEAL_COMPUTE_UNITS: u32 = 600_000;
// ClosePendingSwap does far less work than Reveal (a token transfer + two account
// closes, no CPI into Raydium), so it needs a much smaller compute budget.
const CLOSE_PENDING_SWAP_COMPUTE_UNITS: u32 = 200_000;
// Must match hyperlane-sealevel-universal-router's close_pending_swap gate:
// `now < swap.commit_time + 60`.
const CLOSE_PENDING_SWAP_EXPIRY_SECS: i64 = 60;
const CCS_MAX_RETRIES: u32 = 10;
const CCS_RETRY_DELAY_SECS: u64 = 5;
// Outer send attempts (each gets a fresh blockhash): 3 × ~60s = ~3 min total.
const SEND_RETRY_MAX: u32 = 3;
// Per-request timeout for CCS HTTP calls so a slow-responding CCS can't block the task forever.
const CCS_REQUEST_TIMEOUT_SECS: u64 = 30;
// Reveal task retry backoff on transient failures (RPC errors, tx not confirmed, fee payer low).
const REVEAL_INITIAL_RETRY_DELAY_SECS: u64 = 30;
const REVEAL_MAX_RETRY_DELAY_SECS: u64 = 600; // 10 min
                                              // Inner polls per blockhash window (~150 slots ≈ 60 s on mainnet).
const CONFIRM_POLLS_PER_BLOCKHASH: u32 = 30;
const CONFIRM_POLL_DELAY_MS: u64 = 2_000;
// Resend the signed tx every N inner polls to keep it in the leader queue.
const RESEND_INTERVAL_POLLS: u32 = 10;

// Raydium CLMM program on mainnet.
const RAYDIUM_CLMM_PROGRAM: Pubkey =
    solana_program::pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

// SPL Associated Token Account program.
const ATA_PROGRAM: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// wSOL mint. When the output mint is wSOL, the reveal sweeps PDA wSOL ATA →
// fee_payer's wSOL ATA, then closes it → native SOL to recipient.
const WSOL_MINT: Pubkey = solana_program::pubkey!("So11111111111111111111111111111111111111112");

// SPL Token (legacy) program. Used for the CloseAccount instruction on wSOL ATAs.
const SPL_TOKEN_PROGRAM: Pubkey =
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Byte offsets within a Raydium CLMM PoolState account (includes 8-byte Anchor discriminant).
// Verified against `reveal.mjs` fetchClmmPoolState offsets.
const POOL_AMM_CONFIG_OFFSET: usize = 9; // Pubkey (32 bytes)
const POOL_MINT0_OFFSET: usize = 73; // Pubkey (32 bytes)
const POOL_MINT1_OFFSET: usize = 105; // Pubkey (32 bytes)
const POOL_VAULT0_OFFSET: usize = 137; // Pubkey (32 bytes)
const POOL_VAULT1_OFFSET: usize = 169; // Pubkey (32 bytes)
const POOL_OBS_STATE_OFFSET: usize = 201; // Pubkey (32 bytes)
const POOL_TICK_SPACING_OFFSET: usize = 235; // i16 LE
const POOL_TICK_CURRENT_OFFSET: usize = 269; // i32 LE

struct ClmmPoolState {
    amm_config: Pubkey,
    mint0: Pubkey,
    #[allow(dead_code)]
    mint1: Pubkey,
    vault0: Pubkey,
    vault1: Pubkey,
    observation_state: Pubkey,
    tick_spacing: i16,
    tick_current: i32,
}

fn parse_clmm_pool_state(data: &[u8]) -> Result<ClmmPoolState> {
    let min_len = POOL_TICK_CURRENT_OFFSET + 4;
    if data.len() < min_len {
        bail!(
            "pool account data too short: {} bytes (need {})",
            data.len(),
            min_len
        );
    }
    let read_pubkey = |offset: usize| {
        Pubkey::new_from_array(
            data[offset..offset.saturating_add(32)]
                .try_into()
                .expect("slice is exactly 32 bytes"),
        )
    };
    let tick_spacing = i16::from_le_bytes(
        data[POOL_TICK_SPACING_OFFSET..POOL_TICK_SPACING_OFFSET.saturating_add(2)]
            .try_into()
            .expect("slice is exactly 2 bytes"),
    );
    let tick_current = i32::from_le_bytes(
        data[POOL_TICK_CURRENT_OFFSET..POOL_TICK_CURRENT_OFFSET.saturating_add(4)]
            .try_into()
            .expect("slice is exactly 4 bytes"),
    );
    Ok(ClmmPoolState {
        amm_config: read_pubkey(POOL_AMM_CONFIG_OFFSET),
        mint0: read_pubkey(POOL_MINT0_OFFSET),
        mint1: read_pubkey(POOL_MINT1_OFFSET),
        vault0: read_pubkey(POOL_VAULT0_OFFSET),
        vault1: read_pubkey(POOL_VAULT1_OFFSET),
        observation_state: read_pubkey(POOL_OBS_STATE_OFFSET),
        tick_spacing,
        tick_current,
    })
}

async fn fetch_clmm_pool_state(
    pool_pubkey: Pubkey,
    rpc_client: &SealevelFallbackRpcClient,
) -> Result<ClmmPoolState> {
    let account = rpc_client
        .get_account_option_with_commitment(pool_pubkey, CommitmentConfig::processed())
        .await
        .map_err(|e| eyre!("fetch pool account {pool_pubkey}: {e}"))?
        .ok_or_else(|| eyre!("pool account {pool_pubkey} not found on chain"))?;
    parse_clmm_pool_state(&account.data)
}

// Mirrors reveal.mjs `getTickArrayStartIndex`.  Uses truncation-towards-zero integer
// division (Rust default), with an explicit floor correction for negative ticks.
// Division is safe: tick_spacing is guarded > 0, so ticks_in_array > 0 and i32::MIN/-1 is unreachable.
#[allow(clippy::arithmetic_side_effects)]
fn get_tick_array_start_index(tick_current: i32, tick_spacing: i16) -> Result<i32> {
    if tick_spacing <= 0 {
        bail!("invalid tick_spacing: {tick_spacing}");
    }
    let ticks_in_array = 60i32.saturating_mul(tick_spacing as i32);
    let mut start = (tick_current / ticks_in_array).saturating_mul(ticks_in_array);
    if tick_current < 0 && tick_current % ticks_in_array != 0 {
        start = start.saturating_sub(ticks_in_array);
    }
    Ok(start)
}

// Seeds: [b"tick_array", pool_id (32 bytes), start_index (i32 big-endian)]
fn compute_tick_array_address(pool_id: &Pubkey, start_index: i32) -> Pubkey {
    Pubkey::find_program_address(
        &[b"tick_array", pool_id.as_ref(), &start_index.to_be_bytes()],
        &RAYDIUM_CLMM_PROGRAM,
    )
    .0
}

// Seeds for ATA: [owner, token_program, mint] under ATA_PROGRAM
fn derive_ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

// Idempotent ATA create instruction (discriminant = 1).
fn make_ata_ix(
    payer: &Pubkey,
    ata: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(solana_system_interface::program::id(), false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1u8],
    }
}

/// Accounts (from `build_instruction`'s reveal account list) needed to build a
/// ClosePendingSwap instruction if a Reveal simulation predicts failure.
struct CloseAccounts {
    pda_input_ata: Pubkey,
    input_mint: Pubkey,
    input_token_prog: Pubkey,
}

/// Builds `RouterInstruction::ClosePendingSwap` (variant 3). Accounts:
///   [0] pending_swap PDA   writable
///   [1] caller             writable signer (anyone — this relayer's fee payer)
///   [2] pda_ata            writable
///   [3] recipient_ata      writable (must be owned by `recipient`; caller must
///       pre-create it — see the idempotent ATA-create instruction alongside this)
///   [4] token_program      readonly
///   [5] mint               readonly
///   [6] recipient          writable
#[allow(clippy::too_many_arguments)]
fn make_close_pending_swap_ix(
    program_id: Pubkey,
    origin: u32,
    sender: [u8; 32],
    user_salt: [u8; 32],
    commitment: [u8; 32],
    pending_swap_pda: Pubkey,
    caller: Pubkey,
    pda_ata: Pubkey,
    recipient_ata: Pubkey,
    token_program: Pubkey,
    mint: Pubkey,
    recipient: Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(1 + 4 + 32 + 32 + 32);
    data.push(3u8); // RouterInstruction::ClosePendingSwap variant
    data.extend_from_slice(&origin.to_le_bytes());
    data.extend_from_slice(&sender);
    data.extend_from_slice(&user_salt);
    data.extend_from_slice(&commitment);

    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(pending_swap_pda, false),
            AccountMeta::new(caller, true),
            AccountMeta::new(pda_ata, false),
            AccountMeta::new(recipient_ata, false),
            AccountMeta::new_readonly(token_program, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(recipient, false),
        ],
        data,
    }
}

// SPL Token CloseAccount instruction (discriminant = 9).
// Transfers all lamports from `wsol_ata` to `lamport_dest` and closes the account,
// unwrapping wSOL to native SOL. `authority` must sign the transaction.
fn make_close_account_ix(
    wsol_ata: &Pubkey,
    lamport_dest: &Pubkey,
    authority: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: SPL_TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(*wsol_ata, false),
            AccountMeta::new(*lamport_dest, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data: vec![9u8],
    }
}

/// Configuration for automated UR reveal submission on a Sealevel destination.
#[derive(Debug, Clone)]
pub struct UniversalRouterRevealConfig {
    /// Base URL of the CCS, e.g. "https://ccs.example.com".
    pub ccs_url: String,
    /// Solana UR program ID (base58).
    pub program_id: String,
}

#[derive(Deserialize, Debug)]
struct CcsGetResponse {
    data: String,
    salt: String,
    #[serde(rename = "revealAccounts")]
    reveal_accounts: Option<Vec<CcsRevealAccount>>,
}

#[derive(Deserialize, Debug)]
struct CcsRevealAccount {
    pubkey: String,
    #[serde(rename = "isWritable")]
    is_writable: bool,
    #[serde(rename = "isSigner")]
    is_signer: bool,
}

/// If `message` looks like a UR COMMIT (96-byte body, recipient == UR program) and
/// config is present, spawns a tokio task to fetch from CCS and submit
/// `RouterInstruction::Reveal`.
pub fn maybe_spawn_reveal(
    message: &HyperlaneMessage,
    config: &UniversalRouterRevealConfig,
    rpc_client: SealevelFallbackRpcClient,
    priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
    fee_payer: SealevelKeypair,
) {
    let body_len = message.body.len();
    if body_len != 96 {
        return;
    }

    // Verify the message is addressed to this UR program, not some other
    // Sealevel program that happens to send 96-byte messages.
    let program_id = match Pubkey::from_str(&config.program_id) {
        Ok(p) => p,
        Err(e) => {
            error!("Invalid program ID in config: {e}");
            return;
        }
    };
    let message_recipient = Pubkey::new_from_array(message.recipient.0);
    if message_recipient != program_id {
        return;
    }
    // COMMIT body: commitment(32) | userSalt(32) | recipient(32)
    let commitment: [u8; 32] = message.body[0..32]
        .try_into()
        .expect("body is exactly 96 bytes");
    let user_salt: [u8; 32] = message.body[32..64]
        .try_into()
        .expect("body is exactly 96 bytes");
    let recipient: [u8; 32] = message.body[64..96]
        .try_into()
        .expect("body is exactly 96 bytes");
    let origin = message.origin;
    let sender = message.sender.0;
    let commitment_hex = hex::encode(commitment);

    let pending_swap_pda =
        derive_pending_swap_pda(&program_id, origin, &sender, &user_salt, &commitment);
    info!(
        commitment = %commitment_hex,
        origin,
        sender = %hex::encode(sender),
        %pending_swap_pda,
        ccs_url = %config.ccs_url,
        program_id = %config.program_id,
        fee_payer = %fee_payer.pubkey(),
        "Spawning reveal task"
    );

    let ccs_url = config.ccs_url.trim_end_matches('/').to_owned();

    tokio::spawn(async move {
        let http_client = Client::builder()
            .timeout(Duration::from_secs(CCS_REQUEST_TIMEOUT_SECS))
            .build()
            .expect("HTTP client build failed — invalid configuration");
        let ctx = RevealContext {
            ccs_url: &ccs_url,
            program_id,
            commitment,
            origin,
            sender,
            user_salt,
            recipient,
            rpc_client: &rpc_client,
            priority_fee_oracle,
            fee_payer: &fee_payer,
            http_client,
        };
        // Phase 1: wait for the pending_swap PDA to appear at confirmed commitment.
        // The task is spawned after the commit tx is confirmed on-chain (on_submitted_success
        // polls delivered() before calling this; on_delivered fires post-confirmation),
        // so the PDA should exist immediately.  A short retry window handles RPC
        // propagation lag.  If the PDA has tx history but is gone, already revealed; stop.
        const PDA_WAIT_MAX_ITERS: u32 = 5; // 5 × 5s = 25s propagation grace
        let mut pda_wait_iters: u32 = 0;
        loop {
            match rpc_client
                .get_account_option_with_commitment(pending_swap_pda, CommitmentConfig::confirmed())
                .await
            {
                Ok(Some(_)) => {
                    debug!("PDA confirmed; proceeding");
                    break;
                }
                Ok(None) => {
                    match rpc_client
                        .get_signatures_for_address_with_limit(pending_swap_pda, 1)
                        .await
                    {
                        Ok(sigs) if !sigs.is_empty() => {
                            info!(%pending_swap_pda, "PDA gone with tx history — already revealed; stopping");
                            return;
                        }
                        Ok(_) => {}
                        Err(e) => {
                            debug!(error = ?e, "Could not check PDA history");
                        }
                    }
                    pda_wait_iters = pda_wait_iters.saturating_add(1);
                    if pda_wait_iters >= PDA_WAIT_MAX_ITERS {
                        warn!(%pending_swap_pda, "PDA not visible after {}s post-confirmation; stopping", PDA_WAIT_MAX_ITERS * 5);
                        return;
                    }
                }
                Err(e) => {
                    debug!(error = ?e, "Could not check PDA; retrying in 5s");
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }

        // Phase 2: fetch CCS to learn the pda_input_ata address (accounts[1]) and
        // poll for a non-zero token balance.  We must not build the full reveal tx
        // (pool state RPC, tick arrays, etc.) until the warp tokens have landed.
        // Bail after 30 min (360 × 5s) to surface stuck swaps — the warp transfer
        // should arrive in seconds; anything longer indicates a failed inbound leg.
        const TOKEN_WAIT_MAX_ITERS: u32 = 360;
        let mut token_wait_iters: u32 = 0;
        loop {
            // Bail early if PDA is already gone.
            match rpc_client
                .get_account_option_with_commitment(pending_swap_pda, CommitmentConfig::confirmed())
                .await
            {
                Ok(None) => {
                    info!("PDA gone before tokens arrived; stopping");
                    return;
                }
                Err(e) => {
                    debug!(error = ?e, "Could not check PDA while waiting for tokens");
                }
                Ok(Some(_)) => {}
            }

            // Fetch CCS to discover the pda_input_ata address.
            let ccs_opt = match fetch_from_ccs(&ctx.http_client, &ccs_url, &commitment).await {
                Ok(c) => Some(c),
                Err(e) => {
                    warn!(error = ?e, "CCS fetch failed while waiting for tokens; retrying in 5s");
                    None
                }
            };

            if let Some(ccs) = ccs_opt {
                if let Some(accounts) = ccs.reveal_accounts.as_deref() {
                    // Require at least accounts[0..=14] so we can derive the ATA locally.
                    if accounts.len() > 14 {
                        // Derive the input ATA from first-principles (same logic as
                        // build_instruction) rather than trusting accounts[1] from CCS, which
                        // could be stale. accounts[11] = inputTokenProgram, accounts[14] =
                        // inputMint; pending_swap_pda is the ATA owner.
                        let maybe_ata_pubkey = Pubkey::from_str(&accounts[11].pubkey)
                            .ok()
                            .zip(Pubkey::from_str(&accounts[14].pubkey).ok())
                            .map(|(token_prog, input_mint)| {
                                derive_ata(&pending_swap_pda, &input_mint, &token_prog)
                            });
                        match maybe_ata_pubkey {
                            None => {
                                warn!("Could not parse accounts[11] or accounts[14] pubkey from CCS; retrying in 5s");
                            }
                            Some(ata_pubkey) => {
                                // Check the ATA balance.
                                match rpc_client
                                    .get_account_option_with_commitment(
                                        ata_pubkey,
                                        CommitmentConfig::confirmed(),
                                    )
                                    .await
                                {
                                    Ok(Some(acct)) if acct.data.len() >= 72 => {
                                        let balance = u64::from_le_bytes(
                                            acct.data[64..72].try_into().unwrap_or([0u8; 8]),
                                        );
                                        if balance > 0 {
                                            debug!(%ata_pubkey, balance, "PDA input ATA funded; proceeding to build tx");
                                            break;
                                        }
                                    }
                                    Ok(None) => {}
                                    Ok(Some(_)) => {
                                        debug!("PDA input ATA has unexpected data length; waiting 5s");
                                    }
                                    Err(e) => {
                                        warn!(error = ?e, "Could not check PDA input ATA balance; waiting 5s");
                                    }
                                }
                            }
                        }
                    } else {
                        warn!("CCS revealAccounts has <15 entries; retrying in 5s");
                    }
                } else {
                    warn!("CCS response missing revealAccounts; retrying in 5s");
                }
            }

            token_wait_iters = token_wait_iters.saturating_add(1);
            if token_wait_iters >= TOKEN_WAIT_MAX_ITERS {
                error!(%pending_swap_pda, "Warp tokens never arrived after {}s; inbound transfer may be stuck; stopping", TOKEN_WAIT_MAX_ITERS * 5);
                return;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }

        let mut delay_secs = REVEAL_INITIAL_RETRY_DELAY_SECS;
        loop {
            match submit_reveal(&ctx).await {
                Ok(()) => {
                    info!("Confirmed successfully");
                    break;
                }
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("tx failed on-chain") {
                        // On-chain rejection (Reveal or ClosePendingSwap) — possible causes:
                        // 1. PDA is gone: another relayer already revealed or closed it → done.
                        // 2. PDA still exists, error is SwapNotExpired (Custom(15)): submit_reveal
                        //    tried ClosePendingSwap before the program's 1-minute expiry — routine,
                        //    not a real failure; keep retrying (Reveal may succeed by then too).
                        // 3. PDA still exists, some other error: params were rejected (stale pool
                        //    state, wrong vaults, etc.) → retry; build_instruction fetches fresh
                        //    pool state on each call so the next attempt should self-correct.
                        let is_swap_not_expired = msg.contains("Custom(15)");
                        match rpc_client
                            .get_account_option_with_commitment(
                                pending_swap_pda,
                                CommitmentConfig::confirmed(),
                            )
                            .await
                        {
                            Ok(None) => {
                                info!(%pending_swap_pda, "pending_swap PDA is gone — reveal or close completed by another relayer; stopping");
                                break;
                            }
                            Ok(Some(_)) if is_swap_not_expired => {
                                debug!(retry_in_secs = delay_secs, "ClosePendingSwap not past its 1-minute expiry yet; will retry");
                            }
                            Ok(Some(_)) => {
                                warn!(retry_in_secs = delay_secs, error = ?e, "On-chain rejection but PDA still exists; retrying with fresh pool state");
                            }
                            Err(check_err) => {
                                debug!(error = ?check_err, "Could not check PDA existence after on-chain error; will retry");
                            }
                        }
                    } else if msg.contains("ClosePendingSwap not available yet") {
                        // Proactively detected before submitting anything (see submit_reveal) —
                        // routine, not a failure; no PDA re-check needed since we just read it.
                        debug!(retry_in_secs = delay_secs, "{msg}");
                    } else {
                        warn!(retry_in_secs = delay_secs, error = ?e, "Transient failure; will retry");
                    }
                    tokio::time::sleep(Duration::from_secs(delay_secs)).await;
                    delay_secs = delay_secs.saturating_mul(2).min(REVEAL_MAX_RETRY_DELAY_SECS);
                }
            }
        }
    }.instrument(tracing::info_span!("reveal", commitment = %commitment_hex)));
}

struct RevealContext<'a> {
    ccs_url: &'a str,
    program_id: Pubkey,
    commitment: [u8; 32],
    origin: u32,
    sender: [u8; 32],
    user_salt: [u8; 32],
    recipient: [u8; 32],
    rpc_client: &'a SealevelFallbackRpcClient,
    priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
    fee_payer: &'a SealevelKeypair,
    http_client: reqwest::Client,
}

async fn submit_reveal(ctx: &RevealContext<'_>) -> Result<()> {
    let ccs = fetch_from_ccs(&ctx.http_client, ctx.ccs_url, &ctx.commitment).await?;
    let (built, close_accounts) = build_instruction(ctx, &ccs).await?;

    // Simulate before submitting. A failed swap CPI aborts the whole Reveal
    // instruction on-chain (Solana CPI failures can't be caught and continued
    // past — see hyperlane-sealevel-universal-router's processor.rs), so a
    // doomed Reveal just burns a transaction for nothing. If simulation
    // predicts failure, go straight to ClosePendingSwap instead — safe either
    // way, since Solana transactions are atomic (a failed attempt never
    // partially executes) and ClosePendingSwap only opens up once the
    // program's 1-minute expiry has passed, so an early attempt here simply
    // fails harmlessly with SwapNotExpired and the outer retry loop tries
    // again later.
    let sim_tx = SealevelTxType::Legacy(Transaction::new_unsigned(Message::new(
        &built,
        Some(&ctx.fee_payer.pubkey()),
    )));
    match ctx.rpc_client.simulate_sealevel_tx(&sim_tx).await {
        Ok(result) if result.err.is_some() => {
            warn!(
                error = ?result.err,
                logs = ?result.logs,
                "Reveal simulation predicts failure; attempting ClosePendingSwap instead of submitting a doomed Reveal"
            );

            let pending_swap_pda = derive_pending_swap_pda(
                &ctx.program_id,
                ctx.origin,
                &ctx.sender,
                &ctx.user_salt,
                &ctx.commitment,
            );

            // Check the PDA still exists before doing anything else — unconditionally,
            // before even checking whether we have enough info to build a close
            // instruction. A failed simulation doesn't mean the swap is actually
            // stuck: another relayer may have already submitted a successful Reveal
            // (which closes this same PDA) in the time since we fetched CCS, or
            // already closed it via its own ClosePendingSwap. Either way there's
            // nothing left for us to do.
            let pending_swap_account = ctx
                .rpc_client
                .get_account_option_with_commitment(pending_swap_pda, CommitmentConfig::confirmed())
                .await
                .map_err(|e| eyre!("fetch pending_swap account: {e}"))?;
            let Some(pending_swap_account) = pending_swap_account else {
                info!(%pending_swap_pda, "pending_swap PDA is gone — reveal succeeded or was closed elsewhere; stopping");
                return Ok(());
            };

            // Proactively check the on-chain expiry before spending a transaction:
            // ClosePendingSwap only succeeds once `now >= commit_time + 60` (see
            // hyperlane-sealevel-universal-router's close_pending_swap). Read
            // commit_time from the PDA itself rather than tracking it locally —
            // this task can sit anywhere from seconds to ~30 minutes in the
            // token-arrival wait (see Phase 2 above) before its first reveal
            // attempt, so there's no reliable local clock to derive it from.
            let commit_time = parse_pending_swap_commit_time(&pending_swap_account.data)?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let expires_at = commit_time.saturating_add(CLOSE_PENDING_SWAP_EXPIRY_SECS);
            if now < expires_at {
                let remaining = expires_at.saturating_sub(now);
                bail!(
                    "ClosePendingSwap not available yet — {remaining}s remaining until the \
                     1-minute expiry; will retry"
                );
            }

            let Some(accts) = close_accounts else {
                bail!(
                    "Reveal simulation failed and swap account info is unavailable to build \
                     ClosePendingSwap (CCS returned too few accounts); will retry"
                );
            };

            let recipient_pubkey = Pubkey::new_from_array(ctx.recipient);
            let fee_payer_pubkey = ctx.fee_payer.pubkey();
            let recipient_ata = derive_ata(
                &recipient_pubkey,
                &accts.input_mint,
                &accts.input_token_prog,
            );

            // Idempotent create: the recipient's input-token ATA may not exist yet.
            let ata_ix = make_ata_ix(
                &fee_payer_pubkey,
                &recipient_ata,
                &recipient_pubkey,
                &accts.input_mint,
                &accts.input_token_prog,
            );
            let close_ix = make_close_pending_swap_ix(
                ctx.program_id,
                ctx.origin,
                ctx.sender,
                ctx.user_salt,
                ctx.commitment,
                pending_swap_pda,
                fee_payer_pubkey,
                accts.pda_input_ata,
                recipient_ata,
                accts.input_token_prog,
                accts.input_mint,
                recipient_pubkey,
            );

            return send_and_confirm(
                ctx,
                &[ata_ix, close_ix],
                CLOSE_PENDING_SWAP_COMPUTE_UNITS,
                "ClosePendingSwap",
            )
            .await;
        }
        Ok(_) => {
            // Simulation predicts success — proceed with the real Reveal below.
        }
        Err(e) => {
            // Inconclusive (RPC error running the simulation itself) — fail open
            // and attempt the real Reveal rather than blocking progress on a
            // flaky simulate call.
            debug!(error = ?e, "Could not simulate Reveal; attempting it directly");
        }
    }

    send_and_confirm(ctx, &built, REVEAL_COMPUTE_UNITS, "Reveal").await
}

/// Signs, sends, and confirms a transaction built from `instructions`, retrying
/// with a fresh blockhash if it isn't confirmed within the current one's
/// validity window. Shared by both the Reveal and ClosePendingSwap paths.
async fn send_and_confirm(
    ctx: &RevealContext<'_>,
    instructions: &[Instruction],
    compute_units: u32,
    label: &str,
) -> Result<()> {
    // Build a probe tx from the real instructions so the oracle can price based
    // on the actual hot accounts rather than a global estimate.
    let probe = SealevelTxType::Legacy(Transaction::new_unsigned(Message::new(
        instructions,
        Some(&ctx.fee_payer.pubkey()),
    )));
    let priority_fee = ctx
        .priority_fee_oracle
        .get_priority_fee(&probe)
        .await
        .unwrap_or(0);

    // Outer loop: each attempt fetches a fresh blockhash and rebuilds the tx.
    // On mainnet, a tx sent once is often silently dropped by congested leaders;
    // the inner loop resends periodically within the ~150-slot (~60 s) validity
    // window, and the outer loop retries after the window expires.
    for send_attempt in 1..=SEND_RETRY_MAX {
        // Fresh blockhash each attempt so the tx is valid for a new ~150-slot window.
        let blockhash = ctx
            .rpc_client
            .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
            .await
            .map_err(|e| eyre!("get_latest_blockhash: {e}"))?;

        let mut full_instructions = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(compute_units),
            ComputeBudgetInstruction::set_compute_unit_price(priority_fee),
        ];
        full_instructions.extend_from_slice(instructions);

        let message = Message::new(&full_instructions, Some(&ctx.fee_payer.pubkey()));
        let tx = Transaction::new(&[ctx.fee_payer.keypair()], message, blockhash);

        // skip_preflight=true to avoid BlockhashNotFound race on multi-RPC setups.
        let signature = ctx
            .rpc_client
            .send_transaction(&tx, true)
            .await
            .map_err(|e| eyre!("send_transaction (attempt {send_attempt}): {e}"))?;

        info!(%signature, send_attempt, label, "Tx sent");

        let mut confirmed = false;
        for poll in 1..=CONFIRM_POLLS_PER_BLOCKHASH {
            tokio::time::sleep(Duration::from_millis(CONFIRM_POLL_DELAY_MS)).await;

            // Resend periodically to keep the tx in the leader queue within the validity window.
            if poll % RESEND_INTERVAL_POLLS == 0 {
                if let Err(e) = ctx.rpc_client.send_transaction(&tx, true).await {
                    debug!(%signature, error = ?e, "Resend error (non-fatal)");
                }
            }

            match ctx.rpc_client.get_signature_statuses(&[signature]).await {
                Ok(response) => match response.value.into_iter().next().flatten() {
                    None => {}
                    Some(TransactionStatus { err: Some(e), .. }) => {
                        bail!("{label} tx failed on-chain: {e:?}");
                    }
                    Some(status) if status.satisfies_commitment(CommitmentConfig::confirmed()) => {
                        info!(%signature, label, "Tx confirmed");
                        confirmed = true;
                        break;
                    }
                    Some(_) => {}
                },
                Err(e) => {
                    debug!(%signature, error = ?e, "Error polling confirmation");
                }
            }
        }

        if confirmed {
            return Ok(());
        }

        if send_attempt < SEND_RETRY_MAX {
            warn!(%signature, send_attempt, label, "Tx not confirmed within blockhash window; retrying with fresh blockhash");
        }
    }
    bail!(
        "{label} tx not confirmed after {} send attempts",
        SEND_RETRY_MAX
    )
}

async fn fetch_from_ccs(
    http: &Client,
    ccs_url: &str,
    commitment: &[u8; 32],
) -> Result<CcsGetResponse> {
    let commitment_hex = hex::encode(commitment);
    let url = format!("{ccs_url}/calldata/0x{commitment_hex}");
    debug!(url, "GET CCS calldata");
    for attempt in 1..=CCS_MAX_RETRIES {
        let resp = http.get(&url).send().await?;
        let status = resp.status();
        match status {
            s if s.is_success() => {
                let ccs = resp.json::<CcsGetResponse>().await?;
                return Ok(ccs);
            }
            reqwest::StatusCode::NOT_FOUND => {
                if attempt < CCS_MAX_RETRIES {
                    debug!(attempt, "CCS 404 — calldata not yet stored; retrying");
                    tokio::time::sleep(Duration::from_secs(CCS_RETRY_DELAY_SECS)).await;
                } else {
                    warn!("CCS 404 on final attempt");
                }
            }
            _ => bail!(
                "CCS GET failed: {} {}",
                status,
                resp.text().await.unwrap_or_default()
            ),
        }
    }
    bail!("CCS returned 404 after {} retries", CCS_MAX_RETRIES)
}

fn derive_fee_payer_pda(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"hyperlane_fee_payer"], program_id).0
}

// Seeds: [b"pending_swap", origin_le, sender, user_salt, commitment]
// commitment = keccak256(revealSalt || calldata), same value stored in PDA and in the COMMIT body.
fn derive_pending_swap_pda(
    program_id: &Pubkey,
    origin: u32,
    sender: &[u8; 32],
    user_salt: &[u8; 32],
    commitment: &[u8; 32],
) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"pending_swap",
            &origin.to_le_bytes(),
            sender.as_ref(),
            user_salt.as_ref(),
            commitment.as_ref(),
        ],
        program_id,
    )
    .0
}

// PendingSwap layout (Borsh, no discriminator prefix — see
// hyperlane-sealevel-universal-router's types.rs):
//   recipient: Pubkey (32) | origin_domain: u32 (4) | bump: u8 (1) | commit_time: i64 (8)
const PENDING_SWAP_COMMIT_TIME_OFFSET: usize = 32 + 4 + 1;

fn parse_pending_swap_commit_time(data: &[u8]) -> Result<i64> {
    let end = PENDING_SWAP_COMMIT_TIME_OFFSET + 8;
    if data.len() < end {
        bail!(
            "pending_swap account data too short: {} bytes (need {end})",
            data.len()
        );
    }
    let bytes: [u8; 8] = data[PENDING_SWAP_COMMIT_TIME_OFFSET..end]
        .try_into()
        .expect("slice is exactly 8 bytes");
    Ok(i64::from_le_bytes(bytes))
}

/// Returns ([ata_create_0, ata_create_1, reveal_ix] (plus an optional trailing
/// CloseAccount instruction when the output is native SOL), close_accounts) —
/// the two idempotent ATA creates must precede the reveal instruction so the
/// CLMM output account and recipient ATA exist. `close_accounts` carries the
/// pda_ata/input_mint/input_token_prog needed to build a ClosePendingSwap
/// instruction later if a Reveal simulation predicts failure — `None` only
/// when CCS returned too few accounts to determine them at all.
async fn build_instruction(
    ctx: &RevealContext<'_>,
    ccs: &CcsGetResponse,
) -> Result<(Vec<Instruction>, Option<CloseAccounts>)> {
    let program_id = ctx.program_id;
    let origin = ctx.origin;
    let sender = ctx.sender;
    let user_salt = ctx.user_salt;
    let recipient = ctx.recipient;
    let commitment = ctx.commitment;
    let rpc_client = ctx.rpc_client;
    let message = hex_decode_bytes(&ccs.data)?;
    let salt = hex_decode_fixed32(&ccs.salt)?;

    // Verify CCS data is consistent with the commitment from the message body.
    let ccs_commitment =
        solana_program::keccak::hashv(&[salt.as_ref(), message.as_slice()]).to_bytes();
    if ccs_commitment != commitment {
        bail!(
            "CCS keccak(salt||calldata) {} does not match message body commitment {} — CCS data is stale or wrong",
            hex::encode(ccs_commitment),
            hex::encode(commitment),
        );
    }

    let msg_len = message.len() as u32;

    // 1 (variant) + 4 (origin) + 32 (sender) + 32 (user_salt) + 4 (msg_len) + message + 32 (salt)
    let fixed_overhead: usize = 105;
    let mut data = Vec::with_capacity(fixed_overhead.saturating_add(message.len()));
    data.push(2u8); // RouterInstruction::Reveal variant
    data.extend_from_slice(&origin.to_le_bytes());
    data.extend_from_slice(&sender);
    data.extend_from_slice(&user_salt);
    data.extend_from_slice(&msg_len.to_le_bytes());
    data.extend_from_slice(&message);
    data.extend_from_slice(&salt);

    let reveal_accounts = ccs
        .reveal_accounts
        .as_deref()
        .ok_or_else(|| eyre!("CCS response missing revealAccounts"))?;

    // Derive both critical PDAs locally to verify (and override) what CCS stored.
    let expected_pending_swap =
        derive_pending_swap_pda(&program_id, origin, &sender, &user_salt, &commitment);
    let expected_fee_payer_pda = derive_fee_payer_pda(&program_id);

    let mut accounts: Vec<AccountMeta> = reveal_accounts
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let pubkey = Pubkey::from_str(&a.pubkey)
                .map_err(|e| eyre!("invalid pubkey {}: {}", a.pubkey, e))?;

            // Override accounts[0] (pending_swap) and accounts[2] (fee_payer_pda)
            // with locally-derived values.
            let pubkey = match i {
                0 => {
                    if pubkey != expected_pending_swap {
                        warn!(
                            ccs_pubkey = %pubkey,
                            expected = %expected_pending_swap,
                            "account[0] (pending_swap PDA) mismatch — using locally-derived PDA"
                        );
                    }
                    expected_pending_swap
                }
                2 => {
                    if pubkey != expected_fee_payer_pda {
                        warn!(
                            ccs_pubkey = %pubkey,
                            expected = %expected_fee_payer_pda,
                            "account[2] (fee_payer_pda) mismatch — using locally-derived PDA"
                        );
                    }
                    expected_fee_payer_pda
                }
                _ => pubkey,
            };

            Ok(match (a.is_writable, a.is_signer) {
                (true, _) => AccountMeta::new(pubkey, a.is_signer),
                (false, _) => AccountMeta::new_readonly(pubkey, a.is_signer),
            })
        })
        .collect::<Result<_>>()?;

    // Fetch live CLMM pool state and override accounts[4] (ammConfig),
    // accounts[10] (observationState), and accounts[16..=18] (tick arrays).
    // The engine may store stale values (e.g. observationState falls back to poolId
    // when hop.observationState is undefined at quote time → ConstraintAddress error).
    if accounts.len() > 23 {
        let pool_pubkey = accounts[5].pubkey;
        match fetch_clmm_pool_state(pool_pubkey, rpc_client).await {
            Ok(pool_state) => {
                debug!(
                    pool = %pool_pubkey,
                    amm_config = %pool_state.amm_config,
                    observation_state = %pool_state.observation_state,
                    tick_current = pool_state.tick_current,
                    tick_spacing = pool_state.tick_spacing,
                    "Fetched live CLMM pool state"
                );

                let override_acct =
                    |accounts: &mut Vec<AccountMeta>, idx: usize, live: Pubkey, label: &str| {
                        if accounts[idx].pubkey != live {
                            warn!(
                                ccs = %accounts[idx].pubkey,
                                live = %live,
                                "{} mismatch — using live pool state",
                                label
                            );
                            accounts[idx].pubkey = live;
                        }
                    };

                override_acct(
                    &mut accounts,
                    4,
                    pool_state.amm_config,
                    "account[4] (ammConfig)",
                );

                // Determine swap direction from the input_mint (account[14]) vs pool mint0.
                // zero_for_one = inputMint == mint0 → inputVault=vault0, outputVault=vault1
                // If accounts[14] matches neither pool mint, CCS is corrupt — bail rather than
                // silently using the wrong vaults and ATAs.
                let input_mint = accounts[14].pubkey;
                let zero_for_one = if input_mint == pool_state.mint0 {
                    true
                } else if input_mint == pool_state.mint1 {
                    false
                } else {
                    bail!(
                        "accounts[14] (inputMint {}) matches neither pool mint0 ({}) nor mint1 ({}) — CCS route data is corrupt",
                        input_mint, pool_state.mint0, pool_state.mint1
                    );
                };
                let (live_input_vault, live_output_vault) = if zero_for_one {
                    (pool_state.vault0, pool_state.vault1)
                } else {
                    (pool_state.vault1, pool_state.vault0)
                };
                override_acct(
                    &mut accounts,
                    8,
                    live_input_vault,
                    "account[8] (inputVault)",
                );
                override_acct(
                    &mut accounts,
                    9,
                    live_output_vault,
                    "account[9] (outputVault)",
                );
                override_acct(
                    &mut accounts,
                    10,
                    pool_state.observation_state,
                    "account[10] (observationState)",
                );

                let ticks_in_array = 60i32.saturating_mul(pool_state.tick_spacing as i32);
                let ta0_start =
                    get_tick_array_start_index(pool_state.tick_current, pool_state.tick_spacing)?;
                // Forward progression matches the UI's buildClmmAccounts formula.
                // The UR COMMIT currently only supports one_for_zero swaps (price moves
                // up, tick increases), so forward tick arrays are always correct.  If
                // zero_for_one support is added in future, this must become conditional
                // on `zero_for_one` (subtract `ticks_in_array` for backward arrays).
                let ta1_start = ta0_start.saturating_add(ticks_in_array);
                let ta2_start = ta0_start.saturating_add(2i32.saturating_mul(ticks_in_array));
                let live_ta0 = compute_tick_array_address(&pool_pubkey, ta0_start);
                let live_ta1 = compute_tick_array_address(&pool_pubkey, ta1_start);
                let live_ta2 = compute_tick_array_address(&pool_pubkey, ta2_start);
                debug!(ta0 = %live_ta0, ta1 = %live_ta1, ta2 = %live_ta2, "Recomputed tick arrays from live pool state");
                accounts[16].pubkey = live_ta0;
                accounts[17].pubkey = live_ta1;
                accounts[18].pubkey = live_ta2;

                // Override mints from pool state so they're guaranteed correct.
                let live_input_mint = if zero_for_one {
                    pool_state.mint0
                } else {
                    pool_state.mint1
                };
                let live_output_mint = if zero_for_one {
                    pool_state.mint1
                } else {
                    pool_state.mint0
                };
                override_acct(
                    &mut accounts,
                    14,
                    live_input_mint,
                    "account[14] (inputMint)",
                );
                override_acct(
                    &mut accounts,
                    15,
                    live_output_mint,
                    "account[15] (outputMint)",
                );
                accounts[22].pubkey = live_output_mint;

                // Derive ATA accounts from locally-known authoritative values so stale CCS
                // entries can't cause address constraint failures.
                let input_token_prog = accounts[11].pubkey;
                let output_token_prog = accounts[23].pubkey;

                let live_pda_input_ata =
                    derive_ata(&expected_pending_swap, &live_input_mint, &input_token_prog);
                let live_pda_output_ata = derive_ata(
                    &expected_pending_swap,
                    &live_output_mint,
                    &output_token_prog,
                );
                let recipient_pubkey = Pubkey::new_from_array(recipient);
                let live_recipient_output_ata =
                    derive_ata(&recipient_pubkey, &live_output_mint, &output_token_prog);

                override_acct(
                    &mut accounts,
                    1,
                    live_pda_input_ata,
                    "account[1] (pda_input_ata)",
                );
                accounts[6].pubkey = live_pda_input_ata;
                override_acct(
                    &mut accounts,
                    7,
                    live_pda_output_ata,
                    "account[7] (pda_output_ata)",
                );
                accounts[20].pubkey = live_pda_output_ata;
                let fee_payer_pubkey = ctx.fee_payer.pubkey();
                let output_is_native_sol = live_output_mint == WSOL_MINT;

                // For native SOL output: account[21] must be the fee_payer's wSOL ATA
                // (not the recipient's). The UR SWEEP moves PDA wSOL → fee_payer wSOL ATA,
                // then a CloseAccount ix below unwraps it → native SOL to recipient.
                let (ata_second, maybe_close_ix) = if output_is_native_sol {
                    let fee_payer_wsol_ata =
                        derive_ata(&fee_payer_pubkey, &WSOL_MINT, &SPL_TOKEN_PROGRAM);
                    override_acct(
                        &mut accounts,
                        21,
                        fee_payer_wsol_ata,
                        "account[21] (fee_payer_wsol_ata for SOL output)",
                    );
                    // The ATA is closed atomically in the same tx (step 3 below), so it is
                    // always empty or non-existent at the start of each reveal — no pre-existing
                    // balance can accumulate from the reveal flow itself.
                    let ata_ix = make_ata_ix(
                        &fee_payer_pubkey,
                        &fee_payer_wsol_ata,
                        &fee_payer_pubkey,
                        &WSOL_MINT,
                        &SPL_TOKEN_PROGRAM,
                    );
                    let close_ix = make_close_account_ix(
                        &fee_payer_wsol_ata,
                        &recipient_pubkey,
                        &fee_payer_pubkey,
                    );
                    debug!(fee_payer_wsol_ata = %fee_payer_wsol_ata, "SOL output: closing wSOL ATA → native SOL to recipient");
                    (ata_ix, Some(close_ix))
                } else {
                    override_acct(
                        &mut accounts,
                        21,
                        live_recipient_output_ata,
                        "account[21] (recipient_output_ata)",
                    );
                    let ata_ix = make_ata_ix(
                        &fee_payer_pubkey,
                        &live_recipient_output_ata,
                        &recipient_pubkey,
                        &live_output_mint,
                        &output_token_prog,
                    );
                    (ata_ix, None)
                };

                let ata_pda_output = make_ata_ix(
                    &fee_payer_pubkey,
                    &live_pda_output_ata,
                    &expected_pending_swap,
                    &live_output_mint,
                    &output_token_prog,
                );

                // No more account splice: reveal() has no fallback path anymore (see
                // hyperlane-sealevel-universal-router's processor.rs), so it never needed
                // the old [3] recipient_ata/[4] token_program/[5] mint/[6] system_program
                // insertion — the CCS account list (now 24 accounts, CLMM block starting
                // at [3]) is used as-is.
                let reveal_ix = Instruction {
                    program_id,
                    accounts,
                    data,
                };
                let mut ixs = vec![ata_pda_output, ata_second, reveal_ix];
                if let Some(close_ix) = maybe_close_ix {
                    ixs.push(close_ix);
                }
                let close_accounts = Some(CloseAccounts {
                    pda_input_ata: live_pda_input_ata,
                    input_mint: live_input_mint,
                    input_token_prog,
                });
                return Ok((ixs, close_accounts));
            }
            Err(e) => {
                // Bail so the outer retry loop re-fetches pool state on the next attempt.
                // Submitting with stale CCS accounts would produce a ConstraintAddress failure
                // on-chain and, for SOL-output reveals, would silently omit the wSOL close
                // instruction — burning fees without unwrapping the token.
                bail!("Could not fetch live CLMM pool state: {e}");
            }
        }
    } else {
        warn!(
            account_count = accounts.len(),
            "Expected 24 accounts for CLMM reveal — skipping live pool state override"
        );
    }

    // Degraded path (CCS returned too few accounts for live overrides): still
    // report close_accounts from the raw CCS data when there's enough of it,
    // so a Reveal simulation failure can still fall back to ClosePendingSwap.
    let close_accounts = if accounts.len() > 14 {
        Some(CloseAccounts {
            pda_input_ata: accounts[1].pubkey,
            input_mint: accounts[14].pubkey,
            input_token_prog: accounts[11].pubkey,
        })
    } else {
        None
    };

    Ok((
        vec![Instruction {
            program_id,
            accounts,
            data,
        }],
        close_accounts,
    ))
}

fn hex_decode_bytes(hex_str: &str) -> Result<Vec<u8>> {
    let s = hex_str.strip_prefix("0x").unwrap_or(hex_str);
    hex::decode(s).map_err(|e| eyre!("hex decode: {e}"))
}

fn hex_decode_fixed32(hex_str: &str) -> Result<[u8; 32]> {
    hex_decode_bytes(hex_str)?
        .try_into()
        .map_err(|_| eyre!("expected 32 bytes from '{hex_str}'"))
}
