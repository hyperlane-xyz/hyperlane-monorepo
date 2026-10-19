package igp

// error::Error (ProgramError::Custom).
const (
	ErrNoGasOracleSetForDestinationDomain uint64 = 1
	ErrQuoteConfigNotSet                  uint64 = 2
	ErrInvalidIgpQuoteContext             uint64 = 3
	ErrInvalidIgpQuoteData                uint64 = 4
	ErrNonDefaultFeeTokenMint             uint64 = 5
	ErrStandingQuoteNotExpired            uint64 = 6
	ErrBeneficiaryMismatch                uint64 = 7
)
