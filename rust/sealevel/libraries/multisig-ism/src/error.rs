/// Errors relating to a MultisigIsm
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, PartialEq)]
pub enum MultisigIsmError {
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Threshold not met")]
    ThresholdNotMet,
}
