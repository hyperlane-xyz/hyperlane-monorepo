use eyre::Result;

use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};

use super::consts::KEY_MESSAGE_IDS;
use super::escrow::EscrowPublic;
use super::payload::{MessageID, MessageIDs};
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::prelude::{Signer, PSKT};

use super::wallet::EasyKaspaWallet;
use super::withdraw::WithdrawFXG;
use eyre::eyre;

pub fn sign_pskt(
    pskt: PSKT<Signer>,
    key_pair: &secp256k1::Keypair,
    source: Option<KeySource>,
) -> Result<PSKT<Signer>> {
    // reused_values is something copied from the `pskb_signer_for_address` funciton
    let reused_values = SigHashReusedValuesUnsync::new();
    pskt.pass_signature_sync(|tx, sighash| {
        tx.tx
            .inputs
            .iter()
            .enumerate()
            .map(|(idx, _input)| {
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
