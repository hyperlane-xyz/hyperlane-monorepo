use crate::consts::RELAYER_SIG_OP_COUNT;
use eyre::Result;
use kaspa_consensus_client::{
    TransactionOutpoint as ClientTransactionOutpoint, UtxoEntry as ClientUtxoEntry,
};
use kaspa_consensus_core::config::params::Params;
use kaspa_consensus_core::constants::{TX_VERSION, UNACCEPTED_DAA_SCORE};
use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};
use kaspa_consensus_core::hashing::sighash_type::{
    SigHashType, SIG_HASH_ALL, SIG_HASH_ANY_ONE_CAN_PAY,
};
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{
    ScriptPublicKey, Transaction, TransactionInput, TransactionOutpoint, TransactionOutput,
    UtxoEntry,
};
use kaspa_hashes::Hash;
use kaspa_wallet_core::tx::MassCalculator;
use kaspa_wallet_core::utxo::UtxoEntryReference;
use kaspa_wallet_pskt::prelude::*;
use std::str::FromStr;

/// A populated input is a tuple of (TransactionInput, UtxoEntry, optional redeem_script).
/// This represents an input with all the information needed for signing.
pub type PopulatedInput = (TransactionInput, UtxoEntry, Option<Vec<u8>>);

/// Builder for creating PopulatedInput instances with sensible defaults
pub struct PopulatedInputBuilder {
    tx_id: Hash,
    index: u32,
    amount: u64,
    script_public_key: ScriptPublicKey,
    sig_op_count: u8,
    block_daa_score: u64,
    redeem_script: Option<Vec<u8>>,
}

impl PopulatedInputBuilder {
    /// Create a new builder with required fields
    pub fn new(tx_id: Hash, index: u32, amount: u64, script_public_key: ScriptPublicKey) -> Self {
        Self {
            tx_id,
            index,
            amount,
            script_public_key,
            sig_op_count: RELAYER_SIG_OP_COUNT, // defaults, can be overridden
            block_daa_score: UNACCEPTED_DAA_SCORE, // defaults, can be overridden
            redeem_script: None,
        }
    }

    /// Create from a transaction output
    pub fn from_output(tx_id: Hash, index: u32, output: &TransactionOutput) -> Self {
        Self::new(tx_id, index, output.value, output.script_public_key.clone())
    }

    /// Set sig_op_count (defaults to RELAYER_SIG_OP_COUNT)
    pub fn sig_op_count(mut self, count: u8) -> Self {
        self.sig_op_count = count;
        self
    }

    /// Set block DAA score (defaults to UNACCEPTED_DAA_SCORE)
    pub fn block_daa_score(mut self, score: u64) -> Self {
        self.block_daa_score = score;
        self
    }

    /// Set redeem script (defaults to None)
    pub fn redeem_script(mut self, script: Option<Vec<u8>>) -> Self {
        self.redeem_script = script;
        self
    }

    /// Build the PopulatedInput
    pub fn build(self) -> PopulatedInput {
        (
            TransactionInput::new(
                TransactionOutpoint::new(self.tx_id, self.index),
                vec![],   // signature_script always starts empty
                u64::MAX, // sequence always u64::MAX
                self.sig_op_count,
            ),
            UtxoEntry::new(
                self.amount,
                self.script_public_key,
                self.block_daa_score,
                false,
            ),
            self.redeem_script,
        )
    }
}

/// Simple helper for common cases where you just need the defaults
pub fn populated_input(
    tx_id: Hash,
    index: u32,
    amount: u64,
    script_public_key: ScriptPublicKey,
) -> PopulatedInputBuilder {
    PopulatedInputBuilder::new(tx_id, index, amount, script_public_key)
}

/// Returns the standard sighash type used for Kaspa bridge transactions.
/// This combines SIG_HASH_ALL with SIG_HASH_ANY_ONE_CAN_PAY.
pub fn input_sighash_type() -> SigHashType {
    SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()).unwrap()
}

/// Validates that the given sighash type matches the expected bridge sighash type.
pub fn is_valid_sighash_type(t: SigHashType) -> bool {
    t.to_u8() == input_sighash_type().to_u8()
}

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
                    // we dont want to sign this input but the API constraints make us do it, so we supply junk data to make things not crash
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

/// Convert a PopulatedInput to a UtxoEntryReference for mass calculation.
pub fn utxo_reference_from_populated_input(
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

/// Estimate the transaction mass for a set of populated inputs, outputs, and payload.
/// This is used to determine if a transaction fits within Kaspa's mass limits.
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
