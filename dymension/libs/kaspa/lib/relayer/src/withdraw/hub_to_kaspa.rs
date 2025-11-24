use super::messages::PopulatedInput;
use super::minimum::{is_dust, is_small_value};
use super::populated_input::PopulatedInputBuilder;
use crate::withdraw::sweep::utxo_reference_from_populated_input;
use corelib::escrow::EscrowPublic;
use corelib::finality;
use corelib::message::parse_hyperlane_metadata;
use corelib::util::{get_recipient_script_pubkey, input_sighash_type};
use corelib::wallet::EasyKaspaWallet;
use corelib::wallet::SigningResources;
use corelib::withdraw::WithdrawFXG;
use eyre::eyre;
use eyre::Result;
use hyperlane_core::HyperlaneMessage;
use hyperlane_core::U256;
use kaspa_addresses::Prefix;
use kaspa_consensus_core::config::params::Params;
use kaspa_consensus_core::constants::TX_VERSION;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::UtxoEntry;
use kaspa_consensus_core::tx::{Transaction, TransactionOutpoint, TransactionOutput};
use kaspa_rpc_core::{RpcTransaction, RpcUtxosByAddressesEntry};
use kaspa_txscript::standard::pay_to_address_script;
use kaspa_txscript::{opcodes::codes::OpData65, script_builder::ScriptBuilder};
use kaspa_wallet_core::prelude::DynRpcApi;
use kaspa_wallet_core::tx::MassCalculator;
use kaspa_wallet_pskt::prelude::Bundle;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::prelude::{Signer, PSKT};
use std::sync::Arc;
use tracing::info;

/// Fetches UTXOs and combines a list of all populated inputs
pub async fn fetch_input_utxos(
    kaspa_rpc: &Arc<DynRpcApi>,
    address: &kaspa_addresses::Address,
    redeem_script: Option<Vec<u8>>,
    sig_op_count: u8,
    network_id: NetworkId,
) -> Result<Vec<PopulatedInput>> {
    let utxos = get_utxo_to_spend(&address, kaspa_rpc, network_id).await?;

    // Create a vector of "populated" inputs: TransactionInput, UtxoEntry, and optional redeem_script.
    Ok(utxos
        .into_iter()
        .map(|utxo| {
            let outpoint = kaspa_consensus_core::tx::TransactionOutpoint::from(utxo.outpoint);
            let entry = UtxoEntry::from(utxo.utxo_entry);

            PopulatedInputBuilder::new(
                outpoint.transaction_id,
                outpoint.index,
                entry.amount,
                entry.script_public_key,
            )
            .sig_op_count(sig_op_count)
            .block_daa_score(entry.block_daa_score)
            .redeem_script(redeem_script.clone())
            .build()
        })
        .collect())
}

pub async fn get_normal_bucket_feerate(kaspa_rpc: &Arc<DynRpcApi>) -> Result<f64> {
    let feerate = kaspa_rpc.get_fee_estimate().await?;
    // Due to the documentation:
    // > The first value of this vector is guaranteed to exist
    Ok(feerate.normal_buckets.first().unwrap().feerate)
}

/// Builds a single withdrawal PSKT.
///
/// Example:
///
/// The user sends 10 KAS. Multisig addr has 100 KAS. Due to the Hyperlane approach, the user
/// needs to get the whole amount they transferred, so they must get 10 KAS. However, there is
/// the transaction fee, which must be covered by the relayer. Let's say it's 1 KAS.
///
/// For that, we fetch ALL UTXOs from the multisig address and them as inputs. This will also
/// work as automatic sweeping. The change is returned as an output which is also used as
/// a new anchor.
///
/// The relayer fee is tricky. Relayer should provide some UTXOs to cover the fee. However,
/// each input increases the transaction fee, so we can't compute the concrete fee beforehand.
///
/// We have two options:
///
/// --- 1 ---
/// 1. Calculate the tx fee without relayer's UTXOs.
/// 2. Get the UTXOs that cover the fee.
/// 3. Add them as inputs.
/// 4. Calculate the fee again.
/// 5. Add additional UTXOs if needed and repeat 2-4.
///
/// Pros: As low fee as possible.
/// Cons: The relayer account is fragmented (sweeping is needed); complex flow.
///
/// --- 2 --- (Implemented)
/// Get ALL UTXOs and also use them as inputs. The change is returned as output.
///
/// Pros: Simple to handle.
/// Cons: Potentially bigger fee because of the increased number of inputs. However, it's in
/// relayer's interest to pay min fees and thus keep its account with as few UTXOs as possible.
///
/// CONTRACT:
/// Escrow change is always the last output.
pub fn build_withdrawal_pskt(
    inputs: Vec<PopulatedInput>,
    mut outputs: Vec<TransactionOutput>,
    payload: Vec<u8>,
    escrow: &EscrowPublic,
    relayer_addr: &kaspa_addresses::Address,
    min_deposit_sompi: U256,
    feerate: f64,
    tx_mass: u64,
) -> Result<PSKT<Signer>> {
    //////////////////
    //   Balances   //
    //////////////////

    // TODO: Confirm if we can have an overflow here
    // 1 KAS = 10^8 (dust denom).
    // 10^19 < 2^26 < 10^20
    // This means the multisig must hold at most 10^19 (dust denom) => 10^11 KAS
    // Given that 1 KAS = $10^-2, the max balance is $1B, but this might change
    // in case of hyperinflation

    let (escrow_balance, relayer_balance) =
        inputs
            .iter()
            .fold((0, 0), |mut acc, (_input, entry, redeem_script)| {
                if redeem_script.is_none() {
                    // relayer has no redeem script
                    acc.1 += entry.amount;
                } else {
                    // escrow has redeem script
                    acc.0 += entry.amount;
                }
                acc
            });

    let withdrawal_balance: u64 = outputs.iter().map(|w| w.value).sum();

    if escrow_balance < withdrawal_balance {
        return Err(eyre::eyre!(
            "Insufficient funds in escrow: {} < {}",
            escrow_balance,
            withdrawal_balance
        ));
    }

    if is_small_value(escrow_balance, min_deposit_sompi) {
        return Err(eyre::eyre!(
            "Escrow balance is low: balance: {}, recommended: {}. Please deposit to escrow address to avoid high mass txs.",
            escrow_balance,
            min_deposit_sompi
        ));
    }
    //////////////////
    //     Fee      //
    //////////////////

    // Apply TX mass multiplier and feerate
    let tx_fee = (tx_mass as f64 * feerate).round() as u64;

    if relayer_balance < tx_fee {
        return Err(eyre::eyre!(
            "Insufficient relayer funds to cover tx fee: {} < {}",
            relayer_balance,
            tx_fee
        ));
    }

    if is_small_value(relayer_balance, min_deposit_sompi) {
        return Err(eyre::eyre!(
            "Relayer balance is low: balance: {}, recommended: {}. Please deposit to relayer address to avoid high mass txs.",
            relayer_balance,
            min_deposit_sompi
        ));
    }

    ////////////////
    //   Change   //
    ////////////////

    let relayer_change_amt = relayer_balance - tx_fee;
    // check if relayer_change is dust
    let relayer_change = TransactionOutput {
        value: relayer_change_amt,
        script_public_key: pay_to_address_script(relayer_addr),
    };
    if is_dust(&relayer_change, min_deposit_sompi) {
        return Err(eyre::eyre!(
            "Insufficient relayer funds to cover tx fee: {} < {}, only leaves dust {}",
            relayer_balance,
            tx_fee,
            relayer_change_amt
        ));
    }

    // escrow_balance - withdrawal_balance > 0 as checked above
    let escrow_change_amt = escrow_balance - withdrawal_balance;
    // check if relayer_change is dust
    let escrow_change = TransactionOutput {
        value: escrow_change_amt,
        script_public_key: escrow.p2sh.clone(),
    };
    if is_dust(&escrow_change, min_deposit_sompi) {
        return Err(eyre::eyre!(
            "Insufficient escrow funds to cover withdrawals and avoid dust change: {} < {}, only leaves dust {}, should never happen due to seed",
            escrow_balance,
            withdrawal_balance,
            escrow_change_amt
        ));
    }

    // Escrow change (new anchor) is always the last element
    outputs.extend(vec![relayer_change, escrow_change]);

    let inputs_num = inputs.len();
    let outputs_num = outputs.len();
    let payload_len = payload.len();

    let pskt = create_withdrawal_pskt(inputs, outputs, payload)?;

    info!(
        inputs_count = inputs_num,
        outputs_count = outputs_num,
        payload_len = payload_len,
        tx_mass = tx_mass,
        feerate = feerate,
        tx_fee = tx_fee,
        "kaspa relayer: prepared withdrawal transaction"
    );

    Ok(pskt)
}

/// CONTRACT:
/// Escrow change is always the last output.
fn create_withdrawal_pskt(
    inputs: Vec<PopulatedInput>,
    outputs: Vec<TransactionOutput>,
    payload: Vec<u8>,
) -> Result<PSKT<Signer>> {
    let mut pskt = PSKT::<Creator>::default()
        .set_version(Version::One)
        .constructor();

    // Add inputs
    for (input, entry, redeem_script) in inputs.into_iter() {
        let mut b = InputBuilder::default();

        b.utxo_entry(entry)
            .previous_outpoint(input.previous_outpoint)
            .sig_op_count(input.sig_op_count)
            .sighash_type(input_sighash_type());

        if let Some(script) = redeem_script {
            // escrow inputs need redeem_script
            b.redeem_script(script);
        }

        pskt = pskt.input(
            b.build()
                .map_err(|e| eyre::eyre!("Build pskt input: {}", e))?,
        );
    }

    // Add outputs
    for output in outputs.into_iter() {
        let b = OutputBuilder::default()
            .amount(output.value)
            .script_public_key(output.script_public_key)
            .build()
            .map_err(|e| eyre::eyre!("Build pskt output for withdrawal: {}", e))?;

        pskt = pskt.output(b);
    }

    Ok(pskt
        .no_more_inputs()
        .no_more_outputs()
        .payload(Some(payload))?
        .signer())
}

/// Return outputs generated based on the provided messages. Filter out messages
/// with dust amount.
pub fn get_outputs_from_msgs(
    messages: Vec<HyperlaneMessage>,
    prefix: Prefix,
    min_withdrawal_sompi: U256,
) -> (Vec<HyperlaneMessage>, Vec<TransactionOutput>) {
    let mut hl_msgs: Vec<HyperlaneMessage> = Vec::new();
    let mut outputs: Vec<TransactionOutput> = Vec::new();
    for m in messages {
        let tm = match parse_hyperlane_metadata(&m) {
            Ok(tm) => tm,
            Err(e) => {
                info!(
                    error = %e,
                    "kaspa relayer: skipped message, failed to parse TokenMessage from HyperlaneMessage body"
                );
                continue;
            }
        };

        let recipient = get_recipient_script_pubkey(tm.recipient(), prefix);

        let o = TransactionOutput::new(tm.amount().as_u64(), recipient);

        if is_dust(&o, min_withdrawal_sompi) {
            info!(
                amount = o.value,
                message_id = ?m.id(),
                "kaspa relayer: skipped withdrawal, amount below minimum withdrawal threshold"
            );
            continue;
        }

        outputs.push(o);
        hl_msgs.push(m);
    }
    (hl_msgs, outputs)
}

async fn get_utxo_to_spend(
    addr: &kaspa_addresses::Address,
    kaspa_rpc: &Arc<DynRpcApi>,
    network_id: NetworkId,
) -> Result<Vec<RpcUtxosByAddressesEntry>> {
    let mut utxos = kaspa_rpc
        .get_utxos_by_addresses(vec![addr.clone()])
        .await
        .map_err(|e| eyre::eyre!("Get escrow UTXOs: {}", e))?;

    let b = kaspa_rpc
        .get_block_dag_info()
        .await
        .map_err(|e| eyre::eyre!("Get block DAG info: {}", e))?;

    // Descending order – older UTXOs first
    utxos.sort_by_key(|u| std::cmp::Reverse(u.utxo_entry.block_daa_score));
    utxos.retain(|u| {
        finality::is_mature(
            u.utxo_entry.block_daa_score,
            b.virtual_daa_score,
            network_id,
        )
    });

    Ok(utxos)
}

pub(crate) fn extract_current_anchor(
    current_anchor: TransactionOutpoint,
    mut escrow_inputs: Vec<PopulatedInput>,
) -> Result<(PopulatedInput, Vec<PopulatedInput>)> {
    let anchor_index = escrow_inputs
        .iter()
        .position(|(input, _, _)| input.previous_outpoint == current_anchor)
        .ok_or(eyre::eyre!(
            "Current anchor not found in escrow UTXO set: {current_anchor:?}"
        ))?; // Should always be found

    let anchor_input = escrow_inputs.swap_remove(anchor_index);

    Ok((anchor_input, escrow_inputs))
}

pub fn estimate_mass(
    populated_inputs: Vec<PopulatedInput>,
    outputs: Vec<TransactionOutput>,
    payload: Vec<u8>,
    network_id: NetworkId,
    min_signatures: u16,
) -> Result<u64> {
    let (inputs, utxo_references): (Vec<_>, Vec<_>) = populated_inputs
        .into_iter()
        .map(|populated| {
            let input = populated.0.clone();
            let utxo_ref = utxo_reference_from_populated_input(populated);
            (input, utxo_ref)
        })
        .unzip();

    let tx = Transaction::new(
        TX_VERSION,
        inputs,
        outputs,
        0, // no tx lock time
        SUBNETWORK_ID_NATIVE,
        0,
        payload,
    );

    let p = Params::from(network_id);
    let m = MassCalculator::new(&p);

    m.calc_overall_mass_for_unsigned_consensus_transaction(
        &tx,
        utxo_references.as_slice(),
        min_signatures,
    )
    .map_err(|e| eyre::eyre!(e))
}

pub async fn combine_bundles_with_fee(
    bundles_validators: Vec<Bundle>,
    fxg: &WithdrawFXG,
    multisig_threshold: usize,
    escrow: &EscrowPublic,
    easy_wallet: &EasyKaspaWallet,
) -> Result<Vec<RpcTransaction>> {
    info!("kaspa relayer: received withdrawal FXG, gathering validator signatures");

    let mut bundles_validators = bundles_validators;

    let all_bundles = {
        if bundles_validators.len() < multisig_threshold {
            return Err(eyre!(
                "Not enough validator bundles, required: {}, got: {}",
                multisig_threshold,
                bundles_validators.len()
            ));
        }

        let bundle_relayer = sign_relayer_fee(easy_wallet, fxg).await?; // TODO: can add own sig in parallel to validator network request
        info!("kaspa relayer: signed relayer fee bundle");
        bundles_validators.push(bundle_relayer);
        bundles_validators
    };
    let txs_signed = combine_all_bundles(all_bundles)?;
    let finalized = finalize_txs(
        txs_signed,
        fxg.messages.clone(),
        escrow,
        easy_wallet.pub_key().await?,
        easy_wallet.net.network_id,
    )?;
    Ok(finalized)
}

async fn sign_relayer_fee(easy_wallet: &EasyKaspaWallet, fxg: &WithdrawFXG) -> Result<Bundle> {
    let resources = easy_wallet.signing_resources().await?;

    let mut signed = Vec::new();
    // Iterate over (PSKT; associated HL messages) pairs
    for pskt in fxg.bundle.iter() {
        let pskt = PSKT::<Signer>::from(pskt.clone());

        signed.push(sign_pay_fee(pskt, &resources).await?);
    }
    Ok(Bundle::from(signed))
}

/// accepts bundle of signer
fn combine_all_bundles(bundles: Vec<Bundle>) -> Result<Vec<PSKT<Combiner>>> {
    // each bundle is from a different actor (validator or relayer), and is a vector of pskt
    // therefore index i of each vector corresponds to the same TX i

    // make a list of lists, each top level element is a vector of pskt from a different actor
    let actor_pskts = bundles
        .iter()
        .map(|b| {
            b.iter()
                .map(|inner| PSKT::<Signer>::from(inner.clone()))
                .collect::<Vec<PSKT<Signer>>>()
        })
        .collect::<Vec<Vec<PSKT<Signer>>>>();

    let n_txs = actor_pskts.first().unwrap().len();

    // need to walk across each tx, and for each tx walk across each actor, and combine all for that tx, so all the sigs
    // for each tx are grouped together in one vector
    let mut tx_sigs: Vec<Vec<PSKT<Signer>>> = Vec::new();
    for tx_i in 0..n_txs {
        let mut all_sigs_for_tx = Vec::new();
        for tx_sigs_from_actor_j in actor_pskts.iter() {
            all_sigs_for_tx.push(tx_sigs_from_actor_j[tx_i].clone());
        }
        tx_sigs.push(all_sigs_for_tx);
    }

    // walk across each tx and combine all the sigs for that tx into one combiner
    let mut ret = Vec::new();
    for (pskt_idx, all_actor_sigs_for_tx) in tx_sigs.iter().enumerate() {
        let pskt = all_actor_sigs_for_tx.first().unwrap().clone();
        let tx_id = pskt.calculate_id();
        let mut combiner = pskt.combiner();

        for (_sig_idx, tx_sig) in all_actor_sigs_for_tx.iter().skip(1).enumerate() {
            combiner = (combiner + tx_sig.clone())?;
        }

        info!(
            pskt_idx = pskt_idx,
            tx_id = %tx_id,
            signatures_combined = all_actor_sigs_for_tx.len(),
            "kaspa relayer: combined PSKT signatures"
        );

        ret.push(combiner);
    }
    Ok(ret)
}

fn finalize_txs(
    txs_sigs: Vec<PSKT<Combiner>>,
    messages: Vec<Vec<HyperlaneMessage>>,
    escrow: &EscrowPublic,
    relayer_pub_key: secp256k1::PublicKey,
    network_id: NetworkId,
) -> Result<Vec<RpcTransaction>> {
    let transactions_result: Result<Vec<RpcTransaction>, _> = txs_sigs
        .into_iter()
        .zip(messages)
        .map(|(tx, _)| finalize_pskt(tx, escrow, &relayer_pub_key, network_id))
        .collect();

    let transactions: Vec<RpcTransaction> = transactions_result?;

    Ok(transactions)
}

// used by multisig demo AND real code
pub fn finalize_pskt(
    c: PSKT<Combiner>,
    escrow: &EscrowPublic,
    relayer_pub_key: &secp256k1::PublicKey,
    network_id: NetworkId,
) -> Result<RpcTransaction> {
    let finalized_pskt = c
        .finalizer()
        .finalize_sync(|inner: &Inner| -> Result<Vec<Vec<u8>>, String> {
            Ok(inner
                .inputs
                .iter()
                .map(|input| -> Vec<u8> {
                    match &input.redeem_script {
                        None => {
                            // relayer UTXO

                            let sig = input
                                .partial_sigs
                                .iter()
                                .find(|(pk, _sig)| pk == &relayer_pub_key)
                                .unwrap()
                                .1
                                .into_bytes();

                            std::iter::once(65u8)
                                .chain(sig)
                                .chain([input.sighash_type.to_u8()])
                                .collect()
                        }
                        Some(redeem_script) => {
                            if redeem_script != &escrow.redeem_script {
                                panic!("Redeem script mismatch");
                            }
                            // escrow UTXO

                            // Return the full script

                            // ORIGINAL COMMENT: todo actually required count can be retrieved from redeem_script, sigs can be taken from partial sigs according to required count
                            // ORIGINAL COMMENT: considering xpubs sorted order
                            let available_pubs = escrow
                                .pubs
                                .iter()
                                .filter(|kp| input.partial_sigs.contains_key(kp))
                                .collect::<Vec<_>>();

                            // For each escrow pubkey return <op code, sig, sighash type> and then concat these triples
                            let sigs: Vec<_> = available_pubs
                                .iter()
                                .take(escrow.m())
                                .flat_map(|kp| {
                                    let sig = input.partial_sigs.get(kp).unwrap().into_bytes();
                                    std::iter::once(OpData65)
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
                        }
                    }
                })
                .collect())
        })
        .unwrap();

    let params = Params::from(network_id);

    let tx = finalized_pskt
        .extractor()
        .unwrap()
        .extract_tx(&params)
        .map_err(|e: ExtractError| eyre::eyre!("Extract kaspa tx: {:?}", e))?;

    let rpc_tx: RpcTransaction = (&tx.tx).into();
    Ok(rpc_tx)
}

pub async fn sign_pay_fee(pskt: PSKT<Signer>, r: &SigningResources) -> Result<PSKT<Signer>> {
    corelib::pskt::sign_pskt(
        pskt,
        &r.key_pair,
        Some(r.key_source.clone()),
        None::<fn(&Input) -> bool>,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    use corelib::util::is_valid_sighash_type;
    use corelib::withdraw::WithdrawFXG;
    use hyperlane_core::H256;
    use kaspa_consensus_core::network::NetworkType::Devnet;
    use kaspa_consensus_core::tx::ScriptPublicKey;
    use std::str::FromStr;

    #[test]
    fn test_kaspa_address_conversion() {
        // Input is an address which is going to receive funds
        let input = "kaspatest:qzgq29y4cwrchsre26tvyezk2lsyhm3k23ch9tv4nrpvyq7lyhs3sux404nt8";
        // First, we need to get its bytes representation
        let input_kaspa = kaspa_addresses::Address::constructor(input);
        // Input hex is what will be used in MsgRemoteTransfer
        let input_hex = hex::encode(input_kaspa.payload);
        // In x/warp, the input hex is converted to a byte vector
        let output_bytes = hex::decode(input_hex).unwrap();
        // Put these bytes to a 32-byte array
        let output_bytes_32: [u8; 32] = output_bytes.try_into().unwrap();
        // In the agent, the 32-byte array is converted to H256
        let output_h256 = H256::from_slice(&output_bytes_32);
        // Construct Kaspa address
        let output_kaspa = kaspa_addresses::Address::new(
            kaspa_addresses::Prefix::Testnet,
            kaspa_addresses::Version::PubKey,
            output_h256.as_bytes(),
        );

        let output = output_kaspa.address_to_string();

        assert_eq!(true, kaspa_addresses::Address::validate(output.as_str()));
        assert_eq!(input, output.as_str());
    }

    #[test]
    fn test_pskt_intput_sighash_type() -> Result<()> {
        // Create PSKT signer with input
        let input = kaspa_wallet_pskt::input::InputBuilder::default()
            .sighash_type(input_sighash_type())
            .build()
            .map_err(|e| eyre::eyre!("Failed to build input: {}", e))?;

        let pskt = PSKT::<Creator>::default()
            .constructor()
            .input(input)
            .no_more_inputs()
            .no_more_outputs()
            .signer();

        // Verify sighash type
        let sighash_type_1 = pskt.inputs.first().unwrap().sighash_type;
        assert!(is_valid_sighash_type(sighash_type_1));

        // Create WithdrawFXG
        let bundle = Bundle::from(pskt);

        let withdraw_fxg = WithdrawFXG::new(
            bundle,
            vec![],
            vec![
                TransactionOutpoint::default(),
                TransactionOutpoint::default(),
            ],
        );

        // Convert WithdrawFXG to Bytes
        let serialized_bytes = Bytes::try_from(&withdraw_fxg)
            .map_err(|e| eyre::eyre!("Failed to serialize WithdrawFXG to Bytes: {}", e))?;

        // Convert Bytes back to WithdrawFXG
        let deserialized_withdraw_fxg = WithdrawFXG::try_from(serialized_bytes)
            .map_err(|e| eyre::eyre!("Failed to deserialize WithdrawFXG from Bytes: {}", e))?;

        // Verify sighash type
        let sighash_type_2 = deserialized_withdraw_fxg
            .bundle
            .iter()
            .next()
            .unwrap()
            .inputs
            .first()
            .unwrap()
            .sighash_type;

        assert!(is_valid_sighash_type(sighash_type_2));

        Ok(())
    }

    #[test]
    #[ignore]
    fn test_estimate_fee_with_different_inputs() -> Result<()> {
        // Skip this test.
        // It can be used to play with the TX mass estimation.

        const MIN_OUTPUTS: u32 = 2;
        const MIN_INPUTS: u32 = 2;

        const MAX_OUTPUTS: u32 = 15;
        const MAX_INPUTS: u32 = 6;

        let spk = ScriptPublicKey::from_str(
            "20bcff7587f574e249b549329291239682d6d3481ccbc5997c79770a607ab3ec98ac",
        )?;

        let payload: Vec<u8> =
            hex::decode("0a20f3b12fe3f4a43a7deb33be5f5a7a766ce22f76e9d8d6e1f77338e2f233db8e20")
                .expect("Invalid hex payload");

        let network_id = NetworkId::new(Devnet);

        let mut res: Vec<Vec<u64>> = Vec::new();

        for input_count in MIN_INPUTS..=MAX_INPUTS {
            let inputs: Vec<PopulatedInput> = (0..input_count)
                .map(|_i| {
                    let tx_id = "81b79b11b546e3769e91bebced62fc0ff7ce665258201fd501ea3c60d735ec7d".to_string().parse().unwrap();
                    let sig_script = "41b31e2b858c19baef26cb352664b493cb9f7f3b3f94217a7ca857f740db5eb4cb1004c9a278449477e23fb1b09f141d1a939b7f8435c578af17549cd2ff79b7b4814129ab65d772387cfa300314597b0ab11d9900ffcbe2f072568cbb6cd76bdba057242e365d951d2f87ab98bb332527d6df07cf207164ab1be5a643a6d7edb9fde6814171641e6b8ce10fcf5b41e962cf3665020a5e295ddf35a6a07e791d619aa1580d5f43d37c7dfa3c115b648c25b92ad17868e61bd01ad782b04ead5177ce5f40958141bc5b0b3f6e3bbb468d8710aba0cb0c04e046371f1b0972aacf48121e9d0704233e7596685e9a25464b85857562427f4982ba6e84c3258e356d9bff67478bb4df81415177d6b9b39414dd75374089d98c38b145c332b7a960cf2cabeb9cdd397c090d7e81bc28619f0491b1a57483013adca9badff86df32d31598fee28fd4699ed15814123b9ae551e0201f106291923d294715800ffb47a7dc158f738e341f87f0656805b1d27f931bc1653d366ef7bf55f1a0be7c8c25ed510dbec3297fae0b51c96d4814d0b0156205461e2ab2584bc80435c2a3f51c4cf12285992b5e4fdec57f1f8b506134a90872018a9fcc6059c1995c70b8f31b2256ac3d4aeca5dffa331fb941a8c5d4bffdd7620d7a78be7d152498cfb9fb8a89b60723f011435303499e0de7c1bcbf88f87d1b920f02a8dc60f124b34e9a8800fb25cf25ac01a3bdcf5a6ea21d2e2569a173dd9b2208586f127129710cdac6ca1d86be1869bd8a8746db9a2339fde71278dff7fb4692014d0d6d828c2f3e5ce908978622c5677c1fc53372346a9cff60d1140c54b5e5e209035bddc82d62454b2d425e205533363d09dc5d9c0d0f74c1f937c2d211c15a120e4b95346367e49178c8571e8a649584981d8bd6f920c648e37bbe24f055baf9c58ae".as_bytes().to_vec();

                    // Create the populated input, then modify the signature script
                    let mut input = PopulatedInputBuilder::new(tx_id, 0, 4_000_000_000, spk.clone())
                        .sig_op_count(8)
                        .build();

                    // Update the signature script in the TransactionInput
                    input.0.signature_script = sig_script;
                    input
                })
                .collect();

            let mut res_inner: Vec<u64> = Vec::new();
            for output_count in MIN_OUTPUTS..=MAX_OUTPUTS {
                let outputs: Vec<TransactionOutput> = (0..output_count)
                    .map(|_| TransactionOutput {
                        value: 4_000_000_000,
                        script_public_key: spk.clone(),
                    })
                    .collect();

                // Call the function under test
                let v = estimate_mass(
                    inputs.clone(),
                    outputs.clone(),
                    payload.clone(),
                    network_id,
                    8,
                )?;

                res_inner.push(v);

                print!("{v},");
            }

            res.push(res_inner);
            println!();
        }

        Ok(())
    }
}
