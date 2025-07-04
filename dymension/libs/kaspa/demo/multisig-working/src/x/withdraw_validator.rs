// We call the signers 'validators'

use super::escrow::*;

use std::sync::Arc;

use kaspa_addresses::Address;
use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionOutpoint, UtxoEntry};
use kaspa_core::info;
use kaspa_wallet_core::error::Error;

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_keys::prelude::*;
use kaspa_wallet_pskt::prelude::*;
use secp256k1::{Keypair as SecpKeypair, Secp256k1};

use kaspa_txscript::{
    opcodes::codes::OpData65, pay_to_address_script, script_builder::ScriptBuilder,
};

use kaspa_rpc_core::api::rpc::RpcApi;

use kaspa_consensus_core::hashing::sighash::{
    SigHashReusedValuesUnsync, calc_schnorr_signature_hash,
};

use std::iter;

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

fn sign_pskt(kp: &SecpKeypair, pskt: PSKT<Signer>) -> Result<PSKT<Signer>, Error> {
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
