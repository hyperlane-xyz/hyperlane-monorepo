use derive_new::new;

use crate::{HyperlaneMessage, MerkleTreeInsertion, Sequenced};

#[derive(Debug, Clone, Default, Copy, PartialEq, Eq, Hash, new)]
/// Additional indexing data associated to a type
pub struct IndexingDecorator {
    pub(crate) sequence: Option<u32>,
}

/// Wrapper struct that adds indexing information to a type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, new)]
pub struct Indexed<T> {
    inner: T,
    #[new(default)]
    decorator: IndexingDecorator,
}

impl<T: Send + Sync + 'static> Sequenced for Indexed<T> {
    fn sequence(&self) -> Option<u32> {
        self.sequence()
    }
}

impl<T> Indexed<T> {
    /// Set the sequence of the indexed value, returning a new instance of `Self`
    pub fn with_sequence(mut self, sequence: u32) -> Self {
        self.decorator.sequence = Some(sequence);
        self
    }

    /// Get the sequence of the indexed value
    pub fn sequence(&self) -> Option<u32> {
        self.decorator.sequence
    }

    /// Get the inner value
    pub fn inner(&self) -> &T {
        &self.inner
    }

    /// Get the entire decorator struct stored alongside the indexed type
    pub fn decorator(&self) -> &IndexingDecorator {
        &self.decorator
    }
}

impl From<HyperlaneMessage> for Indexed<HyperlaneMessage> {
    fn from(value: HyperlaneMessage) -> Self {
        let nonce = value.nonce;
        Indexed::new(value).with_sequence(nonce as _)
    }
}

impl From<MerkleTreeInsertion> for Indexed<MerkleTreeInsertion> {
    fn from(value: MerkleTreeInsertion) -> Self {
        let sequence = value.index();
        Indexed::new(value).with_sequence(sequence as _)
    }
}
