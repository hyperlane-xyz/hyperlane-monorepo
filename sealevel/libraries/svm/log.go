package svm

import (
	"math/bits"

	"gosvm/solana"
)

// Msg builds one msg! line. Programs append the same text and value formats
// as the Rust format string, then Emit it with solana.Log ("Program log: "
// plus the line). Off-chain tooling may parse these lines, so the formats
// match Rust's exactly:
//
//   - Dec / U32 / I64: `{}` of an integer.
//   - Pubkey: `{}` and `{:?}` of a Pubkey (base58).
//   - H256 / H160: `{:?}` of an H256 / H160 (0x and every byte in hex).
//   - H256Short / H160Short: `{}` of an H256 / H160 (0x, the first and last
//     two bytes in hex, joined by "…").
type Msg struct {
	b []byte
}

// NewMsg starts a line with s.
func NewMsg(s string) Msg {
	b := make([]byte, 0, 128)
	return Msg{b: append(b, s...)}
}

// Str appends s.
func (m *Msg) Str(s string) { m.b = append(m.b, s...) }

// Dec appends v in decimal.
func (m *Msg) Dec(v uint64) {
	var d [20]byte
	n := len(d)
	for {
		n--
		d[n] = byte('0' + v%10)
		v /= 10
		if v == 0 {
			break
		}
	}
	m.b = append(m.b, d[n:]...)
}

// U256 appends a little-endian [4]uint64 U256 in decimal.
func (m *Msg) U256(v *[4]uint64) {
	if v[1]|v[2]|v[3] == 0 {
		m.Dec(v[0])
		return
	}
	// Divide by 10^19 repeatedly; each remainder is 19 decimal digits.
	const chunk = uint64(10000000000000000000)
	q := *v
	var parts [5]uint64
	n := 0
	for q[0]|q[1]|q[2]|q[3] != 0 {
		var rem uint64
		for i := 3; i >= 0; i-- {
			q[i], rem = bits.Div64(rem, q[i], chunk)
		}
		parts[n] = rem
		n++
	}
	m.Dec(parts[n-1])
	for i := n - 2; i >= 0; i-- {
		var d [19]byte
		x := parts[i]
		for j := 18; j >= 0; j-- {
			d[j] = byte('0' + x%10)
			x /= 10
		}
		m.b = append(m.b, d[:]...)
	}
}

// U32 appends v in decimal.
func (m *Msg) U32(v uint32) { m.Dec(uint64(v)) }

// I64 appends v in decimal.
func (m *Msg) I64(v int64) {
	if v < 0 {
		m.b = append(m.b, '-')
		m.Dec(uint64(-(v + 1)) + 1)
		return
	}
	m.Dec(uint64(v))
}

// Bool appends true or false.
func (m *Msg) Bool(v bool) {
	if v {
		m.Str("true")
		return
	}
	m.Str("false")
}

const hexDigits = "0123456789abcdef"

func (m *Msg) hexBytes(b []byte) {
	for i := 0; i < len(b); i++ {
		m.b = append(m.b, hexDigits[b[i]>>4], hexDigits[b[i]&15])
	}
}

// H256 appends `{:?}` of an H256: 0x and 64 hex digits.
func (m *Msg) H256(k *[32]byte) {
	m.Str("0x")
	m.hexBytes(k[:])
}

// H160 appends `{:?}` of an H160: 0x and 40 hex digits.
func (m *Msg) H160(k *[20]byte) {
	m.Str("0x")
	m.hexBytes(k[:])
}

func (m *Msg) short(b []byte) {
	m.Str("0x")
	m.hexBytes(b[:2])
	m.Str("…")
	m.hexBytes(b[len(b)-2:])
}

// H256Short appends `{}` of an H256 (fixed-hash Display), e.g. 0x1234…cdef.
func (m *Msg) H256Short(k *[32]byte) { m.short(k[:]) }

// H160Short appends `{}` of an H160, e.g. 0x1234…cdef.
func (m *Msg) H160Short(k *[20]byte) { m.short(k[:]) }

// 58^5 fits in 32 bits, so a limb times 2^32 plus a carry fits in a u64.
const b58Limb = 58 * 58 * 58 * 58 * 58

const b58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// Pubkey appends a 32-byte key in base58, as Pubkey's Display and Debug do.
func (m *Msg) Pubkey(k *[32]byte) {
	// Little-endian base-58^5 limbs; 32 bytes need at most 44 digits, 9 limbs.
	var limbs [9]uint64
	n := 0
	for i := 0; i < 32; i += 4 {
		carry := uint64(k[i])<<24 | uint64(k[i+1])<<16 | uint64(k[i+2])<<8 | uint64(k[i+3])
		for j := 0; j < n; j++ {
			carry += limbs[j] << 32
			limbs[j] = carry % b58Limb
			carry /= b58Limb
		}
		for carry > 0 {
			limbs[n] = carry % b58Limb
			carry /= b58Limb
			n++
		}
	}
	var digits [45]byte
	d := 0
	for j := 0; j < n; j++ {
		v := limbs[j]
		for t := 0; t < 5; t++ {
			digits[d] = byte(v % 58)
			v /= 58
			d++
		}
	}
	for d > 0 && digits[d-1] == 0 {
		d--
	}
	for i := 0; i < 32 && k[i] == 0; i++ {
		m.b = append(m.b, '1')
	}
	for j := d - 1; j >= 0; j-- {
		m.b = append(m.b, b58Alphabet[digits[j]])
	}
}

// Key appends a 32-byte key slice (e.g. solana.Key) in base58.
func (m *Msg) Key(b []byte) {
	var k [32]byte
	copy(k[:], b)
	m.Pubkey(&k)
}

// OptionPubkey appends `{:?}` of an Option<Pubkey>: Some(<base58>) or None.
func (m *Msg) OptionPubkey(some bool, k *[32]byte) {
	if !some {
		m.Str("None")
		return
	}
	m.Str("Some(")
	m.Pubkey(k)
	m.Str(")")
}

// OptionH256 appends `{:?}` of an Option<H256>.
func (m *Msg) OptionH256(some bool, k *[32]byte) {
	if !some {
		m.Str("None")
		return
	}
	m.Str("Some(")
	m.H256(k)
	m.Str(")")
}

// OptionDec appends `{:?}` of an Option of an unsigned integer.
func (m *Msg) OptionDec(some bool, v uint64) {
	if !some {
		m.Str("None")
		return
	}
	m.Str("Some(")
	m.Dec(v)
	m.Str(")")
}

// Emit logs the line.
func (m *Msg) Emit(c solana.Context) { solana.Log(c, string(m.b)) }

// Log logs a constant line.
func Log(c solana.Context, s string) { solana.Log(c, s) }

// LogProgramError logs `{}` of the ProgramError that code encodes, as the
// Rust programs' msg!("{}", err) does before returning it.
func LogProgramError(c solana.Context, code uint64) {
	if code>>32 == 0 || code == CustomZero {
		m := NewMsg("Custom program error: 0x")
		v := code & 0xffffffff
		var d [8]byte
		n := len(d)
		for {
			n--
			d[n] = hexDigits[v&15]
			v >>= 4
			if v == 0 {
				break
			}
		}
		m.b = append(m.b, d[n:]...)
		m.Emit(c)
		return
	}
	solana.Log(c, programErrorText(code))
}

// LogError logs a non-zero code with LogProgramError and returns it: the
// Rust processors' .map_err(|err| { msg!("{}", err); err }).
func LogError(c solana.Context, code uint64) uint64 {
	if code != Success {
		LogProgramError(c, code)
	}
	return code
}

func programErrorText(code uint64) string {
	switch code {
	case InvalidArgument:
		return "The arguments provided to a program instruction were invalid"
	case InvalidInstructionData:
		return "An instruction's data contents was invalid"
	case InvalidAccountData:
		return "An account's data contents was invalid"
	case AccountDataTooSmall:
		return "An account's data was too small"
	case InsufficientFunds:
		return "An account's balance was too small to complete the instruction"
	case IncorrectProgramID:
		return "The account did not have the expected program id"
	case MissingRequiredSignature:
		return "A signature was required but not found"
	case AccountAlreadyInitialized:
		return "An initialize instruction was sent to an account that has already been initialized"
	case UninitializedAccount:
		return "An attempt to operate on an account that hasn't been initialized"
	case NotEnoughAccountKeys:
		return "The instruction expected additional account keys"
	case AccountBorrowFailed:
		return "Failed to borrow a reference to account data, already borrowed"
	case MaxSeedLengthExceeded:
		return "Length of the seed is too long for address generation"
	case InvalidSeeds:
		return "Provided seeds do not result in a valid address"
	case BorshIoError:
		return "IO Error"
	case AccountNotRentExempt:
		return "An account does not have enough lamports to be rent-exempt"
	case UnsupportedSysvar:
		return "Unsupported sysvar"
	case IllegalOwner:
		return "Provided owner is not allowed"
	case MaxAccountsDataAllocationsExceeded:
		return "Accounts data allocations exceeded the maximum allowed per transaction"
	case InvalidRealloc:
		return "Account data reallocation was invalid"
	case MaxInstructionTraceLengthExceeded:
		return "Instruction trace length exceeded the maximum allowed per transaction"
	case BuiltinProgramsMustConsumeCU:
		return "Builtin programs must consume compute units"
	case InvalidAccountOwner:
		return "Invalid account owner"
	case ArithmeticOverflow:
		return "Program arithmetic overflowed"
	case Immutable:
		return "Account is immutable"
	case IncorrectAuthority:
		return "Incorrect authority provided"
	}
	// Not a ProgramError (e.g. a goSVM SDK status): Rust never returns it.
	return "Unknown program error"
}
