// We call the signers 'validators'

use corelib::escrow::*;

use kaspa_core::info;
use kaspa_wallet_core::error::Error;

use kaspa_wallet_pskt::prelude::*;
use secp256k1::Keypair as SecpKeypair;

use corelib::payload::MessageIDs;
use corelib::withdraw::WithdrawFXG;
use eyre::Result;
use hyperlane_core::HyperlaneMessage;
use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};

pub async fn validate_withdrawals(fxg: &WithdrawFXG) -> Result<bool> {
    Ok(true)
}

pub fn sign_withdrawal_fxg(fxg: &WithdrawFXG, keypair: &SecpKeypair) -> Result<Bundle> {
    let mut signed = Vec::new();
    // Iterate over (PSKT; associated HL messages) pairs
    for (pskt, hl_messages) in fxg.bundle.iter().zip(fxg.messages.clone().into_iter()) {
        let pskt = PSKT::<Signer>::from(pskt.clone());

        let signed_pskt = corelib::pskt::sign_pskt(pskt, keypair, None)?;

        signed.push(signed_pskt);
    }
    info!("Validator: signed pskts");
    let bundle = Bundle::from(signed);
    Ok(bundle)
}
