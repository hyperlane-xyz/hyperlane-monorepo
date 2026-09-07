use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Invalid hash length: expected 32 bytes")]
    InvalidHashLength {},

    #[error("Slot {0} is older than or equal to current latest slot {1}")]
    SlotNotIncreasing(u64, u64),

    #[error("Invalid proof provided")]
    InvalidProof {},

    #[error("Sync committee period mismatch")]
    InvalidPeriod {},
}
