use std::sync::Arc;

use kaspa_wallet_core::prelude::*;

use kaspa_rpc_core::api::rpc::RpcApi;

use kaspa_core::info;

use kaspa_addresses::Address;
use kaspa_wallet_core::error::Error;

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::*;
use secp256k1::Keypair as SecpKeypair;

use kaspa_consensus_core::hashing::sighash::{
    SigHashReusedValuesUnsync, calc_schnorr_signature_hash,
};

pub async fn check_balance<T: RpcApi + ?Sized>(
    source: &str,
    rpc: &T,
    addr: &Address,
) -> Result<u64, Error> {
    let balance = rpc
        .get_balance_by_address(addr.clone())
        .await
        .map_err(|e| Error::Custom(format!("Getting balance for escrow address: {}", e)))?;

    info!("{} balance: {}", source, balance);
    Ok(balance)
}

// TODO: needed?
pub async fn check_balance_wallet(w: Arc<Wallet>) -> Result<(), Error> {
    let a = w.account()?;
    for _ in 0..10 {
        if a.balance().is_some() {
            break;
        }
        workflow_core::task::sleep(std::time::Duration::from_millis(200)).await;
    }

    if let Some(b) = a.balance() {
        info!("Wallet account balance:");
        info!("  Mature:   {} KAS", sompi_to_kaspa_string(b.mature));
        info!("  Pending:  {} KAS", sompi_to_kaspa_string(b.pending));
        info!("  Outgoing: {} KAS", sompi_to_kaspa_string(b.outgoing));
    } else {
        info!("Wallet account has no balance or is still syncing.");
    }

    Ok(())
}

pub fn sign_pskt(kp: &SecpKeypair, pskt: PSKT<Signer>) -> Result<PSKT<Signer>, Error> {
    let reused_values = SigHashReusedValuesUnsync::new();

    pskt.pass_signature_sync(|tx, sighashes| {
        // let tx = dbg!(tx);
        tx.tx
            .inputs
            .iter()
            .enumerate()
            .map(|(idx, _input)| {
                let hash = calc_schnorr_signature_hash(
                    &tx.as_verifiable(),
                    idx,
                    sighashes[idx],
                    &reused_values,
                );
                let msg = secp256k1::Message::from_digest_slice(&hash.as_bytes())
                    .map_err(|e| e.to_string())?;
                Ok(SignInputOk {
                    signature: Signature::Schnorr(kp.sign_schnorr(msg)),
                    pub_key: kp.public_key(),
                    key_source: None,
                })
            })
            .collect()
    })
}
