// We call the signers 'validators'

use core::escrow::*;

use kaspa_core::info;
use kaspa_wallet_core::error::Error;

use kaspa_wallet_pskt::prelude::*;
use secp256k1::Keypair as SecpKeypair;

use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};

// Mimic a parallel multi-validator signing process
pub fn sign_escrow_spend(e: &Escrow, pskt_unsigned: PSKT<Signer>) -> Result<PSKT<Combiner>, Error> {
    let signed: Vec<PSKT<Signer>> = e
        .keys
        .iter()
        .enumerate()
        .map(|(i, keypair)| {
            info!("-> Signer {} is signing their copy...", i + 1);
            sign_pskt(keypair, pskt_unsigned.clone())
        })
        .collect::<Result<Vec<PSKT<Signer>>, Error>>()?;

    let mut combined = signed
        .first()
        .ok_or("No signatures provided to combine")?
        .clone()
        .combiner();

    for s in signed.iter().skip(1) {
        combined = (combined + s.clone()).unwrap();
    }

    Ok(combined)
}

// TODO: use wallet instead of raw keypair
pub fn sign_pskt(kp: &SecpKeypair, pskt: PSKT<Signer>) -> Result<PSKT<Signer>, Error> {
    let reused_values = SigHashReusedValuesUnsync::new();

    let msg_ids_bytes = core::payload::message_ids_payload_from_pskt(&pskt)
        .map_err(|e| format!("Deserialize MessageIDs: {}", e))?;

    pskt.pass_signature_sync(|tx, sighashes| {
        // Sign tx as if it had a payload
        let mut tx_payload = tx.clone();
        tx_payload.tx.payload = msg_ids_bytes;

        tx_payload
            .tx
            .inputs
            .iter()
            .enumerate()
            .map(|(idx, _input)| {
                let hash = calc_schnorr_signature_hash(
                    &tx_payload.as_verifiable(),
                    idx,
                    sighashes[idx], // TODO: don't forget need to verify it's what's expected
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
