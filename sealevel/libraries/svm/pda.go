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

// FindProgramAddress searches bumps 255..0 like Pubkey::find_program_address.
// Each attempt is one create_program_address syscall (1,500 CU), the same as
// the runtime's try_find_program_address.
//
// Stopgap until goSVM exposes sol_try_find_program_address directly.
func FindProgramAddress(c solana.Context, seeds [][]byte, program Pubkey) (Pubkey, uint8, uint64) {
	s, code := encodeSeeds(seeds, 255)
	if code != Success {
		return Pubkey{}, 0, code
	}
	var address Pubkey
	for b := 255; b >= 0; b-- {
		s.setBump(uint8(b))
		if solana.CreateAddress(c, s.group(), program[:], address[:]) == 0 {
			return address, uint8(b), Success
		}
	}
	return Pubkey{}, 0, InvalidSeeds
}

// FindProgramAddressSeeds is FindProgramAddress that also returns the signer
// seeds (with the found bump) for a following CPI.
func FindProgramAddressSeeds(c solana.Context, seeds [][]byte, program Pubkey) (Pubkey, Seeds, uint64) {
	s, code := encodeSeeds(seeds, 255)
	if code != Success {
		return Pubkey{}, s, code
	}
	var address Pubkey
	for b := 255; b >= 0; b-- {
		s.setBump(uint8(b))
		if solana.CreateAddress(c, s.group(), program[:], address[:]) == 0 {
			return address, s, Success
		}
	}
	return Pubkey{}, s, InvalidSeeds
}

// Bump returns the seeds' bump.
func (s *Seeds) Bump() uint8 { return s.buf[len(s.buf)-1] }
