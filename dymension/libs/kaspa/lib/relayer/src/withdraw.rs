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
use secp256k1::PublicKey;

use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::*;

use kaspa_txscript::{
    opcodes::codes::OpData65, script_builder::ScriptBuilder, standard::pay_to_address_script,
};

use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_rpc_core::model::RpcTransaction;

use corelib::payload;
use corelib::payload::{MessageID, MessageIDs};
use hyperlane_core::{HyperlaneMessage, HyperlaneSignerExt};
use kaspa_consensus_core::hashing::sighash::calc_schnorr_signature_hash;
use kaspa_wallet_core::account::pskb::PSKBSigner;
use std::iter;

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
        sign_pay_fee(pskt_unsigned.clone(), w_relayer, s_relayer).await?;
    let combiner = pskt_signed_relayer.combiner();
    let pskt_signed = (combiner + pskt_signed_vals).unwrap();

    info!("-> Relayer is finalizing");

    let rpc_tx = finalize_pskt(pskt_signed, vec![], e.pubs.clone())?;

    let tx_id = rpc.submit_transaction(rpc_tx, false).await?;

    Ok(tx_id)
}

pub fn finalize_pskt(
    c: PSKT<Combiner>,
    m: Vec<HyperlaneMessage>,
    escrow_pubs: Vec<PublicKey>,
) -> Result<RpcTransaction, Error> {
    let msg_ids_bytes = MessageIDs::from(m)
        .to_bytes()
        .map_err(|e| format!("Deserialize MessageIDs: {}", e))?;

    let finalized_pskt = c
        .finalizer()
        .finalize_sync(|inner: &Inner| -> Result<Vec<Vec<u8>>, String> {
            Ok(inner
                .inputs
                .iter()
                .enumerate()
                .map(|(i, input)| -> Vec<u8> {
                    match input.sig_op_count {
                        Some(n) => {
                            return if n == corelib::consts::RELAYER_SIG_OP_COUNT {
                                // relayer UTXO

                                let sig = input
                                    .partial_sigs
                                    .iter()
                                    .filter(|(pk, _sig)| !escrow_pubs.contains(pk))
                                    .next()
                                    .unwrap()
                                    .1
                                    .into_bytes();

                                iter::once(65u8)
                                    .chain(sig)
                                    .chain([input.sighash_type.to_u8()])
                                    .collect()
                            } else {
                                // escrow UTXO

                                // Return the full script

                                // ORIGINAL COMMENT: todo actually required count can be retrieved from redeem_script, sigs can be taken from partial sigs according to required count
                                // ORIGINAL COMMENT: considering xpubs sorted order

                                // For each escrow pubkey return <op code, sig, sighash type> and then concat these triples
                                let sigs: Vec<_> = escrow_pubs
                                    .iter()
                                    .flat_map(|kp| {
                                        let sig = input.partial_sigs.get(&kp).unwrap().into_bytes();
                                        iter::once(OpData65)
                                            .chain(sig)
                                            .chain([input.sighash_type.to_u8()])
                                    })
                                    .collect();

                                // Then add the multisig redeem script to the end
                                sigs.into_iter()
                                    .chain(
                                        ScriptBuilder::new()
                                            .add_data(
                                                input.redeem_script.as_ref().unwrap().as_slice(),
                                            )
                                            .unwrap()
                                            .drain()
                                            .iter()
                                            .cloned(),
                                    )
                                    .collect()
                            };
                        }
                        None => vec![], // Should not happen
                    }
                })
                .collect())
        })
        .unwrap();

    let mass = 10_000; // TODO: why? is it okay to keep this value?
    let (mut tx, _) = finalized_pskt.extractor().unwrap().extract_tx().unwrap()(mass);

    // Inject the expected payload
    tx.payload = msg_ids_bytes;

    let rpc_tx = (&tx).into();
    Ok(rpc_tx)
}

pub async fn sign_pay_fee(
    pskt_unsigned: PSKT<Signer>,
    w: &Arc<Wallet>,
    s: &Secret,
) -> Result<PSKT<Signer>, Error> {
    // TODO: interesting? https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/core/src/account/pskb.rs#L154

    // let addr = w.account()?.change_address()?;
    // let keydata = w.prv_key_data(s.clone());
    // let signer = Arc::new(PSKBSigner::new(w.account()?.clone().as_dyn_arc(), keydata.clone(), None));
    //
    // pskt_unsigned
    //         .pass_signature_sync(|tx, sighash| -> kaspa_wallet_core::result::Result<Vec<SignInputOk>, String> {
    //             tx.tx
    //                 .inputs
    //                 .iter()
    //                 .enumerate()
    //                 .map(|(idx, _input)| {
    //                     let hash = calc_schnorr_signature_hash(&tx.as_verifiable(), idx, sighash[idx], &reused_values);
    //                     let msg = secp256k1::Message::from_digest_slice(hash.as_bytes().as_slice()).unwrap();
    //
    //                     // When address represents a locked UTXO, no private key is available.
    //                     // Instead, use the account receive address' private key.
    //                     let address = &addr;
    //
    //                     let public_key = signer.public_key(address).expect("Public key for input indexed address");
    //
    //                     signer.sign().await?;
    //                     Ok(SignInputOk {
    //                         signature: Signature::Schnorr(signer.sign_schnorr(address, msg).unwrap()),
    //                         pub_key: public_key,
    //                         key_source: Some(KeySource { key_fingerprint, derivation_path: derivation_path.clone() }),
    //                     })
    //                 })
    //                 .collect()
    //         })
    //         .unwrap();

    let bundle = Bundle::from(pskt_unsigned);
    let addr = w.account()?.change_address()?;
    let sign_for_address = Some(&addr);
    let bundle_signed = w
        .account()?
        .pskb_sign(&bundle, s.clone(), None, sign_for_address)
        .await?;

    let pskt_done = bundle_signed.iter().next().unwrap();

    let combiner = PSKT::from(pskt_done.clone());
    Ok(combiner)
}
