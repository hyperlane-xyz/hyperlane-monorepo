use hyperlane_core::{LogMeta, Sequenced};

mod forward_sequence_aware;

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
