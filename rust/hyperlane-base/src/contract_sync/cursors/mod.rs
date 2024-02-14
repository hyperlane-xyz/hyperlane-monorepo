use hyperlane_core::{LogMeta, Sequenced};

mod backward_sequence_aware;
mod forward_sequence_aware;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SequenceAwareSyncSnapshot {
    sequence: u32,
    at_block: u32,
}

impl SequenceAwareSyncSnapshot {
    fn next(&self) -> Self {
        Self {
            sequence: self.sequence + 1,
            // It's possible that the next sequence would be in the same block,
            // so we refrain from incrementing the block number and instead
            // accept that we'll end up re-indexing the same block.
            at_block: self.at_block,
        }
    }

    fn previous(&self) -> Self {
        Self {
            sequence: self.sequence.saturating_sub(1),
            // It's possible that the next sequence would be in the same block,
            // so we refrain from incrementing the block number and instead
            // accept that we'll end up re-indexing the same block.
            at_block: self.at_block,
        }
    }
}

// Note this tolerates logs that *exceed* the range.
pub(crate) fn sequences_missing_from_range<T: Sequenced>(
    logs: &Vec<(T, LogMeta)>,
    sequence_range: impl Iterator<Item = u32>,
) -> Option<Vec<u32>> {
    let mut missing_sequences = vec![];
    let mut i = 0;
    for expected_sequence in sequence_range {
        if let Some((log, _)) = logs.get(i as usize) {
            if log.sequence() != expected_sequence {
                missing_sequences.push(i);
            }
        } else {
            missing_sequences.push(i);
        }
        i += 1;
    }

    (!missing_sequences.is_empty()).then(|| missing_sequences)
}
