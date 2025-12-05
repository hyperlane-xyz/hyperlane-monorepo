use dym_kas_core::consts::RELAYER_SIG_OP_COUNT;
use kaspa_consensus_core::constants::UNACCEPTED_DAA_SCORE;
use kaspa_consensus_core::tx::ScriptPublicKey;
use kaspa_consensus_core::tx::{
    TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry,
};
use kaspa_hashes::Hash;

use super::messages::PopulatedInput;

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
