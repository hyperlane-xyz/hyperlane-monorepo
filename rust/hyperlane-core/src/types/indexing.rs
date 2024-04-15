use derive_new::new;

use crate::{HyperlaneMessage, MerkleTreeInsertion, Sequenced};

#[derive(Debug, Clone, Default, Copy, PartialEq, Eq, Hash, new)]
/// Additional indexing data associated to a type
pub struct IndexingDecorator {
    // this field could be made optional if it doesn't apply to all instances
    // of the decorator
    pub sequence: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, new)]
pub struct Indexed<T> {
    inner: T,
    #[new(default)]
    decorator: IndexingDecorator,
}

impl<T: Send + Sync + 'static> Sequenced for Indexed<T> {
    fn sequence(&self) -> u32 {
        self.sequence()
    }
}

impl<T> Indexed<T> {
    pub fn with_sequence(mut self, sequence: u32) -> Self {
        self.decorator.sequence = sequence;
        self
    }

    pub fn sequence(&self) -> u32 {
        self.decorator.sequence
    }

    pub fn inner(&self) -> &T {
        &self.inner
    }

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
