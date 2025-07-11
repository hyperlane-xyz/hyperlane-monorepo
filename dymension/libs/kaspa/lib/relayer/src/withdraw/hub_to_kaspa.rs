use eyre::Result;

use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};
use kaspa_wallet_core::derivation::build_derivate_paths;

use corelib::consts::KEY_MESSAGE_IDS;
use corelib::escrow::EscrowPublic;
use corelib::payload::MessageID;
use corelib::payload::MessageIDs;
use hardcode::tx::DUST_AMOUNT;
use hex::ToHex;
use hyperlane_core::{Decode, HyperlaneMessage, H256};
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{WithdrawalId, WithdrawalStatus};
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::config::params::Params;
use kaspa_consensus_core::constants::TX_VERSION;
use kaspa_consensus_core::hashing::sighash_type::{
    SigHashType, SIG_HASH_ALL, SIG_HASH_ANY_ONE_CAN_PAY,
};
use kaspa_consensus_core::mass;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{PopulatedTransaction, ScriptPublicKey, UtxoEntry};
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutpoint, TransactionOutput,
};
use kaspa_hashes;
use kaspa_rpc_core::{RpcTransaction, RpcUtxoEntry, RpcUtxosByAddressesEntry};
use kaspa_txscript::standard::pay_to_address_script;
use kaspa_txscript::{opcodes::codes::OpData65, script_builder::ScriptBuilder};
use kaspa_wallet_core::account::pskb::PSKBSigner;
use kaspa_wallet_core::account::Account;
use kaspa_wallet_core::prelude::DynRpcApi;
use kaspa_wallet_core::prelude::*;
use kaspa_wallet_core::utxo::NetworkParams;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::prelude::{Signer, PSKT};
use secp256k1::PublicKey;
use std::io::Cursor;
use std::sync::Arc;

use corelib::util;
use corelib::util::{get_recipient_script_pubkey, input_sighash_type};
use corelib::wallet::EasyKaspaWallet;
use corelib::withdraw::WithdrawFXG;
use eyre::eyre;
use kaspa_addresses::{AddressError, Prefix};
use kaspa_rpc_core::model::RpcTransactionId;
use kaspa_wallet_core::tx::is_transaction_output_dust;
use kaspa_wallet_pskt::prelude::Bundle;
use tracing::info;

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

    //////////////////
    //     Fee      //
    //////////////////

    // Multiply the fee by 1.1 to give some space for adding change UTXOs.
    // TODO: use feerate.
    let tx_fee =
        estimate_fee(inputs.clone(), outputs.clone(), payload.clone(), network_id) * 11 / 10;

    if relayer_balance < tx_fee {
        return Err(eyre::eyre!(
            "Insufficient relayer funds to cover tx fee: {} < {}",
            relayer_balance,
            tx_fee
        ));
    }

    ////////////////
    //   Change   //
    ////////////////

    let relayer_change_amt = relayer_balance - tx_fee;
    // check if relayer_change is dust
    let relayer_change = TransactionOutput {
        value: relayer_change_amt,
        script_public_key: ScriptPublicKey::from(pay_to_address_script(relayer_addr)),
    };
    if is_transaction_output_dust(&relayer_change) {
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
    if is_transaction_output_dust(&escrow_change) {
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
        let mut builer = InputBuilder::default();

        builer
            .utxo_entry(entry)
            .previous_outpoint(input.previous_outpoint)
            .sig_op_count(input.sig_op_count)
            .sighash_type(input_sighash_type());

        if !input.signature_script.is_empty() {
            // escrow inputs need redeem_script
            builer.redeem_script(input.signature_script);
        }

        pskt = pskt.input(
            builer
                .build()
                .map_err(|e| eyre::eyre!("Build pskt input: {}", e))?,
        );
    }

    // Add outputs
    for output in outputs.into_iter() {
        let pskt_output = OutputBuilder::default()
            .amount(output.value)
            .script_public_key(output.script_public_key)
            .build()
            .map_err(|e| eyre::eyre!("Build pskt output for withdrawal: {}", e))?;

        pskt = pskt.output(pskt_output);
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
) -> (Vec<HyperlaneMessage>, Vec<TransactionOutput>) {
    let mut hl_msgs: Vec<HyperlaneMessage> = Vec::new();
    let mut outputs: Vec<TransactionOutput> = Vec::new();
    for m in messages {
        let tm = match TokenMessage::read_from(&mut Cursor::new(&m.body)) {
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

        if is_transaction_output_dust(&o) {
            info!("Kaspa relayer, withdrawal amount is less than dust amount, skipping");
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

    let block = kaspa_rpc
        .get_block_dag_info()
        .await
        .map_err(|e| eyre::eyre!("Get block DAG info: {}", e))?;
    let current_daa_score = block.virtual_daa_score;

    // Descending order – older UTXOs first
    utxos.sort_by_key(|u| std::cmp::Reverse(u.utxo_entry.block_daa_score));
    utxos.retain(|u| {
        util::maturity::is_mature(u.utxo_entry.block_daa_score, current_daa_score, network_id)
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
        .map(|(input, _)| input.clone().into())
        .collect();
    let utxo_entries = populated_inputs
        .iter()
        .map(|(_, entry)| entry.clone().into())
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

    let mass = cm.max(ncm);

    // TODO: Apply current feerate. It can be fetched from https://api.kaspa.org/info/fee-estimate.
    mass
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
    let finalized = finalize_txs(txs_signed, fxg.messages.clone(), escrow)?;
    Ok(finalized)
}

async fn sign_relayer_fee(easy_wallet: &EasyKaspaWallet, fxg: &WithdrawFXG) -> Result<Bundle> {
    let wallet = easy_wallet.wallet.clone();
    let secret = easy_wallet.secret.clone();

    let mut signed = Vec::new();
    // Iterate over (PSKT; associated HL messages) pairs
    for (pskt, messages) in fxg.bundle.iter().zip(fxg.messages.clone().into_iter()) {
        let pskt = PSKT::<Signer>::from(pskt.clone());

        signed.push(sign_pay_fee(pskt, &wallet, &secret).await?);
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
) -> Result<Vec<RpcTransaction>> {
    let transactions_result: Result<Vec<RpcTransaction>, _> = txs_sigs
        .into_iter()
        .zip(messages.into_iter())
        .map(|(tx, hl_messages)| {
            let payload = MessageIDs::from(hl_messages)
                .to_bytes()
                .map_err(|e| eyre::eyre!("Deserialize MessageIDs: {}", e))?;
            finalize_pskt(tx, payload, escrow)
        })
        .collect();

    let transactions: Vec<RpcTransaction> = transactions_result?;

    Ok(transactions)
}

// used by multisig demo AND real code
pub fn finalize_pskt(
    c: PSKT<Combiner>,
    payload: Vec<u8>,
    escrow: &EscrowPublic,
) -> Result<RpcTransaction> {
    let finalized_pskt = c
        .finalizer()
        .finalize_sync(|inner: &Inner| -> Result<Vec<Vec<u8>>, String> {
            Ok(inner
                .inputs
                .iter()
                .enumerate()
                .map(|(i, input)| -> Vec<u8> {
                    match &input.redeem_script {
                        None => {
                            // relayer UTXO

                            let sig = input
                                .partial_sigs
                                .iter()
                                .filter(|(pk, _sig)| !escrow.has_pub(pk))
                                .next()
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

                            // For each escrow pubkey return <op code, sig, sighash type> and then concat these triples
                            let sigs: Vec<_> = escrow
                                .pubs
                                .iter()
                                .flat_map(|kp| {
                                    let sig = input.partial_sigs.get(&kp).unwrap().into_bytes();
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
    let (mut tx, _) = finalize_fn(mass);

    let rpc_tx = (&tx).into();
    Ok(rpc_tx)
}

pub async fn sign_pay_fee(pskt: PSKT<Signer>, w: &Arc<Wallet>, s: &Secret) -> Result<PSKT<Signer>> {
    // The code above combines `Account.pskb_sign` and `pskb_signer_for_address` functions.
    // It's a hack allowing to sign PSKT with a custom payload.
    // https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/core/src/account/pskb.rs#L154
    // https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/core/src/account/mod.rs#L383

    let derivation = w.account()?.as_derivation_capable()?;
    let keydata = w.account()?.prv_key_data(s.clone()).await?;
    let addr = w.account()?.change_address()?;
    let (receive, change) = derivation.derivation().addresses_indexes(&[&addr])?;
    let pks = derivation.create_private_keys(&keydata, &None, &receive, &change)?;
    let (_, priv_key) = pks.first().unwrap();

    let xprv = keydata.get_xprv(None)?;
    let key_pair = secp256k1::Keypair::from_secret_key(secp256k1::SECP256K1, priv_key);

    // Get derivation path for the account. build_derivate_paths returns receive and change paths, respectively.
    // Use receive one as it is used in `Account.pskb_sign`.
    let (derivation_path, _) = build_derivate_paths(
        &derivation.account_kind(),
        derivation.account_index(),
        derivation.cosigner_index(),
    )?;

    let key_fingerprint = xprv.public_key().fingerprint();

    corelib::pskt::sign_pskt(
        pskt,
        &key_pair,
        Some(KeySource {
            key_fingerprint,
            derivation_path: derivation_path.clone(),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use corelib::util::check_sighash_type;
    use corelib::withdraw::WithdrawFXG;
    use std::collections::BTreeMap;

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

    /// Verify that after creating PSKT with a custom global field, these fields remain presented
    /// after serialization and deserialization.
    #[test]
    fn test_pskt_global_proprietaries_persistence() {
        // Step 1: Create a new Global with custom proprietaries
        let test_msg_ids = vec![
            MessageID(H256::from([1u8; 32])),
            MessageID(H256::from([2u8; 32])),
            MessageID(H256::from([3u8; 32])),
        ];

        let message_ids = MessageIDs::new(test_msg_ids.clone());
        let msg_ids_value = message_ids
            .into_value()
            .expect("Failed to serialize test MessageIDs");

        let test_proprietaries = BTreeMap::from([(
            corelib::consts::KEY_MESSAGE_IDS.to_string(),
            msg_ids_value.clone(),
        )]);

        let global = GlobalBuilder::default()
            .proprietaries(test_proprietaries.clone())
            .build()
            .expect("Failed to build Global");

        // Step 2: Create Inner with our custom Global
        let mut inner: Inner = Default::default();
        inner.global = global;

        // Step 3: Create PSKT::Creator, convert to constructor, then to signer
        let pskt_creator = PSKT::<Creator>::from(inner);
        let pskt_constructor = pskt_creator.constructor();
        let pskt_signer = pskt_constructor.no_more_inputs().no_more_outputs().signer();

        // Verify the proprietaries exist in the signer PSKT
        assert!(pskt_signer
            .global
            .proprietaries
            .contains_key(corelib::consts::KEY_MESSAGE_IDS));

        // Step 4: Create WithdrawFXG using Bundle::from(pskt)
        let bundle = Bundle::from(pskt_signer);
        let withdraw_fxg = WithdrawFXG::new(
            bundle,
            vec![],
            vec![
                TransactionOutpoint::default(),
                TransactionOutpoint::default(),
            ],
        );

        // Step 5: Convert WithdrawFXG to Bytes
        let serialized_bytes =
            Bytes::try_from(&withdraw_fxg).expect("Failed to serialize WithdrawFXG to Bytes");

        // === DESERIALIZATION PROCESS STARTS ===

        // Step 6: Convert Bytes back to WithdrawFXG
        let deserialized_withdraw_fxg = WithdrawFXG::try_from(serialized_bytes)
            .expect("Failed to deserialize WithdrawFXG from Bytes");

        // Step 7: Convert WithdrawFXG to vector of Inner
        let inners: Vec<Inner> = deserialized_withdraw_fxg.bundle.iter().cloned().collect();

        // Step 8: Create PSKT::Combiner from all Inners and convert to Signer
        // For this test, we only have one Inner, but the process should work for multiple
        assert!(!inners.is_empty(), "Should have at least one Inner");

        let first_pskt = PSKT::<Signer>::from(inners[0].clone());

        // If there were multiple Inners, we would combine them here
        let mut combiner = first_pskt.combiner();
        for inner in inners.iter().skip(1) {
            let pskt_signer = PSKT::<Signer>::from(inner.clone());
            combiner = (combiner + pskt_signer).expect("Failed to combine PSKTs");
        }

        let final_pskt = combiner.signer();

        // Step 9: Verify the expected values exist and are the same
        let recovered_proprietaries = &final_pskt.global.proprietaries;

        // Check that our message IDs are still there
        assert!(
            recovered_proprietaries.contains_key(corelib::consts::KEY_MESSAGE_IDS),
            "MessageIDs key should be present after serialization/deserialization"
        );

        // Verify the MessageIDs value is the same
        let recovered_msg_ids_value = recovered_proprietaries
            .get(corelib::consts::KEY_MESSAGE_IDS)
            .expect("MessageIDs should be present");

        let recovered_message_ids = MessageIDs::from_value(recovered_msg_ids_value.clone())
            .expect("Failed to deserialize recovered MessageIDs");

        assert_eq!(
            recovered_message_ids.0, test_msg_ids,
            "MessageIDs should be identical after round-trip"
        );

        // Verify that the original and recovered proprietaries are equivalent
        assert_eq!(
            recovered_proprietaries.len(),
            test_proprietaries.len(),
            "Number of proprietaries should be preserved"
        );
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
        assert!(check_sighash_type(sighash_type_1));

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

        assert!(check_sighash_type(sighash_type_2));

        Ok(())
    }
}
