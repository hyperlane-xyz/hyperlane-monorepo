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

use kaspa_txscript::{
    opcodes::codes::OpData65, script_builder::ScriptBuilder, standard::pay_to_address_script,
};

use kaspa_rpc_core::api::rpc::RpcApi;

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

    let pskt_signed_relayer = sign_pay_fee(pskt_unsigned.clone(), w_relayer, s_relayer).await?;
    let pskt_signed = (pskt_signed_relayer + pskt_signed_vals).unwrap();

    info!("-> Relayer is finalizing");

    let finalized_pskt = pskt_signed
        .finalizer()
        .finalize_sync(|inner: &Inner| -> Result<Vec<Vec<u8>>, String> {
            Ok(inner
                .inputs
                .iter()
                .enumerate()
                .map(|(i, input)| -> Vec<u8> {
                    if i < 1 {
                        // Return the full script

                        // ORIGINAL COMMENT: todo actually required count can be retrieved from redeem_script, sigs can be taken from partial sigs according to required count
                        // ORIGINAL COMMENT: considering xpubs sorted order

                        // For each escrow pubkey return <op code, sig, sighash type> and then concat these triples
                        let sigs: Vec<_> = e
                            .pubs
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
                                    .add_data(input.redeem_script.as_ref().unwrap().as_slice())
                                    .unwrap()
                                    .drain()
                                    .iter()
                                    .cloned(),
                            )
                            .collect()
                    } else {
                        let sig = input
                            .partial_sigs
                            .iter()
                            .filter(|(pk, _sig)| !e.pubs.contains(pk))
                            .next()
                            .unwrap()
                            .1
                            .into_bytes();

                        return std::iter::once(65u8)
                            .chain(sig)
                            .chain([input.sighash_type.to_u8()])
                            .collect();
                    }
                })
                .collect())
        })
        .unwrap();

    let mass = 10_000; // TODO: why?
    let (tx, _) = finalized_pskt.extractor().unwrap().extract_tx().unwrap()(mass);

    let rpc_tx = (&tx).into();
    let tx_id = rpc.submit_transaction(rpc_tx, false).await?;

    Ok(tx_id)
}

pub async fn sign_pay_fee(
    pskt_unsigned: PSKT<Signer>,
    w: &Arc<Wallet>,
    s: &Secret,
) -> Result<PSKT<Combiner>, Error> {
    // TODO: interesting? https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/core/src/account/pskb.rs#L154

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
