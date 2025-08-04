use super::minimum::{is_dust, is_small_value};
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
use kaspa_consensus_core::mass;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{PopulatedTransaction, UtxoEntry};
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutpoint, TransactionOutput,
};
use kaspa_rpc_core::{RpcTransaction, RpcUtxosByAddressesEntry};
use kaspa_txscript::standard::pay_to_address_script;
use kaspa_txscript::{opcodes::codes::OpData65, script_builder::ScriptBuilder};
use kaspa_wallet_core::prelude::DynRpcApi;
use kaspa_wallet_pskt::prelude::Bundle;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::prelude::{Signer, PSKT};
use std::sync::Arc;
use tracing::{info, warn};

/// Fetches escrow and relayer balances and a combined list of all inputs
pub async fn fetch_input_utxos(
    kaspa_rpc: &Arc<DynRpcApi>,
    escrow: &EscrowPublic,
    relayer_address: &kaspa_addresses::Address,
    current_anchor: &TransactionOutpoint,
    network_id: NetworkId,
) -> Result<Vec<(TransactionInput, UtxoEntry)>> {
    // Get all available UTXOs for multisig
    let escrow_utxos = get_utxo_to_spend(&escrow.addr, kaspa_rpc, network_id).await?;

    // Check if the current anchor is withing the list of multisig UTXOs
    if !escrow_utxos.iter().any(|u| {
        u.outpoint.transaction_id == current_anchor.transaction_id
            && u.outpoint.index == current_anchor.index
    }) {
        return Err(eyre::eyre!(
            "No UTXOs found for current anchor: {:?}",
            current_anchor
        ));
    }

    // Get all available UTXOs for relayer
    let relayer_utxos = get_utxo_to_spend(relayer_address, kaspa_rpc, network_id).await?;

    // Iterate through escrow and relayer UTXO – they are the transaction inputs.
    // Create a vector of "populated" inputs: TransactionInput and UtxoEntry.
    Ok(escrow_utxos
        .into_iter()
        .map(|utxo| {
            (
                TransactionInput::new(
                    kaspa_consensus_core::tx::TransactionOutpoint::from(utxo.outpoint),
                    escrow.redeem_script.clone(),
                    0, // sequence does not matter
                    escrow.n() as u8,
                ),
                UtxoEntry::from(utxo.utxo_entry),
            )
        })
        .chain(relayer_utxos.into_iter().map(|utxo| {
            (
                TransactionInput::new(
                    kaspa_consensus_core::tx::TransactionOutpoint::from(utxo.outpoint),
                    vec![],
                    0,                                     // sequence does not matter
                    corelib::consts::RELAYER_SIG_OP_COUNT, // only one signature from relayer is needed
                ),
                UtxoEntry::from(utxo.utxo_entry),
            )
        }))
        .collect())
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
    inputs: Vec<(TransactionInput, UtxoEntry)>,
    mut outputs: Vec<TransactionOutput>,
    payload: Vec<u8>,
    escrow: &EscrowPublic,
    relayer_addr: &kaspa_addresses::Address,
    network_id: NetworkId,
    min_deposit_sompi: U256,
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
        inputs.iter().fold((0, 0), |mut acc, (input, entry)| {
            if input.signature_script.is_empty() {
                // relayer has empty signature script
                acc.1 += entry.amount;
            } else {
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

    // Multiply the fee by 1.1 to give some space for adding change UTXOs.
    // TODO: use feerate.
    let tx_fee =
        estimate_fee(inputs.clone(), outputs.clone(), payload.clone(), network_id) * 13 / 10;

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

    create_withdrawal_pskt(inputs, outputs, payload)
}

/// CONTRACT:
/// Escrow change is always the last output.
fn create_withdrawal_pskt(
    inputs: Vec<(TransactionInput, UtxoEntry)>,
    outputs: Vec<TransactionOutput>,
    payload: Vec<u8>,
) -> Result<PSKT<Signer>> {
    let mut pskt = PSKT::<Creator>::default().constructor();

    // Add inputs
    for (input, entry) in inputs.into_iter() {
        let mut b = InputBuilder::default();

        b.utxo_entry(entry)
            .previous_outpoint(input.previous_outpoint)
            .sig_op_count(input.sig_op_count)
            .sighash_type(input_sighash_type());

        if !input.signature_script.is_empty() {
            // escrow inputs need redeem_script
            b.redeem_script(input.signature_script);
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
        .payload(payload)
        .signer())
}

pub fn filter_outputs_from_msgs(
    messages: Vec<HyperlaneMessage>,
    prefix: Prefix,
    min_deposit_sompi: U256,
) -> (Vec<HyperlaneMessage>, Vec<TransactionOutput>) {
    let mut hl_msgs: Vec<HyperlaneMessage> = Vec::new();
    let mut outputs: Vec<TransactionOutput> = Vec::new();
    for m in messages {
        let tm = match parse_hyperlane_metadata(&m) {
            Ok(tm) => tm,
            Err(e) => {
                info!(
                    "Kaspa relayer, can't get TokenMessage from HyperlaneMessage body, skipping: {}",
                    e
                );
                continue;
            }
        };

        let recipient = get_recipient_script_pubkey(tm.recipient(), prefix);

        let o = TransactionOutput::new(tm.amount().as_u64(), recipient);

        if is_dust(&o, min_deposit_sompi) {
            info!("Kaspa relayer, withdrawal amount is less than dust amount, skipping, amount: {}, message id: {:?}", o.value, m.id());
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

fn estimate_fee(
    populated_inputs: Vec<(TransactionInput, UtxoEntry)>,
    outputs: Vec<TransactionOutput>,
    payload: Vec<u8>,
    network_id: NetworkId,
) -> u64 {
    let inputs = populated_inputs
        .iter()
        .map(|(input, _)| input.clone())
        .collect();
    let utxo_entries = populated_inputs
        .iter()
        .map(|(_, entry)| entry.clone())
        .collect();

    let tx = Transaction::new(
        TX_VERSION,
        inputs,
        outputs.clone(),
        0, // no tx lock time
        SUBNETWORK_ID_NATIVE,
        0,
        payload, // empty payload
    );
    let ptx = PopulatedTransaction::new(&tx, utxo_entries);

    let p = Params::from(network_id);
    let m = mass::MassCalculator::new_with_consensus_params(&p);

    let ncm = m.calc_non_contextual_masses(&tx);
    // Assumptions which must be verified before this call:
    //     1. All output values are non-zero
    //     2. At least one input (unless coinbase)
    //
    // Otherwise this function should never fail. As in our case.
    let cm = m.calc_contextual_masses(&ptx).unwrap();

    // TODO: Apply current feerate. It can be fetched from https://api.kaspa.org/info/fee-estimate.
    cm.max(ncm)
}

pub async fn combine_bundles_with_fee(
    bundles_validators: Vec<Bundle>,
    fxg: &WithdrawFXG,
    multisig_threshold: usize,
    escrow: &EscrowPublic,
    easy_wallet: &EasyKaspaWallet,
) -> Result<Vec<RpcTransaction>> {
    info!("Kaspa provider, got withdrawal FXG, now gathering sigs and signing relayer fee");

    let mut bundles_validators = bundles_validators;

    let all_bundles = {
        info!("Kaspa provider, got validator bundles, now signing relayer fee");
        if bundles_validators.len() < multisig_threshold {
            return Err(eyre!(
                "Not enough validator bundles, required: {}, got: {}",
                multisig_threshold,
                bundles_validators.len()
            ));
        }

        let bundle_relayer = sign_relayer_fee(easy_wallet, fxg).await?; // TODO: can add own sig in parallel to validator network request
        info!("Kaspa provider, got relayer fee bundle, now combining all bundles");
        bundles_validators.push(bundle_relayer);
        bundles_validators
    };
    let txs_signed = combine_all_bundles(all_bundles)?;
    let finalized = finalize_txs(
        txs_signed,
        fxg.messages.clone(),
        escrow,
        easy_wallet.pub_key().await?,
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
    // each bundle is from a different actor (validator or releayer), and is a vector of pskt
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
    for all_actor_sigs_for_tx in tx_sigs.iter() {
        let mut combiner = all_actor_sigs_for_tx.first().unwrap().clone().combiner();
        for tx_sig in all_actor_sigs_for_tx.iter().skip(1) {
            info!("Combining PSKT");
            combiner = (combiner + tx_sig.clone())?;
        }
        ret.push(combiner);
    }
    Ok(ret)
}

fn finalize_txs(
    txs_sigs: Vec<PSKT<Combiner>>,
    messages: Vec<Vec<HyperlaneMessage>>,
    escrow: &EscrowPublic,
    relayer_pub_key: secp256k1::PublicKey,
) -> Result<Vec<RpcTransaction>> {
    let transactions_result: Result<Vec<RpcTransaction>, _> = txs_sigs
        .into_iter()
        .zip(messages)
        .map(|(tx, _)| finalize_pskt(tx, escrow, &relayer_pub_key))
        .collect();

    let transactions: Vec<RpcTransaction> = transactions_result?;

    Ok(transactions)
}

// used by multisig demo AND real code
pub fn finalize_pskt(
    c: PSKT<Combiner>,
    escrow: &EscrowPublic,
    relayer_pub_key: &secp256k1::PublicKey,
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

    let mass = 10_000; // TODO: why? is it okay to keep this value?
    let finalize_fn = finalized_pskt
        .extractor()
        .unwrap()
        .extract_tx()
        .map_err(|e: ExtractError| eyre::eyre!("Extract kaspa tx: {:?}", e))?;
    let (tx, _) = finalize_fn(mass);

    let rpc_tx = (&tx).into();
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
}
