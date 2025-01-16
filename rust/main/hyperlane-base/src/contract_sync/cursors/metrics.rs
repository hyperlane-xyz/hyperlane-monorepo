use prometheus::IntGaugeVec;

use crate::CoreMetrics;

/// Struct encapsulating prometheus metrics used by SequenceAware and RateLimited cursors.
#[derive(Debug, Clone)]
pub struct CursorMetrics {
    /// Current block of the cursor.
    /// Used by both sequence aware and rate limited cursors.
    /// Labels:
    /// - `event_type`: the event type the cursor is indexing. Could be anything implementing `Indexable`.
    /// - `chain`: Chain the cursor is collecting data from.
    /// - `cursor_type`: The type of cursor. E.g. `forward_sequenced`, `backward_sequenced`, `forward_rate_limited`.
    pub cursor_current_block: IntGaugeVec,

    /// Current sequence of the cursor.
    /// Only used by sequence aware cursors.
    /// Labels:
    /// - `event_type`: the event type the cursor is indexing. Could be anything implementing `Indexable`.
    /// - `chain`: Chain the cursor is collecting data from.
    /// - `cursor_type`: The type of cursor. E.g. `forward_sequenced`, `backward_sequenced`, `forward_rate_limited`.
    pub cursor_current_sequence: IntGaugeVec,

    /// Max sequence of the cursor.
    /// Only used by sequence aware cursors.
    /// Labels:
    /// - `event_type`: the event type the cursor is indexing. Could be anything implementing `Indexable`.
    /// - `chain`: Chain the cursor is collecting data from.
    pub cursor_max_sequence: IntGaugeVec,
}

impl CursorMetrics {
    /// Instantiate a new CursorMetrics object.
    pub fn new(metrics: &CoreMetrics) -> Self {
        let cursor_current_block = metrics
            .new_int_gauge(
                "cursor_current_block",
                "Current block of the cursor",
                &["event_type", "chain", "cursor_type"],
            )
            .expect("failed to register cursor_current_block metric");

        let cursor_current_sequence = metrics
            .new_int_gauge(
                "cursor_current_sequence",
                "Current sequence of the cursor",
                &["event_type", "chain", "cursor_type"],
            )
            .expect("failed to register cursor_current_sequence metric");

        let cursor_max_sequence = metrics
            .new_int_gauge(
                "cursor_max_sequence",
                "Max sequence of the cursor",
                &["event_type", "chain"],
            )
            .expect("failed to register cursor_max_sequence metric");

        CursorMetrics {
            cursor_current_block,
            cursor_current_sequence,
            cursor_max_sequence,
        }
    }
}
