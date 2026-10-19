package svm

import (
	"gosvm/sdk/system"
	"gosvm/solana"
)

// System program instruction indices (solana-system-interface).
const (
	systemCreateAccount uint32 = 0
	systemAssign        uint32 = 1
	systemTransfer      uint32 = 2
	systemAllocate      uint32 = 8
)

func putU32(b []byte, v uint32) {
	for i := 0; i < 4; i++ {
		b[i] = byte(v >> (8 * uint32(i)))
	}
}

func putU64(b []byte, v uint64) {
	for i := 0; i < 8; i++ {
		b[i] = byte(v >> (8 * uint64(i)))
	}
}

// CreateAccountData encodes SystemInstruction::CreateAccount.
func CreateAccountData(lamports, space uint64, owner Pubkey) [52]byte {
	var d [52]byte
	putU32(d[0:4], systemCreateAccount)
	putU64(d[4:12], lamports)
	putU64(d[12:20], space)
	copy(d[20:52], owner[:])
	return d
}

// AssignData encodes SystemInstruction::Assign.
func AssignData(owner Pubkey) [36]byte {
	var d [36]byte
	putU32(d[0:4], systemAssign)
	copy(d[4:36], owner[:])
	return d
}

// TransferData encodes SystemInstruction::Transfer.
func TransferData(lamports uint64) [12]byte {
	var d [12]byte
	putU32(d[0:4], systemTransfer)
	putU64(d[4:12], lamports)
	return d
}

// AllocateData encodes SystemInstruction::Allocate.
func AllocateData(space uint64) [12]byte {
	var d [12]byte
	putU32(d[0:4], systemAllocate)
	putU64(d[4:12], space)
	return d
}

// MaxCPIMetas is goSVM's per-CPI account meta limit (integration 2).
const MaxCPIMetas = 64

// Metas are CPI account metas in goSVM's encoding: index u64 LE, flags
// (writable=1, signer=2). At most MaxCPIMetas; the token programs' widest
// CPI is a quoted overhead-IGP PayForGas with 22.
type Metas struct {
	buf [MaxCPIMetas * 9]byte
	n   int
}

// Add appends account index with the given privileges.
func (m *Metas) Add(index uint64, writable, signer bool) {
	off := m.n * 9
	putU64(m.buf[off:off+8], index)
	flags := byte(0)
	if writable {
		flags |= 1
	}
	if signer {
		flags |= 2
	}
	m.buf[off+8] = flags
	m.n++
}

// Bytes returns the encoded metas.
func (m *Metas) Bytes() []byte { return m.buf[:m.n*9] }

// Invoke CPIs program (an account index) with metas and data, signing with
// seeds when non-nil. A callee failure aborts the transaction with the
// callee's error, as in Rust.
func Invoke(c solana.Context, program uint64, metas *Metas, data []byte, seeds *Seeds) uint64 {
	if seeds == nil {
		return solana.Invoke(c, program, metas.Bytes(), data, nil)
	}
	return solana.Invoke(c, program, metas.Bytes(), data, seeds.SignerBytes())
}

// SystemTransfer CPIs SystemInstruction::Transfer from `from` (a signer, or a
// PDA signed with seeds) to `to`.
func SystemTransfer(c solana.Context, systemProgram, from, to uint64, lamports uint64, seeds *Seeds) uint64 {
	var metas Metas
	metas.Add(from, true, true)
	metas.Add(to, true, false)
	d := TransferData(lamports)
	return Invoke(c, systemProgram, &metas, d[:], seeds)
}

// SystemAllocate CPIs SystemInstruction::Allocate for account (signed by seeds).
func SystemAllocate(c solana.Context, systemProgram, account uint64, space uint64, seeds *Seeds) uint64 {
	var metas Metas
	metas.Add(account, true, true)
	d := AllocateData(space)
	return Invoke(c, systemProgram, &metas, d[:], seeds)
}

// SystemAssign CPIs SystemInstruction::Assign for account (signed by seeds).
func SystemAssign(c solana.Context, systemProgram, account uint64, owner Pubkey, seeds *Seeds) uint64 {
	var metas Metas
	metas.Add(account, true, true)
	d := AssignData(owner)
	return Invoke(c, systemProgram, &metas, d[:], seeds)
}

// SystemCreateAccount CPIs SystemInstruction::CreateAccount; the new account
// signs with seeds when it is a PDA.
func SystemCreateAccount(c solana.Context, systemProgram, payer, account uint64, lamports, space uint64, owner Pubkey, seeds *Seeds) uint64 {
	var metas Metas
	metas.Add(payer, true, true)
	metas.Add(account, true, true)
	d := CreateAccountData(lamports, space, owner)
	return Invoke(c, systemProgram, &metas, d[:], seeds)
}

// f64 bits of the exemption thresholds with an exact fast path: 2.0 (Solana
// before SIMD-0194, Fogo) and 1.0 (after it, with twice the rate).
const (
	thresholdTwo uint64 = 0x4000000000000000
	thresholdOne uint64 = 0x3ff0000000000000
)

// MinimumBalance returns Rent::minimum_balance(size) from the Rent sysvar.
//
// With a threshold of 2.0 or 1.0 and n = (128 + size) * rate below 2^53, the
// f64 product is exact, so the result is 2n or n. That skips the SDK's
// software f64 multiply (~1,000 CU); anything else takes the SDK path.
func MinimumBalance(c solana.Context, size uint64) (uint64, uint64) {
	var rent [17]byte
	if solana.Rent(c, rent[:]) != 0 {
		return 0, UnsupportedSysvar
	}
	rate, threshold := le64(rent[0:8]), le64(rent[8:16])
	if (threshold == thresholdTwo || threshold == thresholdOne) && size <= system.MaxDataLen && rate <= (1<<53)/(128+size) {
		if n := (128 + size) * rate; n < 1<<53 {
			if threshold == thresholdTwo {
				return 2 * n, Success
			}
			return n, Success
		}
	}
	lamports, code := system.MinimumBalanceFor(rate, threshold, size)
	if code != 0 {
		return 0, UnsupportedSysvar
	}
	return lamports, Success
}
