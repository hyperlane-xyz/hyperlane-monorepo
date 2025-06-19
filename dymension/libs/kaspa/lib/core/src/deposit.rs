use super::escrow::*;

use eyre::Error as EyreError;

use bytes::Bytes;

use std::sync::Arc;

use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::tx::Fees;

use kaspa_addresses::Prefix;

use kaspa_wallet_core::prelude::*;

use workflow_core::abortable::Abortable;
pub struct DepositFXG;

impl TryFrom<Bytes> for DepositFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        unimplemented!()
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
