use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("Fee account is not a Routing type")]
    NotRoutingFee = 0,

    #[error("Route domain PDA not found")]
    RouteDomainNotFound = 1,

    #[error("Integer overflow in fee calculation")]
    IntegerOverflow = 2,

    #[error("Unused account(s) provided")]
    ExtraneousAccount = 3,

    #[error("Invalid fee account PDA")]
    InvalidFeeAccountPda = 4,

    #[error("Invalid route domain PDA")]
    InvalidRouteDomainPda = 5,

    #[error("Account already initialized")]
    AlreadyInitialized = 6,

    #[error("Routing fee is not directly computable")]
    RoutingFeeNotDirectlyComputable = 7,

    #[error("Nested routing (routing -> routing) is not supported")]
    NestedRoutingNotSupported = 8,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
