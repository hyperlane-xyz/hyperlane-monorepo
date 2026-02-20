use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("Fee account is not a Routing type")]
    NotRoutingFee = 2,

    #[error("Route domain PDA not found")]
    RouteDomainNotFound = 3,

    #[error("Integer overflow in fee calculation")]
    IntegerOverflow = 4,

    #[error("Unused account(s) provided")]
    ExtraneousAccount = 5,

    #[error("Invalid fee account PDA")]
    InvalidFeeAccountPda = 6,

    #[error("Invalid route domain PDA")]
    InvalidRouteDomainPda = 7,

    #[error("Account already initialized")]
    AlreadyInitialized = 8,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
