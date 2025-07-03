use corelib::escrow::*;

use std::sync::Arc;

use kaspa_addresses::Address;
use kaspa_consensus_core::hashing::sighash_type::{
    SigHashType, SIG_HASH_ALL, SIG_HASH_ANY_ONE_CAN_PAY,
};
use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionOutpoint, UtxoEntry};
use kaspa_core::info;
use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::utxo::UtxoIterator;

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::*;

use kaspa_txscript::
    standard::pay_to_address_script
;
use super::hub_to_kaspa::finalize_pskt;

use kaspa_rpc_core::api::rpc::RpcApi;

use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};
use kaspa_wallet_core::derivation::build_derivate_paths;

// used by multisig demo
pub async fn build_withdrawal_tx<T: RpcApi + ?Sized>(
    rpc: &T,
    e: &EscrowPublic,
    user_address: Address,
    a_relayer: &Arc<dyn Account>,
    fee: u64,
    amt: u64,
) -> Result<PSKT<Signer>, Error> {
    let utxos_e = rpc.get_utxos_by_addresses(vec![e.addr.clone()]).await?;
    let utxo_e_first = utxos_e
        .into_iter()
        .next()
        .ok_or("No UTXO found at escrow address")?;
    let utxo_e_entry = UtxoEntry::from(utxo_e_first.utxo_entry);
    let utxo_e_out = TransactionOutpoint::from(utxo_e_first.outpoint);

    let utxo_r = UtxoIterator::new(a_relayer.utxo_context())
        .next()
        .ok_or("Relayer has no UTXOs")?;
    let utxo_r_entry: UtxoEntry = (utxo_r.utxo.as_ref()).into();
    let utxo_r_out = TransactionOutpoint::from(utxo_r.outpoint());

    let input_e = InputBuilder::default()
        .utxo_entry(utxo_e_entry.clone())
        .previous_outpoint(utxo_e_out)
        .redeem_script(e.redeem_script.clone())
        .sig_op_count(e.n() as u8) // Total possible signers
        .sighash_type(
            SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()).unwrap(),
        )
        .build()
        .map_err(|e| Error::Custom(format!("pskt input e: {}", e)))?;

    let input_r = InputBuilder::default()
        .utxo_entry(utxo_r_entry.clone())
        .previous_outpoint(utxo_r_out)
        .sig_op_count(1) // TODO: needed if using p2pk?
        .sighash_type(
            SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()).unwrap(),
        )
        .build()
        .map_err(|e| Error::Custom(format!("pskt input r: {}", e)))?;

    let output_e_to_user = OutputBuilder::default()
        .amount(amt)
        .script_public_key(ScriptPublicKey::from(pay_to_address_script(&user_address)))
        .build()
        .map_err(|e| Error::Custom(format!("pskt output e_to_user: {}", e)))?;

    let output_e_change = OutputBuilder::default()
        .amount(utxo_e_entry.amount - amt)
        .script_public_key(e.p2sh.clone())
        .build()
        .map_err(|e| Error::Custom(format!("pskt output e_change: {}", e)))?;

    _ = output_e_change; // TODO: fix

    let output_r_change = OutputBuilder::default()
        .amount(utxo_r_entry.amount - fee)
        .script_public_key(ScriptPublicKey::from(pay_to_address_script(
            &a_relayer.change_address()?,
        )))
        .build()
        .map_err(|e| Error::Custom(format!("pskt output r_change: {}", e)))?;

    let pskt = PSKT::<Creator>::default()
        .constructor()
        .input(input_e)
        .input(input_r)
        .output(output_e_to_user)
        // .output(output_e_change)
        .output(output_r_change)
        .no_more_inputs()
        .no_more_outputs()
        .signer();

    Ok(pskt)
}

// used by multisig demo
pub async fn send_tx<T: RpcApi + ?Sized>(
    rpc: &T,
    pskt_signed_vals: PSKT<Combiner>,
    pskt_unsigned: PSKT<Signer>,
    e: &EscrowPublic,
    w_relayer: &Arc<Wallet>,
    s_relayer: &Secret,
) -> Result<TransactionId, Error> {
    info!("-> Relayer   is signing their copy...");

    let pskt_signed_relayer: PSKT<Signer> =
        sign_pay_fee(pskt_unsigned.clone(), w_relayer, s_relayer, vec![]).await?;
    let combiner = pskt_signed_relayer.combiner();
    let pskt_signed = (combiner + pskt_signed_vals).unwrap();

    info!("-> Relayer is finalizing");

    let rpc_tx = finalize_pskt(pskt_signed, vec![], e.pubs.clone())?;

    let tx_id = rpc.submit_transaction(rpc_tx, false).await?;

    Ok(tx_id)
}

// used by demo only
pub async fn sign_pay_fee(
    pskt: PSKT<Signer>,
    w: &Arc<Wallet>,
    s: &Secret,
    payload: Vec<u8>,
) -> Result<PSKT<Signer>, Error> {
    // The code above combines `Account.pskb_sign` and `pskb_signer_for_address` functions.
    // It's a hack allowing to sign PSKT with a custom payload.
    // https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/core/src/account/pskb.rs#L154
    // https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/core/src/account/mod.rs#L383

    // Get the active account from the wallet and its address
    let acc = w.account()?;

    // Get private and public keys for the active account
    let keydata = acc.prv_key_data(s.clone()).await?;
    let xprv = keydata.get_xprv(Some(s))?;
    let key_fingerprint = xprv.public_key().fingerprint();

    // Create keypair from the private key
    let kp = secp256k1::Keypair::from_secret_key(secp256k1::SECP256K1, xprv.private_key());
    let pk = kp.public_key();

    // Get derivation path for the account. build_derivate_paths returns receive and change paths, respectively.
    // Use receive one as it is used in `Account.pskb_sign`.
    let derivation = acc.as_derivation_capable()?;
    let (derivation_path, _) = build_derivate_paths(
        &derivation.account_kind(),
        derivation.account_index(),
        derivation.cosigner_index(),
    )?;

    // reused_values is something copied from the `pskb_signer_for_address` funciton
    let reused_values = SigHashReusedValuesUnsync::new();

    pskt.pass_signature_sync(|tx, sighash| {
        // Sign tx as if it had a payload
        let mut tx_payload = tx.clone();
        tx_payload.tx.payload = payload;
        let tx_verifiable = tx_payload.as_verifiable();

        tx_payload
            .tx
            .inputs
            .iter()
            .enumerate()
            .map(|(idx, _input)| {
                let hash =
                    calc_schnorr_signature_hash(&tx_verifiable, idx, sighash[idx], &reused_values);
                let msg = secp256k1::Message::from_digest_slice(&hash.as_bytes())
                    .map_err(|e| e.to_string())?;
                Ok(SignInputOk {
                    signature: Signature::Schnorr(kp.sign_schnorr(msg)),
                    pub_key: pk,
                    key_source: Some(KeySource {
                        key_fingerprint,
                        derivation_path: derivation_path.clone(),
                    }),
                })
            })
            .collect()
    })
}
