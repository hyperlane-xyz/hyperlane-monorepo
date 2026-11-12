// Package svm holds the Solana runtime conventions every Hyperlane Go port
// shares: ProgramError codes, account iteration, PDA derivation and System
// program instructions.
package svm

// A program's u64 result is passed to the runtime unchanged. Values with the
// upper 32 bits set are builtin ProgramErrors; values below 2^32 are
// ProgramError::Custom(n). These match solana-program-error 3.0.0.
const (
	Success uint64 = 0

	CustomZero                         uint64 = 1 << 32
	InvalidArgument                    uint64 = 2 << 32
	InvalidInstructionData             uint64 = 3 << 32
	InvalidAccountData                 uint64 = 4 << 32
	AccountDataTooSmall                uint64 = 5 << 32
	InsufficientFunds                  uint64 = 6 << 32
	IncorrectProgramID                 uint64 = 7 << 32
	MissingRequiredSignature           uint64 = 8 << 32
	AccountAlreadyInitialized          uint64 = 9 << 32
	UninitializedAccount               uint64 = 10 << 32
	NotEnoughAccountKeys               uint64 = 11 << 32
	AccountBorrowFailed                uint64 = 12 << 32
	MaxSeedLengthExceeded              uint64 = 13 << 32
	InvalidSeeds                       uint64 = 14 << 32
	BorshIoError                       uint64 = 15 << 32
	AccountNotRentExempt               uint64 = 16 << 32
	UnsupportedSysvar                  uint64 = 17 << 32
	IllegalOwner                       uint64 = 18 << 32
	MaxAccountsDataAllocationsExceeded uint64 = 19 << 32
	InvalidRealloc                     uint64 = 20 << 32
	MaxInstructionTraceLengthExceeded  uint64 = 21 << 32
	BuiltinProgramsMustConsumeCU       uint64 = 22 << 32
	InvalidAccountOwner                uint64 = 23 << 32
	ArithmeticOverflow                 uint64 = 24 << 32
	Immutable                          uint64 = 25 << 32
	IncorrectAuthority                 uint64 = 26 << 32
)

// Custom returns the code for ProgramError::Custom(n).
func Custom(n uint32) uint64 {
	if n == 0 {
		return CustomZero
	}
	return uint64(n)
}
