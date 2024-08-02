use derive_new::new;

use crate::{HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion, Sequenced, H256};

/// Wrapper struct that adds indexing information to a type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, new)]
pub struct Indexed<T> {
    inner: T,
    #[new(default)]
    /// Optional sequence data that is useful during indexing
    pub sequence: Option<u32>,
}

/// Counterpart of `Indexed` that is sure to have the `sequence` field set
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, new)]
pub struct SequenceIndexed<T> {
    inner: T,
    /// Sequence data that is useful during indexing
    pub sequence: u32,
}

impl<T> TryFrom<Indexed<T>> for SequenceIndexed<T> {
    type Error = eyre::Report;

    fn try_from(value: Indexed<T>) -> Result<Self, Self::Error> {
        match value.sequence {
            Some(sequence) => Ok(SequenceIndexed::new(value.inner, sequence)),
            None => eyre::bail!("Missing indexing sequence"),
        }
    }
}

/// Convert a vector of `Indexed` values to a vector of `SequenceIndexed` values
/// so that if any `Option` is `None`, the conversion will fail
pub fn indexed_to_sequence_indexed_array<T, U>(
    indexed_array: Vec<(Indexed<T>, U)>,
) -> Result<Vec<(SequenceIndexed<T>, U)>, eyre::Report> {
    indexed_array
        .into_iter()
        .map(|(item, meta)| SequenceIndexed::<T>::try_from(item).map(|si| (si, meta)))
        .collect()
}

impl<T: Send + Sync + 'static> Sequenced for Indexed<T> {
    fn sequence(&self) -> Option<u32> {
        self.sequence
    }
}

impl<T> Indexed<T> {
    /// Set the sequence of the indexed value, returning a new instance of `Self`
    pub fn with_sequence(mut self, sequence: u32) -> Self {
        self.sequence = Some(sequence);
        self
    }

    /// Get the inner value
    pub fn inner(&self) -> &T {
        &self.inner
    }
}

impl From<HyperlaneMessage> for Indexed<HyperlaneMessage> {
    fn from(value: HyperlaneMessage) -> Self {
        let nonce = value.nonce;
        Indexed::new(value).with_sequence(nonce as _)
    }
}

impl From<H256> for Indexed<H256> {
    fn from(value: H256) -> Self {
        Indexed::new(value)
    }
}

impl From<MerkleTreeInsertion> for Indexed<MerkleTreeInsertion> {
    fn from(value: MerkleTreeInsertion) -> Self {
        let sequence = value.index();
        Indexed::new(value).with_sequence(sequence as _)
    }
}

impl From<InterchainGasPayment> for Indexed<InterchainGasPayment> {
    fn from(value: InterchainGasPayment) -> Self {
        Indexed::new(value)
    }
}
