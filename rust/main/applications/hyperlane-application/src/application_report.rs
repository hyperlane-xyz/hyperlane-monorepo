use serde::{Deserialize, Serialize};
use strum::Display;

/// Application report
#[derive(Display, Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ApplicationReport {
    /// Amount below minimum
    AmountBelowMinimum,
    /// Message is malformed
    MalformedMessage,
    /// Zero amount
    ZeroAmount,
}
