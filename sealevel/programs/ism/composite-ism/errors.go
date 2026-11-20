package compositeism

// error::Error, returned as ProgramError::Custom(n).
const (
	ErrProgramIDNotOwner          uint64 = 1
	ErrAccountNotInitialized      uint64 = 2
	ErrAlreadyInitialized         uint64 = 3
	ErrConfigNotSet               uint64 = 4
	ErrInvalidMetadata            uint64 = 5
	ErrInvalidSignature           uint64 = 6
	ErrThresholdNotMet            uint64 = 7
	ErrNoRouteForDomain           uint64 = 8
	ErrInvalidRelayer             uint64 = 9
	ErrRelayerNotSigner           uint64 = 10
	ErrVerifyRejected             uint64 = 11
	ErrInvalidConfig              uint64 = 12
	ErrInvalidMessageBody         uint64 = 13
	ErrRateLimitExceeded          uint64 = 14
	ErrRecipientMismatch          uint64 = 15
	ErrMultipleRoutingNodes       uint64 = 16
	ErrRoutingInDomainIsm         uint64 = 17
	ErrDomainPdaNotWritable       uint64 = 18
	ErrInvalidSystemProgram       uint64 = 19
	ErrInvalidStoragePda          uint64 = 20
	ErrInvalidDomainPda           uint64 = 21
	ErrFallbackRoutingInDomainIsm uint64 = 22
	ErrInvalidFallbackIsmAccount  uint64 = 23
	ErrFallbackIsmCallFailed      uint64 = 24
	ErrFallbackRoutingNotLast     uint64 = 25
	ErrInvalidProcessAuthority    uint64 = 26
	ErrProcessAuthorityNotSigner  uint64 = 27
	ErrPausableInDomainIsm        uint64 = 28
	ErrInvalidProgramDataAccount  uint64 = 29
)
