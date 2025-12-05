use corelib::escrow::*;
use bridge::util::input_sighash_type;
use eyre::Result;
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::{TransactionOutpoint, UtxoEntry};
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_txscript::standard::pay_to_address_script;
use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::prelude::*;
use kaspa_wallet_core::utxo::UtxoIterator;
use kaspa_wallet_pskt::prelude::*;
use std::sync::Arc;

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
        .sighash_type(input_sighash_type())
        .build()
        .map_err(|e| Error::Custom(format!("pskt input e: {e}")))?;

    let input_r = InputBuilder::default()
        .utxo_entry(utxo_r_entry.clone())
        .previous_outpoint(utxo_r_out)
        .sig_op_count(1) // TODO: needed if using p2pk?
        .sighash_type(input_sighash_type())
        .build()
        .map_err(|e| Error::Custom(format!("pskt input r: {e}")))?;

    let output_e_to_user = OutputBuilder::default()
        .amount(amt)
        .script_public_key(pay_to_address_script(&user_address))
        .build()
        .map_err(|e| Error::Custom(format!("pskt output e_to_user: {e}")))?;

    let output_e_change = OutputBuilder::default()
        .amount(utxo_e_entry.amount - amt)
        .script_public_key(e.p2sh.clone())
        .build()
        .map_err(|e| Error::Custom(format!("pskt output e_change: {e}")))?;

    _ = output_e_change; // TODO: fix

    let output_r_change = OutputBuilder::default()
        .amount(utxo_r_entry.amount - fee)
        .script_public_key(pay_to_address_script(&a_relayer.change_address()?))
        .build()
        .map_err(|e| Error::Custom(format!("pskt output r_change: {e}")))?;

    let pskt = PSKT::<Creator>::default()
        .set_version(Version::One)
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
