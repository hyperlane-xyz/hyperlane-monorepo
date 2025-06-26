use super::escrow::*;

use bytes::Bytes;

use std::sync::Arc;

use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::tx::Fees;

use kaspa_addresses::Prefix;

use kaspa_wallet_core::prelude::*;

use workflow_core::abortable::Abortable;

use hyperlane_core::HyperlaneMessage;
use hyperlane_core::H256;
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct DepositFXG {
    pub msg_id: H256,
    pub tx_id: String,
    pub utxo_index: usize,
    pub block_id: String,
    pub payload: HyperlaneMessage,
}

impl TryFrom<Bytes> for DepositFXG {
    type Error = eyre::Report;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        // Deserialize the bytes into DepositFXG using bincode
        bincode::deserialize(&bytes).map_err(|e| {
            eyre::Report::new(e).wrap_err("Failed to deserialize DepositFXG from bytes")
        })
    }
}

impl From<&DepositFXG> for Bytes {
    fn from(deposit: &DepositFXG) -> Self {
        // Serialize the DepositFXG into bytes using bincode
        let encoded: Vec<u8> =
            bincode::serialize(deposit).expect("Failed to serialize DepositFXG into bytes");
        Bytes::from(encoded)
    }
}

pub async fn deposit(
    w: &Arc<Wallet>,
    secret: &Secret,
    e: &Escrow,
    amt: u64,
    prefix: Prefix,
) -> Result<TransactionId, Error> {
    let a = w.account()?;

    let dst = PaymentDestination::from(PaymentOutput::new(e.public(prefix).addr, amt));
    let fees = Fees::from(0i64);
    let payload = None;
    let payment_secret = None;
    let abortable = Abortable::new();

    // use account.send, because wallet.accounts_send(AccountsSendRequest{..}) is buggy
    let (summary, _) = a
        .send(
            dst,
            fees,
            payload,
            secret.clone(),
            payment_secret,
            &abortable,
            None,
        )
        .await?;

    summary.final_transaction_id().ok_or_else(|| {
        Error::Custom("Deposit transaction failed to generate a transaction ID".to_string())
    })
}
