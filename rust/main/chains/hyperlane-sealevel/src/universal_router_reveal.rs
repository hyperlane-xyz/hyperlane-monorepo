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
    if message.body.len() != 96 {
        return;
    }
    // COMMIT body: commitment(32) | userSalt(32) | recipient(32)
    #[allow(clippy::unwrap_used)]
    let commitment: [u8; 32] = message.body[0..32].try_into().unwrap();
    #[allow(clippy::unwrap_used)]
    let user_salt: [u8; 32] = message.body[32..64].try_into().unwrap();
    let origin = message.origin;
    let sender = message.sender.0;

    let ccs_url = config.ccs_url.trim_end_matches('/').to_owned();
    let program_id_str = config.program_id.clone();

    tokio::spawn(async move {
        let hex = hex::encode(commitment);
        info!(commitment = %hex, "Submitting UR reveal");
        let program_id = match Pubkey::from_str(&program_id_str) {
            Ok(p) => p,
            Err(e) => {
                error!(commitment = %hex, error = ?e, "Invalid UR program ID");
                return;
            }
        };
        if let Err(e) = submit_reveal(
            &ccs_url,
            program_id,
            commitment,
            origin,
            sender,
            user_salt,
            &rpc_client,
            priority_fee_oracle,
            &fee_payer,
        )
        .await
        {
            error!(commitment = %hex, error = ?e, "UR reveal failed");
        } else {
            info!(commitment = %hex, "UR reveal submitted successfully");
        }
    });
}

async fn submit_reveal(
    ccs_url: &str,
    program_id: Pubkey,
    commitment: [u8; 32],
    origin: u32,
    sender: [u8; 32],
    user_salt: [u8; 32],
    rpc_client: &SealevelFallbackRpcClient,
    priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
    fee_payer: &SealevelKeypair,
) -> Result<()> {
    let http = Client::new();
    let ccs = fetch_from_ccs(&http, ccs_url, &commitment).await?;
    let instruction = build_instruction(program_id, origin, sender, user_salt, &ccs)?;

    let dummy = SealevelTxType::Legacy(Transaction::new_unsigned(Message::new(
        &[],
        Some(&fee_payer.pubkey()),
    )));
    let priority_fee = priority_fee_oracle
        .get_priority_fee(&dummy)
        .await
        .unwrap_or(0);

    let instructions = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(REVEAL_COMPUTE_UNITS),
        ComputeBudgetInstruction::set_compute_unit_price(priority_fee),
        instruction,
    ];

    let blockhash = rpc_client
        .get_latest_blockhash_with_commitment(CommitmentConfig::finalized())
        .await
        .map_err(|e| eyre!("get_latest_blockhash: {e}"))?;

    let message = Message::new(&instructions, Some(&fee_payer.pubkey()));
    let tx = Transaction::new(&[fee_payer.keypair()], message, blockhash);

    let signature = rpc_client
        .send_transaction(&tx, true)
        .await
        .map_err(|e| eyre!("send_transaction: {e}"))?;

    info!(%signature, "Reveal tx sent, awaiting confirmation");

    for attempt in 1..=CONFIRM_MAX_POLLS {
        tokio::time::sleep(Duration::from_millis(CONFIRM_POLL_DELAY_MS)).await;
        match rpc_client
            .confirm_transaction_with_commitment(signature, CommitmentConfig::confirmed())
            .await
        {
            Ok(true) => return Ok(()),
            Ok(false) => {
                if attempt == CONFIRM_MAX_POLLS {
                    bail!("Reveal tx not confirmed after {} polls", CONFIRM_MAX_POLLS);
                }
            }
            Err(e) => warn!(%signature, error = ?e, "Error polling reveal tx confirmation"),
        }
    }
    bail!("Reveal tx confirmation timed out")
}

async fn fetch_from_ccs(
    http: &Client,
    ccs_url: &str,
    commitment: &[u8; 32],
) -> Result<CcsGetResponse> {
    let url = format!("{}/calldata/0x{}", ccs_url, hex::encode(commitment));
    for attempt in 1..=CCS_MAX_RETRIES {
        let resp = http.get(&url).send().await?;
        match resp.status() {
            s if s.is_success() => return Ok(resp.json::<CcsGetResponse>().await?),
            reqwest::StatusCode::NOT_FOUND => {
                if attempt < CCS_MAX_RETRIES {
                    warn!(
                        attempt,
                        "CCS 404 for commitment; retrying in {}s", CCS_RETRY_DELAY_SECS
                    );
                    tokio::time::sleep(Duration::from_secs(CCS_RETRY_DELAY_SECS)).await;
                }
            }
            status => bail!(
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
    let mut data = Vec::with_capacity(1 + 4 + 32 + 32 + 4 + message.len() + 32);
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

    let accounts: Vec<AccountMeta> = reveal_accounts
        .iter()
        .map(|a| {
            let pubkey = Pubkey::from_str(&a.pubkey)
                .map_err(|e| eyre!("invalid pubkey {}: {}", a.pubkey, e))?;
            Ok(match (a.is_writable, a.is_signer) {
                (true, _) => AccountMeta::new(pubkey, a.is_signer),
                (false, _) => AccountMeta::new_readonly(pubkey, a.is_signer),
            })
        })
        .collect::<Result<_>>()?;

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
