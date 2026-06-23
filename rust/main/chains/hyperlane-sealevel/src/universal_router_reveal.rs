//! Automated reveal submission for EVM→Solana CLMM swap commit-reveal pattern.
//!
//! After the Hyperlane mailbox delivers a COMMIT message to the Solana UR program,
//! `maybe_spawn_reveal` is called with the message. If the body is 96 bytes
//! (`commitment(32)|userSalt(32)|recipient(32)`) and `ur_reveal` is configured, a
//! `RouterInstruction::Reveal` (variant 2) is submitted in a spawned tokio task.
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
use std::time::Duration;

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
use tracing::{error, info, warn};

use crate::{
    priority_fee::PriorityFeeOracle, rpc::fallback::SealevelFallbackRpcClient, SealevelKeypair,
    SealevelTxType,
};

const REVEAL_COMPUTE_UNITS: u32 = 600_000;
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
            data[offset..offset + 32]
                .try_into()
                .expect("slice is exactly 32 bytes"),
        )
    };
    let tick_spacing = i16::from_le_bytes(
        data[POOL_TICK_SPACING_OFFSET..POOL_TICK_SPACING_OFFSET + 2]
            .try_into()
            .expect("slice is exactly 2 bytes"),
    );
    let tick_current = i32::from_le_bytes(
        data[POOL_TICK_CURRENT_OFFSET..POOL_TICK_CURRENT_OFFSET + 4]
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
fn get_tick_array_start_index(tick_current: i32, tick_spacing: i16) -> Result<i32> {
    if tick_spacing <= 0 {
        bail!("invalid tick_spacing: {tick_spacing}");
    }
    let ticks_in_array = 60i32 * tick_spacing as i32;
    let mut start = (tick_current / ticks_in_array) * ticks_in_array;
    if tick_current < 0 && tick_current % ticks_in_array != 0 {
        start -= ticks_in_array;
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
            error!("[REVEAL] Invalid program ID in config: {e}");
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

    info!(
        commitment = %commitment_hex,
        origin,
        sender = %hex::encode(sender),
        user_salt = %hex::encode(user_salt),
        ccs_url = %config.ccs_url,
        program_id = %config.program_id,
        fee_payer = %fee_payer.pubkey(),
        "[REVEAL] Spawning reveal task"
    );

    let ccs_url = config.ccs_url.trim_end_matches('/').to_owned();

    tokio::spawn(async move {
        info!(commitment = %commitment_hex, %program_id, "[REVEAL] Task started");
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
        let pending_swap_pda =
            derive_pending_swap_pda(&program_id, origin, &sender, &user_salt, &commitment);

        // Phase 1: confirm the pending_swap PDA is visible at confirmed commitment.
        // The task is spawned from on_delivered, so the commit is already confirmed —
        // the PDA should exist immediately. A short retry window handles RPC propagation
        // lag. If the PDA has tx history but is gone, it was already revealed; stop.
        const PDA_WAIT_MAX_ITERS: u32 = 5; // 5 × 5s = 25s propagation grace
        let mut pda_wait_iters: u32 = 0;
        loop {
            match rpc_client
                .get_account_option_with_commitment(pending_swap_pda, CommitmentConfig::confirmed())
                .await
            {
                Ok(Some(_)) => {
                    info!(commitment = %commitment_hex, %pending_swap_pda, "[REVEAL] PDA confirmed; proceeding to token wait");
                    break;
                }
                Ok(None) => {
                    match rpc_client
                        .get_signatures_for_address_with_limit(pending_swap_pda, 1)
                        .await
                    {
                        Ok(sigs) if !sigs.is_empty() => {
                            info!(
                                commitment = %commitment_hex,
                                %pending_swap_pda,
                                "[REVEAL] PDA gone with tx history — already revealed; stopping"
                            );
                            return;
                        }
                        Ok(_) => {}
                        Err(e) => {
                            warn!(commitment = %commitment_hex, error = ?e, "[REVEAL] Could not check PDA history");
                        }
                    }
                    pda_wait_iters += 1;
                    if pda_wait_iters >= PDA_WAIT_MAX_ITERS {
                        warn!(
                            commitment = %commitment_hex,
                            %pending_swap_pda,
                            "[REVEAL] PDA not visible after {}s post-confirmation; stopping",
                            PDA_WAIT_MAX_ITERS * 5
                        );
                        return;
                    }
                    info!(
                        commitment = %commitment_hex,
                        %pending_swap_pda,
                        wait_iters = pda_wait_iters,
                        "[REVEAL] PDA not yet visible; retrying in 5s"
                    );
                }
                Err(e) => {
                    warn!(commitment = %commitment_hex, error = ?e, "[REVEAL] Could not check PDA; retrying in 5s");
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
                    info!(commitment = %commitment_hex, "[REVEAL] PDA gone before tokens arrived; stopping");
                    return;
                }
                Err(e) => {
                    warn!(commitment = %commitment_hex, error = ?e, "[REVEAL] Could not check PDA while waiting for tokens");
                }
                Ok(Some(_)) => {}
            }

            // Fetch CCS to discover the pda_input_ata address.
            let ccs_opt = match fetch_from_ccs(&ctx.http_client, &ccs_url, &commitment).await {
                Ok(c) => Some(c),
                Err(e) => {
                    warn!(commitment = %commitment_hex, error = ?e, "[REVEAL] CCS fetch failed while waiting for tokens; retrying in 5s");
                    None
                }
            };

            if let Some(ccs) = ccs_opt {
                if let Some(accounts) = ccs.reveal_accounts.as_deref() {
                    if accounts.len() > 1 {
                        if let Ok(ata_pubkey) = Pubkey::from_str(&accounts[1].pubkey) {
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
                                        info!(
                                            commitment = %commitment_hex,
                                            %ata_pubkey,
                                            balance,
                                            "[REVEAL] PDA input ATA has tokens; proceeding to build tx"
                                        );
                                        break;
                                    }
                                    info!(
                                        commitment = %commitment_hex,
                                        %ata_pubkey,
                                        "[REVEAL] PDA input ATA exists but balance is zero; waiting 5s"
                                    );
                                }
                                Ok(None) => {
                                    info!(
                                        commitment = %commitment_hex,
                                        %ata_pubkey,
                                        "[REVEAL] PDA input ATA not yet created; waiting 5s"
                                    );
                                }
                                Ok(Some(_)) => {
                                    warn!(commitment = %commitment_hex, "[REVEAL] PDA input ATA has unexpected data length; waiting 5s");
                                }
                                Err(e) => {
                                    warn!(commitment = %commitment_hex, error = ?e, "[REVEAL] Could not check PDA input ATA balance; waiting 5s");
                                }
                            }
                        } else {
                            warn!(commitment = %commitment_hex, "[REVEAL] Could not parse accounts[1] pubkey from CCS; retrying in 5s");
                        }
                    } else {
                        warn!(commitment = %commitment_hex, "[REVEAL] CCS revealAccounts has <2 entries; retrying in 5s");
                    }
                } else {
                    warn!(commitment = %commitment_hex, "[REVEAL] CCS response missing revealAccounts; retrying in 5s");
                }
            }

            token_wait_iters += 1;
            if token_wait_iters >= TOKEN_WAIT_MAX_ITERS {
                error!(
                    commitment = %commitment_hex,
                    %pending_swap_pda,
                    "[REVEAL] Warp tokens never arrived after {}s; inbound transfer may be stuck; stopping",
                    TOKEN_WAIT_MAX_ITERS * 5
                );
                return;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }

        let mut delay_secs = REVEAL_INITIAL_RETRY_DELAY_SECS;
        loop {
            match submit_reveal(&ctx).await {
                Ok(()) => {
                    info!(commitment = %commitment_hex, "[REVEAL] Confirmed successfully");
                    break;
                }
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("Reveal tx failed on-chain") {
                        // On-chain rejection — two possible causes:
                        // 1. PDA is gone: another relayer already revealed → we're done.
                        // 2. PDA still exists: our params were rejected (stale pool state,
                        //    wrong vaults, etc.) → retry; build_instruction fetches fresh
                        //    pool state on each call so the next attempt should self-correct.
                        match rpc_client
                            .get_account_option_with_commitment(
                                pending_swap_pda,
                                CommitmentConfig::confirmed(),
                            )
                            .await
                        {
                            Ok(None) => {
                                info!(
                                    commitment = %commitment_hex,
                                    %pending_swap_pda,
                                    "[REVEAL] pending_swap PDA is gone — reveal completed by another relayer; stopping"
                                );
                                break;
                            }
                            Ok(Some(_)) => {
                                warn!(
                                    commitment = %commitment_hex,
                                    retry_in_secs = delay_secs,
                                    error = ?e,
                                    "[REVEAL] On-chain rejection but PDA still exists; retrying with fresh pool state"
                                );
                            }
                            Err(check_err) => {
                                warn!(
                                    commitment = %commitment_hex,
                                    error = ?check_err,
                                    "[REVEAL] Could not check PDA existence after on-chain error; will retry"
                                );
                            }
                        }
                    } else {
                        warn!(
                            commitment = %commitment_hex,
                            retry_in_secs = delay_secs,
                            error = ?e,
                            "[REVEAL] Transient failure; will retry"
                        );
                    }
                    tokio::time::sleep(Duration::from_secs(delay_secs)).await;
                    delay_secs = (delay_secs * 2).min(REVEAL_MAX_RETRY_DELAY_SECS);
                }
            }
        }
    });
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
    let commitment_hex = hex::encode(ctx.commitment);

    info!(commitment = %commitment_hex, ccs_url = ctx.ccs_url, "[REVEAL] Fetching calldata from CCS");
    let ccs = fetch_from_ccs(&ctx.http_client, ctx.ccs_url, &ctx.commitment).await?;
    info!(
        commitment = %commitment_hex,
        data_len = ccs.data.len(),
        salt = %ccs.salt,
        reveal_accounts_count = ccs.reveal_accounts.as_ref().map(|a| a.len()).unwrap_or(0),
        "[REVEAL] CCS fetch succeeded"
    );

    info!(commitment = %commitment_hex, "[REVEAL] Building RouterInstruction::Reveal");
    let built = build_instruction(ctx, &ccs).await?;
    info!(
        commitment = %commitment_hex,
        instruction_count = built.len(),
        "[REVEAL] Instructions built"
    );

    let dummy = SealevelTxType::Legacy(Transaction::new_unsigned(Message::new(
        &[],
        Some(&ctx.fee_payer.pubkey()),
    )));
    let priority_fee = ctx
        .priority_fee_oracle
        .get_priority_fee(&dummy)
        .await
        .unwrap_or(0);
    info!(
        commitment = %commitment_hex,
        priority_fee,
        compute_units = REVEAL_COMPUTE_UNITS,
        "[REVEAL] Priority fee determined"
    );

    // Outer loop: each attempt fetches a fresh blockhash and rebuilds the tx.
    // On mainnet, a tx sent once is often silently dropped by congested leaders;
    // the inner loop resends periodically within the ~150-slot (~60 s) validity
    // window, and the outer loop retries after the window expires.
    for send_attempt in 1..=SEND_RETRY_MAX {
        // Fresh blockhash each attempt so the tx is valid for a new ~150-slot window.
        info!(commitment = %commitment_hex, send_attempt, "[REVEAL] Fetching latest blockhash");
        let blockhash = ctx
            .rpc_client
            .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
            .await
            .map_err(|e| eyre!("get_latest_blockhash: {e}"))?;
        info!(commitment = %commitment_hex, blockhash = %blockhash, "[REVEAL] Got blockhash");

        let mut instructions = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(REVEAL_COMPUTE_UNITS),
            ComputeBudgetInstruction::set_compute_unit_price(priority_fee),
        ];
        instructions.extend(built.iter().cloned());

        let message = Message::new(&instructions, Some(&ctx.fee_payer.pubkey()));
        let tx = Transaction::new(&[ctx.fee_payer.keypair()], message, blockhash);

        info!(
            commitment = %commitment_hex,
            fee_payer = %ctx.fee_payer.pubkey(),
            send_attempt,
            "[REVEAL] Sending transaction"
        );
        let signature = ctx
            .rpc_client
            .send_transaction(&tx, true)
            .await
            .map_err(|e| eyre!("send_transaction (attempt {send_attempt}): {e}"))?;

        info!(
            commitment = %commitment_hex,
            %signature,
            send_attempt,
            "[REVEAL] Tx sent; polling for confirmation"
        );

        let mut confirmed = false;
        for poll in 1..=CONFIRM_POLLS_PER_BLOCKHASH {
            tokio::time::sleep(Duration::from_millis(CONFIRM_POLL_DELAY_MS)).await;

            // Resend periodically to keep the tx in the leader queue within the validity window.
            if poll % RESEND_INTERVAL_POLLS == 0 {
                if let Err(e) = ctx.rpc_client.send_transaction(&tx, true).await {
                    warn!(commitment = %commitment_hex, %signature, poll, error = ?e, "[REVEAL] Resend error (non-fatal)");
                }
            }

            info!(
                commitment = %commitment_hex,
                %signature,
                send_attempt,
                poll,
                max_polls = CONFIRM_POLLS_PER_BLOCKHASH,
                "[REVEAL] Polling confirmation"
            );
            match ctx.rpc_client.get_signature_statuses(&[signature]).await {
                Ok(response) => match response.value.into_iter().next().flatten() {
                    None => {
                        info!(commitment = %commitment_hex, %signature, poll, "[REVEAL] Tx not yet seen; continuing to poll");
                    }
                    Some(TransactionStatus { err: Some(e), .. }) => {
                        bail!("Reveal tx failed on-chain: {e:?}");
                    }
                    Some(status) if status.satisfies_commitment(CommitmentConfig::confirmed()) => {
                        info!(commitment = %commitment_hex, %signature, send_attempt, poll, "[REVEAL] Tx confirmed");
                        confirmed = true;
                        break;
                    }
                    Some(_) => {
                        info!(commitment = %commitment_hex, %signature, poll, "[REVEAL] Tx processed but not yet confirmed; continuing to poll");
                    }
                },
                Err(e) => {
                    warn!(commitment = %commitment_hex, %signature, error = ?e, poll, "[REVEAL] Error polling confirmation");
                }
            }
        }

        if confirmed {
            return Ok(());
        }

        if send_attempt < SEND_RETRY_MAX {
            warn!(
                commitment = %commitment_hex,
                %signature,
                send_attempt,
                "[REVEAL] Tx not confirmed within blockhash window; retrying with fresh blockhash"
            );
        }
    }
    bail!(
        "Reveal tx not confirmed after {} send attempts",
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
    info!(commitment = %commitment_hex, url, "[REVEAL] GET CCS calldata");
    for attempt in 1..=CCS_MAX_RETRIES {
        info!(commitment = %commitment_hex, attempt, max_retries = CCS_MAX_RETRIES, url, "[REVEAL] CCS fetch attempt");
        let resp = http.get(&url).send().await?;
        let status = resp.status();
        info!(commitment = %commitment_hex, attempt, %status, "[REVEAL] CCS response received");
        match status {
            s if s.is_success() => {
                let ccs = resp.json::<CcsGetResponse>().await?;
                info!(
                    commitment = %commitment_hex,
                    attempt,
                    has_reveal_accounts = ccs.reveal_accounts.is_some(),
                    "[REVEAL] CCS calldata parsed successfully"
                );
                return Ok(ccs);
            }
            reqwest::StatusCode::NOT_FOUND => {
                if attempt < CCS_MAX_RETRIES {
                    warn!(
                        commitment = %commitment_hex,
                        attempt,
                        max_retries = CCS_MAX_RETRIES,
                        retry_delay_secs = CCS_RETRY_DELAY_SECS,
                        "[REVEAL] CCS 404 — calldata not yet stored; retrying"
                    );
                    tokio::time::sleep(Duration::from_secs(CCS_RETRY_DELAY_SECS)).await;
                } else {
                    warn!(commitment = %commitment_hex, attempt, "[REVEAL] CCS 404 on final attempt");
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
// commitment = keccak256(calldata || revealSalt), same value stored in PDA and in the COMMIT body.
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

/// Returns [ata_create_0, ata_create_1, reveal_ix] — the two idempotent ATA creates must
/// precede the reveal instruction so the CLMM output account and recipient ATA exist.
async fn build_instruction(
    ctx: &RevealContext<'_>,
    ccs: &CcsGetResponse,
) -> Result<Vec<Instruction>> {
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
        solana_program::keccak::hashv(&[message.as_slice(), salt.as_ref()]).to_bytes();
    if ccs_commitment != commitment {
        bail!(
            "CCS keccak(calldata||salt) {} does not match message body commitment {} — CCS data is stale or wrong",
            hex::encode(ccs_commitment),
            hex::encode(commitment),
        );
    }

    let msg_len = message.len() as u32;
    info!(
        origin,
        sender = %hex::encode(sender),
        user_salt = %hex::encode(user_salt),
        message_len = msg_len,
        salt = %ccs.salt,
        "[REVEAL] Building instruction data"
    );

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
    info!(
        expected_pending_swap = %expected_pending_swap,
        expected_fee_payer_pda = %expected_fee_payer_pda,
        "[REVEAL] Locally-derived PDAs"
    );

    info!(
        account_count = reveal_accounts.len(),
        "[REVEAL] Building account metas"
    );
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
                            "[REVEAL] account[0] (pending_swap PDA) mismatch — using locally-derived PDA"
                        );
                    }
                    expected_pending_swap
                }
                2 => {
                    if pubkey != expected_fee_payer_pda {
                        warn!(
                            ccs_pubkey = %pubkey,
                            expected = %expected_fee_payer_pda,
                            "[REVEAL] account[2] (fee_payer_pda) mismatch — using locally-derived PDA"
                        );
                    }
                    expected_fee_payer_pda
                }
                _ => pubkey,
            };

            info!(
                index = i,
                pubkey = %pubkey,
                is_writable = a.is_writable,
                is_signer = a.is_signer,
                "[REVEAL] Account"
            );
            Ok(match (a.is_writable, a.is_signer) {
                (true, _) => AccountMeta::new(pubkey, a.is_signer),
                (false, _) => AccountMeta::new_readonly(pubkey, a.is_signer),
            })
        })
        .collect::<Result<_>>()?;

    // Fetch live CLMM pool state and override accounts[5] (ammConfig),
    // accounts[11] (observationState), and accounts[17..=19] (tick arrays).
    // The engine may store stale values (e.g. observationState falls back to poolId
    // when hop.observationState is undefined at quote time → ConstraintAddress error).
    if accounts.len() > 24 {
        let pool_pubkey = accounts[6].pubkey;
        match fetch_clmm_pool_state(pool_pubkey, rpc_client).await {
            Ok(pool_state) => {
                info!(
                    pool = %pool_pubkey,
                    amm_config = %pool_state.amm_config,
                    observation_state = %pool_state.observation_state,
                    tick_current = pool_state.tick_current,
                    tick_spacing = pool_state.tick_spacing,
                    "[REVEAL] Fetched live CLMM pool state"
                );

                let override_acct =
                    |accounts: &mut Vec<AccountMeta>, idx: usize, live: Pubkey, label: &str| {
                        if accounts[idx].pubkey != live {
                            warn!(
                                ccs = %accounts[idx].pubkey,
                                live = %live,
                                "[REVEAL] {} mismatch — using live pool state",
                                label
                            );
                            accounts[idx].pubkey = live;
                        }
                    };

                override_acct(
                    &mut accounts,
                    5,
                    pool_state.amm_config,
                    "account[5] (ammConfig)",
                );

                // Determine swap direction from the input_mint (account[15]) vs pool mint0.
                // zero_for_one = inputMint == mint0 → inputVault=vault0, outputVault=vault1
                // If accounts[15] matches neither pool mint, CCS is corrupt — bail rather than
                // silently using the wrong vaults and ATAs.
                let input_mint = accounts[15].pubkey;
                let zero_for_one = if input_mint == pool_state.mint0 {
                    true
                } else if input_mint == pool_state.mint1 {
                    false
                } else {
                    bail!(
                        "accounts[15] (inputMint {}) matches neither pool mint0 ({}) nor mint1 ({}) — CCS route data is corrupt",
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
                    9,
                    live_input_vault,
                    "account[9] (inputVault)",
                );
                override_acct(
                    &mut accounts,
                    10,
                    live_output_vault,
                    "account[10] (outputVault)",
                );
                override_acct(
                    &mut accounts,
                    11,
                    pool_state.observation_state,
                    "account[11] (observationState)",
                );

                let ticks_in_array = 60i32 * pool_state.tick_spacing as i32;
                let ta0_start =
                    get_tick_array_start_index(pool_state.tick_current, pool_state.tick_spacing)?;
                // Forward progression matches UI's buildClmmAccounts formula.
                let ta1_start = ta0_start + ticks_in_array;
                let ta2_start = ta0_start + 2 * ticks_in_array;
                let live_ta0 = compute_tick_array_address(&pool_pubkey, ta0_start);
                let live_ta1 = compute_tick_array_address(&pool_pubkey, ta1_start);
                let live_ta2 = compute_tick_array_address(&pool_pubkey, ta2_start);
                info!(
                    ta0 = %live_ta0,
                    ta1 = %live_ta1,
                    ta2 = %live_ta2,
                    ta0_start,
                    ta1_start,
                    ta2_start,
                    "[REVEAL] Recomputed tick arrays from live pool state"
                );
                accounts[17].pubkey = live_ta0;
                accounts[18].pubkey = live_ta1;
                accounts[19].pubkey = live_ta2;

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
                    15,
                    live_input_mint,
                    "account[15] (inputMint)",
                );
                override_acct(
                    &mut accounts,
                    16,
                    live_output_mint,
                    "account[16] (outputMint)",
                );
                accounts[23].pubkey = live_output_mint;

                // Derive ATA accounts from locally-known authoritative values so stale CCS
                // entries can't cause address constraint failures.
                let input_token_prog = accounts[12].pubkey;
                let output_token_prog = accounts[24].pubkey;

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
                accounts[7].pubkey = live_pda_input_ata;
                override_acct(
                    &mut accounts,
                    8,
                    live_pda_output_ata,
                    "account[8] (pda_output_ata)",
                );
                accounts[21].pubkey = live_pda_output_ata;
                let fee_payer_pubkey = ctx.fee_payer.pubkey();
                let output_is_native_sol = live_output_mint == WSOL_MINT;

                // For native SOL output: account[22] must be the fee_payer's wSOL ATA
                // (not the recipient's). The UR SWEEP moves PDA wSOL → fee_payer wSOL ATA,
                // then a CloseAccount ix below unwraps it → native SOL to recipient.
                let (ata_second, maybe_close_ix) = if output_is_native_sol {
                    let fee_payer_wsol_ata =
                        derive_ata(&fee_payer_pubkey, &WSOL_MINT, &SPL_TOKEN_PROGRAM);
                    override_acct(
                        &mut accounts,
                        22,
                        fee_payer_wsol_ata,
                        "account[22] (fee_payer_wsol_ata for SOL output)",
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
                    info!(
                        fee_payer_wsol_ata = %fee_payer_wsol_ata,
                        recipient = %recipient_pubkey,
                        "[REVEAL] SOL output: fee_payer wSOL ATA will be closed → native SOL to recipient"
                    );
                    (ata_ix, Some(close_ix))
                } else {
                    override_acct(
                        &mut accounts,
                        22,
                        live_recipient_output_ata,
                        "account[22] (recipient_output_ata)",
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

                info!(
                    pda_output_ata = %live_pda_output_ata,
                    output_is_native_sol,
                    "[REVEAL] ATA creation instructions prepared"
                );

                let reveal_ix = Instruction {
                    program_id,
                    accounts,
                    data,
                };
                let mut ixs = vec![ata_pda_output, ata_second, reveal_ix];
                if let Some(close_ix) = maybe_close_ix {
                    ixs.push(close_ix);
                }
                return Ok(ixs);
            }
            Err(e) => {
                warn!(
                    pool = %pool_pubkey,
                    error = ?e,
                    "[REVEAL] Could not fetch CLMM pool state; submitting without ATA pre-creation"
                );
            }
        }
    } else {
        warn!(
            account_count = accounts.len(),
            "[REVEAL] Expected 25 accounts for CLMM reveal — skipping live pool state override"
        );
    }

    info!(
        total_data_len = data.len(),
        total_accounts = accounts.len(),
        "[REVEAL] Instruction assembled (no pool state override)"
    );

    Ok(vec![Instruction {
        program_id,
        accounts,
        data,
    }])
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
