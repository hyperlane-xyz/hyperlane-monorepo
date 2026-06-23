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
use tracing::{error, info, warn};

use crate::{
    priority_fee::PriorityFeeOracle, rpc::fallback::SealevelFallbackRpcClient, SealevelKeypair,
    SealevelTxType,
};

const REVEAL_COMPUTE_UNITS: u32 = 600_000;
const CCS_MAX_RETRIES: u32 = 10;
const CCS_RETRY_DELAY_SECS: u64 = 5;
const CONFIRM_MAX_POLLS: u32 = 60;
const CONFIRM_POLL_DELAY_MS: u64 = 2_000;

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

/// If `message` looks like a UR COMMIT (96-byte body) and config is present, spawns a
/// tokio task to fetch from CCS and submit `RouterInstruction::Reveal`.
pub fn maybe_spawn_reveal(
    message: &HyperlaneMessage,
    config: &UniversalRouterRevealConfig,
    rpc_client: SealevelFallbackRpcClient,
    priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
    fee_payer: SealevelKeypair,
) {
    let body_len = message.body.len();
    if body_len != 96 {
        info!(
            body_len,
            origin = message.origin,
            "Skipping UR reveal: body is not 96 bytes (not a COMMIT message)"
        );
        return;
    }
    // COMMIT body: commitment(32) | userSalt(32) | recipient(32)
    #[allow(clippy::unwrap_used)]
    let commitment: [u8; 32] = message.body[0..32].try_into().unwrap();
    #[allow(clippy::unwrap_used)]
    let user_salt: [u8; 32] = message.body[32..64].try_into().unwrap();
    let origin = message.origin;
    let sender = message.sender.0;
    let commitment_hex = hex::encode(commitment);
    let sender_hex = hex::encode(sender);
    let user_salt_hex = hex::encode(user_salt);

    info!(
        commitment = %commitment_hex,
        origin,
        sender = %sender_hex,
        user_salt = %user_salt_hex,
        ccs_url = %config.ccs_url,
        program_id = %config.program_id,
        fee_payer = %fee_payer.pubkey(),
        "Spawning UR reveal task"
    );

    let ccs_url = config.ccs_url.trim_end_matches('/').to_owned();
    let program_id_str = config.program_id.clone();

    tokio::spawn(async move {
        let program_id = match Pubkey::from_str(&program_id_str) {
            Ok(p) => p,
            Err(e) => {
                error!(commitment = %commitment_hex, error = ?e, "Invalid UR program ID; aborting reveal");
                return;
            }
        };
        info!(commitment = %commitment_hex, %program_id, "UR reveal task started");
        let ctx = RevealContext {
            ccs_url: &ccs_url,
            program_id,
            commitment,
            origin,
            sender,
            user_salt,
            rpc_client: &rpc_client,
            priority_fee_oracle,
            fee_payer: &fee_payer,
        };
        match submit_reveal(ctx).await {
            Err(e) => error!(commitment = %commitment_hex, error = ?e, "UR reveal failed"),
            Ok(()) => info!(commitment = %commitment_hex, "UR reveal confirmed successfully"),
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
    rpc_client: &'a SealevelFallbackRpcClient,
    priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
    fee_payer: &'a SealevelKeypair,
}

async fn submit_reveal(ctx: RevealContext<'_>) -> Result<()> {
    let RevealContext {
        ccs_url,
        program_id,
        commitment,
        origin,
        sender,
        user_salt,
        rpc_client,
        priority_fee_oracle,
        fee_payer,
    } = ctx;
    let commitment_hex = hex::encode(commitment);

    info!(commitment = %commitment_hex, ccs_url, "Fetching reveal data from CCS");
    let http = Client::new();
    let ccs = fetch_from_ccs(&http, ccs_url, &commitment).await?;
    info!(
        commitment = %commitment_hex,
        data_len = ccs.data.len(),
        salt = %ccs.salt,
        reveal_accounts_count = ccs.reveal_accounts.as_ref().map(|a| a.len()).unwrap_or(0),
        "CCS fetch succeeded"
    );

    info!(commitment = %commitment_hex, "Building RouterInstruction::Reveal");
    let instruction = build_instruction(program_id, origin, sender, user_salt, &ccs)?;
    info!(
        commitment = %commitment_hex,
        accounts_count = instruction.accounts.len(),
        data_len = instruction.data.len(),
        "Reveal instruction built"
    );

    let dummy = SealevelTxType::Legacy(Transaction::new_unsigned(Message::new(
        &[],
        Some(&fee_payer.pubkey()),
    )));
    let priority_fee = priority_fee_oracle
        .get_priority_fee(&dummy)
        .await
        .unwrap_or(0);
    info!(
        commitment = %commitment_hex,
        priority_fee,
        compute_units = REVEAL_COMPUTE_UNITS,
        "Priority fee determined"
    );

    let instructions = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(REVEAL_COMPUTE_UNITS),
        ComputeBudgetInstruction::set_compute_unit_price(priority_fee),
        instruction,
    ];

    info!(commitment = %commitment_hex, "Fetching latest blockhash");
    let blockhash = rpc_client
        .get_latest_blockhash_with_commitment(CommitmentConfig::finalized())
        .await
        .map_err(|e| eyre!("get_latest_blockhash: {e}"))?;
    info!(commitment = %commitment_hex, blockhash = %blockhash, "Got blockhash");

    let message = Message::new(&instructions, Some(&fee_payer.pubkey()));
    let tx = Transaction::new(&[fee_payer.keypair()], message, blockhash);

    info!(commitment = %commitment_hex, fee_payer = %fee_payer.pubkey(), "Sending reveal transaction");
    let signature = rpc_client
        .send_transaction(&tx, true)
        .await
        .map_err(|e| eyre!("send_transaction: {e}"))?;

    let max_confirm_secs = CONFIRM_MAX_POLLS.saturating_mul((CONFIRM_POLL_DELAY_MS / 1000) as u32);
    info!(commitment = %commitment_hex, %signature, max_confirm_secs, "Reveal tx sent; polling for confirmation");

    for attempt in 1..=CONFIRM_MAX_POLLS {
        tokio::time::sleep(Duration::from_millis(CONFIRM_POLL_DELAY_MS)).await;
        info!(commitment = %commitment_hex, %signature, attempt, max_attempts = CONFIRM_MAX_POLLS, "Polling reveal tx confirmation");
        match rpc_client
            .confirm_transaction_with_commitment(signature, CommitmentConfig::confirmed())
            .await
        {
            Ok(true) => {
                info!(commitment = %commitment_hex, %signature, attempt, "Reveal tx confirmed");
                return Ok(());
            }
            Ok(false) => {
                if attempt == CONFIRM_MAX_POLLS {
                    bail!("Reveal tx not confirmed after {} polls", CONFIRM_MAX_POLLS);
                }
                info!(commitment = %commitment_hex, %signature, attempt, "Reveal tx not yet confirmed; continuing to poll");
            }
            Err(e) => {
                warn!(commitment = %commitment_hex, %signature, error = ?e, attempt, "Error polling reveal tx confirmation")
            }
        }
    }
    bail!("Reveal tx confirmation timed out")
}

async fn fetch_from_ccs(
    http: &Client,
    ccs_url: &str,
    commitment: &[u8; 32],
) -> Result<CcsGetResponse> {
    let commitment_hex = hex::encode(commitment);
    let url = format!("{ccs_url}/calldata/0x{commitment_hex}");
    info!(commitment = %commitment_hex, url, "GET CCS calldata");
    for attempt in 1..=CCS_MAX_RETRIES {
        info!(commitment = %commitment_hex, attempt, max_retries = CCS_MAX_RETRIES, url, "CCS fetch attempt");
        let resp = http.get(&url).send().await?;
        let status = resp.status();
        info!(commitment = %commitment_hex, attempt, %status, "CCS response received");
        match status {
            s if s.is_success() => {
                let ccs = resp.json::<CcsGetResponse>().await?;
                info!(
                    commitment = %commitment_hex,
                    attempt,
                    has_reveal_accounts = ccs.reveal_accounts.is_some(),
                    "CCS calldata parsed successfully"
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
                        "CCS 404 — calldata not yet stored; retrying"
                    );
                    tokio::time::sleep(Duration::from_secs(CCS_RETRY_DELAY_SECS)).await;
                } else {
                    warn!(commitment = %commitment_hex, attempt, "CCS 404 on final attempt");
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

fn build_instruction(
    program_id: Pubkey,
    origin: u32,
    sender: [u8; 32],
    user_salt: [u8; 32],
    ccs: &CcsGetResponse,
) -> Result<Instruction> {
    let message = hex_decode_bytes(&ccs.data)?;
    let salt = hex_decode_fixed32(&ccs.salt)?;

    let msg_len = message.len() as u32;
    info!(
        origin,
        sender = %hex::encode(sender),
        user_salt = %hex::encode(user_salt),
        message_len = msg_len,
        salt = %ccs.salt,
        "Building reveal instruction data"
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

    info!(
        account_count = reveal_accounts.len(),
        "Building account metas from revealAccounts"
    );
    let accounts: Vec<AccountMeta> = reveal_accounts
        .iter()
        .enumerate()
        .map(|(i, a)| {
            info!(
                index = i,
                pubkey = %a.pubkey,
                is_writable = a.is_writable,
                is_signer = a.is_signer,
                "Reveal account"
            );
            let pubkey = Pubkey::from_str(&a.pubkey)
                .map_err(|e| eyre!("invalid pubkey {}: {}", a.pubkey, e))?;
            Ok(match (a.is_writable, a.is_signer) {
                (true, _) => AccountMeta::new(pubkey, a.is_signer),
                (false, _) => AccountMeta::new_readonly(pubkey, a.is_signer),
            })
        })
        .collect::<Result<_>>()?;

    info!(
        total_data_len = data.len(),
        total_accounts = accounts.len(),
        "Reveal instruction assembled"
    );

    Ok(Instruction {
        program_id,
        accounts,
        data,
    })
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
