//! Public, structured failure evidence. Never construct this from raw error text.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A failure attached to the activity that observed it.
/// Codes and detail keys are stable; messages are for display only. Details must
/// be explicitly selected public values, never URLs, credentials or raw responses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticError {
    /// Machine-readable classification; consumers must tolerate new codes.
    pub code: String,
    /// Concise explanation without provider error text.
    pub message: String,
    /// Component that observed the failure.
    pub source: String,
    /// Code-specific evidence (counts, addresses, HTTP status, revert selector).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, Value>,
    /// Underlying failures, bounded by the producing operation's fanout.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub causes: Vec<Self>,
}

impl DiagnosticError {
    /// Create a diagnostic using a fixed code, message and component name.
    pub fn new(code: &str, message: &str, source: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
            source: source.to_owned(),
            details: BTreeMap::new(),
            causes: Vec::new(),
        }
    }

    /// Attach explicitly selected public evidence.
    pub fn with_detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details.insert(key.to_owned(), value.into());
        self
    }

    /// Attach an underlying failure.
    pub fn with_cause(mut self, cause: Self) -> Self {
        self.causes.push(cause);
        let causes = std::mem::take(&mut self.causes);
        self.with_causes(causes)
    }

    /// Bound the complete cause tree, including nested aggregation/provider errors.
    pub fn with_causes(mut self, causes: Vec<Self>) -> Self {
        fn retain(error: &mut DiagnosticError, remaining: &mut usize) -> bool {
            let mut truncated = false;
            error.causes.retain_mut(|cause| {
                if *remaining == 0 {
                    truncated = true;
                    return false;
                }
                *remaining = remaining.saturating_sub(1);
                truncated |= retain(cause, remaining);
                true
            });
            truncated
        }
        self.causes = causes;
        let mut remaining = 50;
        if retain(&mut self, &mut remaining) {
            self.details
                .insert("causes_truncated".to_owned(), true.into());
        }
        self
    }

    /// Decode EVM revert evidence without publishing arbitrary revert arguments.
    #[cfg(feature = "ethers")]
    pub fn from_evm_revert(data: &[u8]) -> Self {
        use ethers_core::abi::AbiDecode;
        let mut error = Self::new("execution_reverted", "Contract execution reverted", "evm");
        let Some(selector) = data.get(..4) else {
            return error;
        };
        error = error.with_detail("revert_selector", format!("0x{}", hex::encode(selector)));
        if selector == [0x4e, 0x48, 0x7b, 0x71] {
            if let Ok(code) = ethers_core::types::U256::decode(&data[4..]) {
                let panic_code = format!("{code:#x}");
                error.message = match panic_code.as_str() {
                    "0x1" => "Solidity assertion failed",
                    "0x11" => "Solidity arithmetic overflow or underflow",
                    "0x12" => "Solidity division or modulo by zero",
                    "0x21" => "Solidity enum conversion was out of range",
                    "0x22" => "Solidity storage byte array was incorrectly encoded",
                    "0x31" => "Solidity attempted to pop an empty array",
                    "0x32" => "Solidity array access was out of bounds",
                    "0x41" => "Solidity memory allocation exceeded its limit",
                    "0x51" => "Solidity called an uninitialized internal function",
                    _ => "Contract execution panicked",
                }
                .to_owned();
                error = error.with_detail("panic_code", panic_code);
            }
        } else if selector == [0x08, 0xc3, 0x79, 0xa0] {
            // Known protocol reasons only. Arbitrary contract strings can contain
            // message data; retaining the selector still identifies Error(string).
            if let Ok(reason) = String::decode(&data[4..]) {
                if matches!(
                    reason.as_str(),
                    "ICA: Invalid Reveal"
                        | "Mailbox: bad version"
                        | "Mailbox: unexpected destination"
                        | "Mailbox: already delivered"
                        | "Mailbox: ISM verification failed"
                        | "No MultisigISM threshold present for message"
                        | "Invalid threshold"
                        | "Invalid threshold weight"
                        | "Invalid signer"
                        | "!threshold"
                        | "!verify"
                        | "Commitment ISM: Revealed Hash Invalid"
                ) {
                    error.message = format!("Contract execution reverted: {reason}");
                    error = error.with_detail("revert_reason", reason);
                }
            }
        }
        error
    }
}

#[cfg(all(test, feature = "ethers"))]
mod tests {
    use super::*;
    use ethers_core::abi::{encode, Token};

    #[test]
    fn bounds_nested_cause_trees_and_marks_truncation() {
        let leaf = DiagnosticError::new("missing", "Checkpoint missing", "validator");
        let branch =
            DiagnosticError::new("quorum", "Quorum unavailable", "ism").with_causes(vec![leaf; 40]);
        let error = DiagnosticError::new("aggregation", "Threshold not met", "ism")
            .with_causes(vec![branch; 10]);
        fn count(error: &DiagnosticError) -> usize {
            error
                .causes
                .iter()
                .map(|cause| count(cause).saturating_add(1))
                .sum()
        }
        assert_eq!(count(&error), 50);
        assert_eq!(error.details["causes_truncated"], true);
    }

    #[test]
    fn decodes_panic_and_custom_selectors_without_returning_raw_data() {
        let mut panic = vec![0x4e, 0x48, 0x7b, 0x71];
        panic.extend(encode(&[Token::Uint(0x11.into())]));
        let error = DiagnosticError::from_evm_revert(&panic);
        assert_eq!(error.details["panic_code"], "0x11");
        assert_eq!(error.message, "Solidity arithmetic overflow or underflow");
        assert_eq!(error.details["revert_selector"], "0x4e487b71");
        assert_eq!(
            DiagnosticError::from_evm_revert(&[0xde, 0xad, 0xbe, 0xef]).details["revert_selector"],
            "0xdeadbeef"
        );
    }

    #[test]
    fn only_exposes_known_protocol_revert_strings() {
        for (reason, allowed) in [
            ("ICA: Invalid Reveal", true),
            ("https://private-rpc.example?key=secret", false),
        ] {
            let mut data = vec![0x08, 0xc3, 0x79, 0xa0];
            data.extend(encode(&[Token::String(reason.to_owned())]));
            let error = DiagnosticError::from_evm_revert(&data);
            assert_eq!(error.details.contains_key("revert_reason"), allowed);
            if !allowed {
                assert!(!serde_json::to_string(&error)
                    .expect("valid test value")
                    .contains("secret"));
            }
        }
    }
}
