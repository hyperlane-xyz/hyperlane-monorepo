package fee

// Error is the fee program's custom error enum (ProgramError::Custom(n)).
const (
	ErrFeeComputationOverflow           uint64 = 1
	ErrNotLeafFeeData                   uint64 = 2
	ErrNotRoutingFeeData                uint64 = 3
	ErrNotCrossCollateralRoutingFeeData uint64 = 4
	ErrRouteNotFound                    uint64 = 5
	ErrTransientPdaMismatch             uint64 = 6
	ErrInvalidTransientData             uint64 = 7
	ErrStandingQuoteAmountNotWildcard   uint64 = 8
	ErrInvalidStandingQuoteContext      uint64 = 9
	ErrInvalidStandingQuoteData         uint64 = 10
	ErrZeroTargetRouterNotAllowed       uint64 = 11
	ErrInvalidRouteDomain               uint64 = 12
	ErrOffchainQuotingNotConfigured     uint64 = 13
	ErrWildcardSignersNotApplicable     uint64 = 14
	ErrMinIssuedAtMustBeMonotonic       uint64 = 15
	ErrCurveVariantMismatch             uint64 = 16
	ErrZeroFeeParams                    uint64 = 17
	ErrInvalidTransientSlot             uint64 = 18
)
