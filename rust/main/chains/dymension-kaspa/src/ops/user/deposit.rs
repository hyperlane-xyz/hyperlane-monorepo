use eyre::Result;
use kaspa_addresses::Address;
use kaspa_wallet_core::error::Error as KaspaError;
use kaspa_wallet_core::prelude::*;
use kaspa_wallet_core::tx::Fees;
use std::sync::Arc;
use workflow_core::abortable::Abortable;

pub async fn deposit_with_payload(
    w: &Arc<Wallet>,
    secret: &Secret,
    address: Address,
    amt: u64,
    payload: Vec<u8>,
) -> Result<TransactionId, KaspaError> {
    let a = w.account()?;

    let dst = PaymentDestination::from(PaymentOutput::new(address, amt));
    let fees = Fees::from(0i64);
    let payment_secret = None;
    let abortable = Abortable::new();

    // use account.send, because wallet.accounts_send(AccountsSendRequest{..}) is buggy
    let (summary, _) = a
        .send(
            dst,
            None,
            fees,
            match payload.len() {
                0 => None,
                _ => Some(payload),
            },
            secret.clone(),
            payment_secret,
            &abortable,
            None,
        )
        .await?;

    summary.final_transaction_id().ok_or_else(|| {
        KaspaError::Custom("Deposit transaction failed to generate a transaction ID".to_string())
    })
}
