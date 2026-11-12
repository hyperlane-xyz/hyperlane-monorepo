package svm

import "gosvm/solana"

// MaxSeeds and MaxSeedLen are Solana's PDA limits (the bump is one more seed).
const (
	MaxSeeds   = 16
	MaxSeedLen = 32
)

// Seeds is one PDA signer: the encoded seed list plus bump, laid out as goSVM's
// CPI signer encoding [groups=1][count][len][bytes]...[1][bump]. It is built
// once into an exact-size buffer; large fixed builders (pda.Seeds,
// cpi.Signers) cost thousands of CU to zero and copy.
type Seeds struct {
	buf []byte
}

func encodeSeeds(seeds [][]byte, bump uint8) (Seeds, uint64) {
	if len(seeds) >= MaxSeeds {
		return Seeds{}, MaxSeedLengthExceeded
	}
	n := 2 + 2
	for i := range seeds {
		if len(seeds[i]) > MaxSeedLen {
			return Seeds{}, MaxSeedLengthExceeded
		}
		n += 1 + len(seeds[i])
	}
	buf := make([]byte, n)
	buf[0] = 1
	buf[1] = byte(len(seeds) + 1)
	off := 2
	for i := range seeds {
		buf[off] = byte(len(seeds[i]))
		copy(buf[off+1:], seeds[i])
		off += 1 + len(seeds[i])
	}
	buf[off] = 1
	buf[off+1] = bump
	return Seeds{buf: buf}, Success
}

// NewSeeds encodes seeds plus bump for CPI signing.
func NewSeeds(seeds [][]byte, bump uint8) (Seeds, uint64) { return encodeSeeds(seeds, bump) }

// SignerBytes is the encoding cpi/solana.Invoke expects for one signer.
func (s *Seeds) SignerBytes() []byte { return s.buf }

// group is the seed group CreateAddress expects.
func (s *Seeds) group() []byte { return s.buf[1:] }

func (s *Seeds) setBump(bump uint8) { s.buf[len(s.buf)-1] = bump }

// Address derives the PDA for these seeds under program. An on-curve result
// is InvalidSeeds.
func (s *Seeds) Address(c solana.Context, program Pubkey) (Pubkey, uint64) {
	var address Pubkey
	if solana.CreateAddress(c, s.group(), program[:], address[:]) != 0 {
		return address, InvalidSeeds
	}
	return address, Success
}

// CreateProgramAddress is Pubkey::create_program_address(seeds ++ [bump]).
func CreateProgramAddress(c solana.Context, seeds [][]byte, bump uint8, program Pubkey) (Pubkey, uint64) {
	s, code := encodeSeeds(seeds, bump)
	if code != Success {
		return Pubkey{}, code
	}
	return s.Address(c, program)
}

// FindProgramAddress is Pubkey::find_program_address: one
// sol_try_find_program_address syscall (solana.FindAddress) tries bumps 255
// down to 1 at 1,500 CU each, as in Rust.
func FindProgramAddress(c solana.Context, seeds [][]byte, program Pubkey) (Pubkey, uint8, uint64) {
	address, s, code := FindProgramAddressSeeds(c, seeds, program)
	if code != Success {
		return Pubkey{}, 0, code
	}
	return address, s.Bump(), Success
}

// FindProgramAddressSeeds is FindProgramAddress that also returns the signer
// seeds (with the found bump) for a following CPI.
func FindProgramAddressSeeds(c solana.Context, seeds [][]byte, program Pubkey) (Pubkey, Seeds, uint64) {
	s, code := encodeSeeds(seeds, 255)
	if code != Success {
		return Pubkey{}, s, code
	}
	// The group without the trailing bump seed: [count][len][bytes]...
	group := s.buf[1 : len(s.buf)-2]
	group[0]--
	var out [33]byte
	found := solana.FindAddress(c, group, program[:], out[:])
	group[0]++
	if found != 0 {
		return Pubkey{}, s, InvalidSeeds
	}
	var address Pubkey
	copy(address[:], out[:32])
	s.setBump(out[32])
	return address, s, Success
}

// Bump returns the seeds' bump.
func (s *Seeds) Bump() uint8 { return s.buf[len(s.buf)-1] }
