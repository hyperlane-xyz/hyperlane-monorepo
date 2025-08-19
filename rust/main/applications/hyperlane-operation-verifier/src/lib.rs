#![deny(clippy::arithmetic_side_effects)]

pub use operation_verifier::ApplicationOperationVerifier;
pub use operation_verifier::ApplicationOperationVerifierReport;

mod operation_verifier;
