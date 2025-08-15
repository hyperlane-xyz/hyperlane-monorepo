use eyre::Result;
use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};
use kaspa_wallet_pskt::prelude::*;
use std::str::FromStr;

pub fn sign_pskt(
    pskt: PSKT<Signer>,
    key_pair: &secp256k1::Keypair,
    source: Option<KeySource>,
    input_filter: Option<impl Fn(&Input) -> bool>,
) -> Result<PSKT<Signer>> {
    // reused_values is something copied from the `pskb_signer_for_address` funciton
    let reused_values = SigHashReusedValuesUnsync::new();

    let ok: Vec<bool> = pskt
        .inputs
        .iter()
        .map(|input| input_filter.as_ref().is_none_or(|filter| filter(input)))
        .collect();

    pskt.pass_signature_sync(|tx, sighash| {
        tx.tx
            .inputs
            .iter()
            .enumerate()
            .map(|(idx, _input)| {
                if !ok[idx] {
                    return Ok(SignInputOk {
                        signature: Signature::Schnorr(
                            secp256k1::schnorr::Signature::from_slice(&[0; 64]).unwrap(),
                        ),
                        pub_key: secp256k1::PublicKey::from_str(
                            "02eea60b50f48beafdfd737fecf50be79cb2a415f4dc0210931ad8ffcb933e3370",
                        )
                        .unwrap(),
                        key_source: None,
                    });
                }
                let hash = calc_schnorr_signature_hash(
                    &tx.as_verifiable(),
                    idx,
                    sighash[idx],
                    &reused_values,
                );
                let msg = secp256k1::Message::from_digest_slice(&hash.as_bytes())
                    .map_err(|e| eyre::eyre!("Failed to convert hash to message: {}", e))?;
                Ok(SignInputOk {
                    signature: Signature::Schnorr(key_pair.sign_schnorr(msg)),
                    pub_key: key_pair.public_key(),
                    key_source: source.clone(),
                })
            })
            .collect()
    })
}
