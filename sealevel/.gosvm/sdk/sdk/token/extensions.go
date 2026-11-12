package token

import "gosvm/solana"

// ErrExtension reports an absent Token-2022 extension or an invalid value.
const ErrExtension uint64 = 3015

// Extension types read by this package (Token-2022 ExtensionType).
const (
	ExtensionTransferFeeConfig uint16 = 1
	ExtensionTransferFeeAmount uint16 = 2
	ExtensionImmutableOwner    uint16 = 7
	ExtensionMetadataPointer   uint16 = 18
)

// MintState is a decoded base mint. Unset optional authorities are zero.
type MintState struct {
	Authority    [32]byte
	HasAuthority bool
	Supply       uint64
	Decimals     byte
	Freeze       [32]byte
	HasFreeze    bool
}

// TransferFeeConfig is Token-2022's TransferFeeConfig extension. The older fee
// applies before NewerEpoch, the newer one from it.
type TransferFeeConfig struct {
	ConfigAuthority   [32]byte // zero when absent
	WithdrawAuthority [32]byte // zero when absent
	WithheldAmount    uint64
	OlderEpoch        uint64
	OlderMaximumFee   uint64
	OlderBasisPoints  uint16
	NewerEpoch        uint64
	NewerMaximumFee   uint64
	NewerBasisPoints  uint16
}

func readUint64(b []byte, offset uint64) uint64 {
	v := uint64(0)
	for j := uint64(0); j < 8; j++ {
		v = v | uint64(b[offset+j])<<(j*8)
	}
	return v
}

// option reports a canonical COption<Pubkey> tag at offset: 0 or 1, then
// three zero bytes.
func option(b []byte, offset uint64) bool {
	return b[offset] <= 1 && b[offset+1] == 0 && b[offset+2] == 0 && b[offset+3] == 0
}

// extended checks Token-2022's layout after a base state of size base bytes:
// zero padding to 165 bytes, accountType at byte 165, and TLV entries that fit
// the data. An Uninitialized (zero) type ends the entries.
func extended(data []byte, base uint64, accountType byte) bool {
	n := uint64(len(data))
	if n < 166 || n == 355 || data[165] != accountType {
		return false
	}
	for j := base; j < 165; j++ {
		if data[j] != 0 {
			return false
		}
	}
	offset := uint64(166)
	for offset+4 <= n {
		kind := uint64(data[offset]) | uint64(data[offset+1])<<8
		if kind == 0 {
			return true
		}
		length := uint64(data[offset+2]) | uint64(data[offset+3])<<8
		if length > n-offset-4 {
			return false
		}
		offset = offset + 4 + length
	}
	// Token-2022 ignores a single trailing byte, but a nonzero type without
	// room for its length is malformed.
	return n-offset < 2 || data[offset] == 0 && data[offset+1] == 0
}

// tokenOwner returns 1 for classic Token, 2 for Token-2022 and 0 otherwise,
// for a non-executable account at a valid index.
func tokenOwner(c solana.Context, index uint64) uint64 {
	if index >= solana.Count(c) || len(solana.Key(c, index)) != 32 || solana.Executable(c, index) {
		return 0
	}
	owner := solana.Owner(c, index)
	if equalKey(owner, ProgramID()) {
		return 1
	}
	if equalKey(owner, Program2022ID()) {
		return 2
	}
	return 0
}

// validMint checks an initialized mint owned by Token (exactly 82 bytes) or
// Token-2022 (82 bytes, or the extended layout with account type 1).
func validMint(c solana.Context, index uint64) bool {
	program := tokenOwner(c, index)
	if program == 0 {
		return false
	}
	data := solana.Data(c, index)
	if len(data) != 82 && (program == 1 || !extended(data, 82, 1)) {
		return false
	}
	return data[45] == 1 && option(data, 0) && option(data, 46)
}

// validAccount checks an initialized or frozen, non-native token account owned
// by Token (exactly 165 bytes) or Token-2022 (165 bytes, or the extended layout
// with account type 2).
func validAccount(c solana.Context, index uint64) bool {
	program := tokenOwner(c, index)
	if program == 0 {
		return false
	}
	data := solana.Data(c, index)
	if len(data) != 165 && (program == 1 || !extended(data, 165, 2)) {
		return false
	}
	return (data[108] == 1 || data[108] == 2) && option(data, 72) && option(data, 109) && data[109] == 0 && option(data, 129)
}

// ReadMint validates and decodes the current mint at index, owned by classic
// Token or Token-2022, including Token-2022 mints with extensions.
func ReadMint(c solana.Context, index uint64) (MintState, uint64) {
	var state MintState
	if !validMint(c, index) {
		return state, ErrMint
	}
	data := solana.Data(c, index)
	state.HasAuthority = data[0] == 1
	state.HasFreeze = data[46] == 1
	for j := uint64(0); j < 32; j++ {
		if state.HasAuthority {
			state.Authority[j] = data[4+j]
		}
		if state.HasFreeze {
			state.Freeze[j] = data[50+j]
		}
	}
	state.Supply = readUint64(data, 36)
	state.Decimals = data[44]
	return state, 0
}

// ReadAccount validates and decodes the current token account at index, owned
// by classic Token or Token-2022, including Token-2022 accounts with
// extensions such as ImmutableOwner or TransferFeeAmount. Wrapped native SOL
// accounts are rejected, as by Load.
func ReadAccount(c solana.Context, index uint64) (State, uint64) {
	var state State
	if !validAccount(c, index) {
		return state, ErrAccount
	}
	data := solana.Data(c, index)
	for j := uint64(0); j < 32; j++ {
		state.Mint[j] = data[j]
		state.Authority[j] = data[32+j]
	}
	state.Amount = readUint64(data, 64)
	state.Frozen = data[108] == 2
	return state, 0
}

// FindExtension validates a Token-2022 mint or token account and returns the
// data offset and length of the first extension of kind. An absent extension
// returns ErrExtension; an invalid account ErrAccount.
func FindExtension(c solana.Context, index uint64, kind uint16) (uint64, uint64, uint64) {
	if tokenOwner(c, index) != 2 || !validMint(c, index) && !validAccount(c, index) {
		return 0, 0, ErrAccount
	}
	data := solana.Data(c, index)
	n := uint64(len(data))
	offset := uint64(166)
	for kind != 0 && offset+4 <= n {
		found := uint64(data[offset]) | uint64(data[offset+1])<<8
		length := uint64(data[offset+2]) | uint64(data[offset+3])<<8
		if found == 0 {
			break
		}
		if found == uint64(kind) {
			return offset + 4, length, 0
		}
		offset = offset + 4 + length
	}
	return 0, 0, ErrExtension
}

// ReadTransferFeeConfig decodes the mint's TransferFeeConfig extension.
func ReadTransferFeeConfig(c solana.Context, mint uint64) (TransferFeeConfig, uint64) {
	var config TransferFeeConfig
	if !validMint(c, mint) {
		return config, ErrMint
	}
	offset, length, code := FindExtension(c, mint, ExtensionTransferFeeConfig)
	if code != 0 {
		return config, code
	}
	if length != 108 {
		return config, ErrExtension
	}
	data := solana.Data(c, mint)
	for j := uint64(0); j < 32; j++ {
		config.ConfigAuthority[j] = data[offset+j]
		config.WithdrawAuthority[j] = data[offset+32+j]
	}
	config.WithheldAmount = readUint64(data, offset+64)
	config.OlderEpoch = readUint64(data, offset+72)
	config.OlderMaximumFee = readUint64(data, offset+80)
	config.OlderBasisPoints = uint16(data[offset+88]) | uint16(data[offset+89])<<8
	config.NewerEpoch = readUint64(data, offset+90)
	config.NewerMaximumFee = readUint64(data, offset+98)
	config.NewerBasisPoints = uint16(data[offset+106]) | uint16(data[offset+107])<<8
	return config, 0
}

// Fee is Token-2022's transfer fee for a pre-fee amount in epoch:
// ceil(amount * basisPoints / 10000), capped at the maximum fee. A mint
// without TransferFeeConfig has no fee. Token-2022 rejects basis points above
// 10000; a quotient that overflows uint64 returns ErrExtension.
func Fee(c solana.Context, mint, epoch, amount uint64) (uint64, uint64) {
	if !validMint(c, mint) {
		return 0, ErrMint
	}
	if tokenOwner(c, mint) != 2 {
		return 0, 0
	}
	_, _, code := FindExtension(c, mint, ExtensionTransferFeeConfig)
	if code == ErrExtension {
		return 0, 0
	}
	config, status := ReadTransferFeeConfig(c, mint)
	if status != 0 {
		return 0, status
	}
	return config.Fee(epoch, amount)
}

// Fee applies the epoch's fee to a pre-fee amount.
func (config TransferFeeConfig) Fee(epoch, amount uint64) (uint64, uint64) {
	points, maximum := uint64(config.OlderBasisPoints), config.OlderMaximumFee
	if epoch >= config.NewerEpoch {
		points, maximum = uint64(config.NewerBasisPoints), config.NewerMaximumFee
	}
	if points == 0 || amount == 0 {
		return 0, 0
	}
	// amount*points+9999 as high*2^32 + low, then long division by 10000.
	low := (amount & 0xffffffff) * points
	high := (amount>>32)*points + low>>32
	low = (low & 0xffffffff) + 9999
	high = high + low>>32
	low = low & 0xffffffff
	quotientHigh := high / 10000
	quotientLow := (high%10000<<32 | low) / 10000
	if quotientHigh>>32 != 0 {
		return 0, ErrExtension
	}
	fee := quotientHigh<<32 | quotientLow
	if fee > maximum {
		fee = maximum
	}
	return fee, 0
}
