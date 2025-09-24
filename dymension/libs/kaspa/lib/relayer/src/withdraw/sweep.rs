use crate::withdraw::messages::PopulatedInput;
use corelib::consts::RELAYER_SIG_OP_COUNT;
use corelib::escrow::EscrowPublic;
use corelib::util::input_sighash_type;
use corelib::wallet::EasyKaspaWallet;
use eyre::{eyre, Result};
use hardcode::tx::RELAYER_SWEEPING_PRIORITY_FEE;
use kaspa_consensus_client::{
    TransactionOutpoint as ClientTransactionOutpoint, UtxoEntry as ClientUtxoEntry,
};
use kaspa_consensus_core::constants::UNACCEPTED_DAA_SCORE;
use kaspa_consensus_core::tx::{TransactionInput, TransactionOutpoint, UtxoEntry};
use kaspa_wallet_core::account::pskb::{bundle_from_pskt_generator, PSKTGenerator};
use kaspa_wallet_core::prelude::{Fees, PaymentDestination};
use kaspa_wallet_core::tx::{Generator, GeneratorSettings, PaymentOutput};
use kaspa_wallet_core::utxo::UtxoEntryReference;
use kaspa_wallet_pskt::bundle::Bundle;
use kaspa_wallet_pskt::prelude::{Creator, OutputBuilder, Signer, PSKT};
use kaspa_wallet_pskt::pskt::InputBuilder;
use std::sync::Arc;

/// Create a bundle that sweeps funds in the escrow address.
/// The function expects a set of inputs that are needed to be swept – [`escrow_inputs`].
/// And a set of relayer inputs to cover the transaction fee – [`relayer_inputs`].
/// The escrow will get the total of the swept UTXO amount back as a single UTXO.
/// All the remaining funds are returned to the relayer as change.
/// Partial copy of https://github.com/kaspanet/rusty-kaspa/blob/1adeae8e5e2bdf7b65265420d294a356edc6d9e6/wallet/core/src/wasm/tx/generator/generator.rs#L186-L198
pub async fn create_sweeping_bundle(
    relayer_wallet: &EasyKaspaWallet,
    escrow: &EscrowPublic,
    escrow_inputs: Vec<PopulatedInput>,
    relayer_inputs: Vec<PopulatedInput>,
) -> Result<Bundle> {
    let sweep_balance = escrow_inputs.iter().map(|(_, e, _)| e.amount).sum::<u64>();

    let utxo_iterator = Box::new(
        escrow_inputs
            .into_iter()
            .chain(relayer_inputs.into_iter())
            .map(utxo_reference_from_populated_input),
    );

    let settings = GeneratorSettings::try_new_with_iterator(
        relayer_wallet.net.network_id,
        // Inputs include both escrow and relayer UTXOs
        utxo_iterator.into_iter(),
        // No priority UTXO entries
        None,
        // Return change to the relayer address
        relayer_wallet.wallet.account()?.change_address().unwrap(),
        escrow.n() as u8,
        escrow.m() as u16,
        // One payment output – escrow account which receives the entire sweeping amount
        PaymentDestination::from(PaymentOutput::new(escrow.addr.clone(), sweep_balance)),
        None,
        // Fees
        Fees::SenderPays(RELAYER_SWEEPING_PRIORITY_FEE),
        // Payload (not used for sweeping)
        None,
        // No multiplexer channel
        None,
    )
    .map_err(|e| eyre::eyre!("Create sweeping generator settings: {}", e))?;

    let generator = Generator::try_new(settings, None, None)
        .map_err(|e| eyre::eyre!("Create sweeping generator: {}", e))?;

    // PSKB signer is not used in PSKTGenerator, but we still provide it
    let signer = relayer_wallet
        .pskb_signer()
        .await
        .map_err(|e| eyre::eyre!("Create PSKB signer: {}", e))?;

    let pskt_gen = PSKTGenerator::new(
        generator,
        Arc::new(signer),
        relayer_wallet.net.address_prefix,
    );

    let sweeping_bundle = bundle_from_pskt_generator(pskt_gen)
        .await
        .map_err(|e| eyre::eyre!("Create sweeping bundle: {}", e))?;

    format_sweeping_bundle(sweeping_bundle, escrow)
}

/// Add the redeem script, sig op count, and sig hash type to every input.
/// Otherwise, the transaction will fail. Outputs stay the same.
fn format_sweeping_bundle(bundle: Bundle, escrow: &EscrowPublic) -> Result<Bundle> {
    let mut new_bundle = Bundle::new();
    for inner in bundle.iter() {
        let mut pskt = PSKT::<Creator>::default().constructor();

        for input in inner.inputs.iter() {
            let utxo_entry = input
                .utxo_entry
                .clone()
                .ok_or_else(|| eyre::eyre!("missing utxo_entry"))?;

            let mut b = InputBuilder::default();

            b.previous_outpoint(input.previous_outpoint)
                .sig_op_count(RELAYER_SIG_OP_COUNT)
                .sighash_type(input_sighash_type());

            // Add redeem script and correct sig op count for escrow inputs
            if utxo_entry.script_public_key == escrow.p2sh {
                b.redeem_script(escrow.redeem_script.clone())
                    .sig_op_count(escrow.n() as u8);
            }

            b.utxo_entry(utxo_entry);

            pskt = pskt.input(
                b.build()
                    .map_err(|e| eyre::eyre!("Build pskt input: {}", e))?,
            );
        }

        for output in inner.outputs.iter() {
            let b = OutputBuilder::default()
                .amount(output.amount)
                .script_public_key(output.script_public_key.clone())
                .build()
                .map_err(|e| eyre::eyre!("Build pskt output for withdrawal: {}", e))?;

            pskt = pskt.output(b);
        }

        new_bundle.add_pskt(pskt.no_more_inputs().no_more_outputs().signer());
    }
    Ok(new_bundle)
}

pub fn create_inputs_from_sweeping_bundle(
    sweeping_bundle: &Bundle,
    escrow: &EscrowPublic,
) -> Result<Vec<PopulatedInput>> {
    let last_pskt = sweeping_bundle
        .iter()
        .last()
        .cloned()
        .ok_or_else(|| eyre!("Empty sweeping bundle"))?;

    let sweep_tx = PSKT::<Signer>::from(last_pskt);
    let tx_id = sweep_tx.calculate_id();

    // Expect exactly two outputs: {escrow, relayer} in some order.
    let (relayer_idx, relayer_output, escrow_idx, escrow_output) = match sweep_tx.outputs.as_slice() {
        [o0, o1] if o0.script_public_key == escrow.p2sh => (1u32, o1, 0u32, o0),
        [o0, o1] if o1.script_public_key == escrow.p2sh => (0u32, o0, 1u32, o1),
        _ => {
            return Err(eyre!(
                "Resulting sweeping TX must have exactly two outputs: swept escrow UTXO and relayer change"
            ))
        }
    };

    let relayer_input: PopulatedInput = (
        TransactionInput::new(
            TransactionOutpoint::new(tx_id, relayer_idx),
            vec![], // signature_script is empty for unsigned transactions
            u64::MAX,
            RELAYER_SIG_OP_COUNT,
        ),
        UtxoEntry::new(
            relayer_output.amount,
            relayer_output.script_public_key.clone(),
            UNACCEPTED_DAA_SCORE,
            false,
        ),
        None, // relayer has no redeem script
    );

    let escrow_input: PopulatedInput = (
        TransactionInput::new(
            TransactionOutpoint::new(tx_id, escrow_idx),
            vec![], // signature_script is empty for unsigned transactions
            u64::MAX,
            escrow.n() as u8,
        ),
        UtxoEntry::new(
            escrow_output.amount,
            escrow.p2sh.clone(),
            UNACCEPTED_DAA_SCORE,
            false,
        ),
        Some(escrow.redeem_script.clone()), // escrow has redeem script
    );

    Ok(vec![relayer_input, escrow_input])
}

pub(crate) fn utxo_reference_from_populated_input(
    (input, entry, _redeem_script): PopulatedInput,
) -> UtxoEntryReference {
    UtxoEntryReference::from(ClientUtxoEntry {
        address: None,
        outpoint: ClientTransactionOutpoint::from(input.previous_outpoint),
        amount: entry.amount,
        script_public_key: entry.script_public_key.clone(),
        block_daa_score: entry.block_daa_score,
        is_coinbase: entry.is_coinbase,
    })
}
