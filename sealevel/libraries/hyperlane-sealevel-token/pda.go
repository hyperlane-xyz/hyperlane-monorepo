package tokenlib

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// StaticPDA is a PDA whose seeds are constants. Its CPI signer encoding
// ([1][count][len][seed]...[1][bump]) is built once, at initialization
// (which goSVM evaluates at compile time), so deriving the address or
// signing costs one bump write instead of re-encoding every seed (about
// 700 CU each time for the token PDA's five seeds).
type StaticPDA struct {
	buf []byte
}

// NewStaticPDA encodes seeds (without the bump).
func NewStaticPDA(seeds [][]byte) StaticPDA {
	s, code := svm.NewSeeds(seeds, 0)
	if code != svm.Success {
		panic("tokenlib: invalid static PDA seeds")
	}
	b := s.SignerBytes()
	buf := make([]byte, len(b))
	copy(buf, b)
	return StaticPDA{buf: buf}
}

// Signer returns the CPI signer bytes for bump. The slice is shared: use it
// before the next call on the same StaticPDA.
func (s *StaticPDA) Signer(bump uint8) []byte {
	s.buf[len(s.buf)-1] = bump
	return s.buf
}

// Address is create_program_address(seeds ++ [bump], program); an on-curve
// result is InvalidSeeds.
func (s *StaticPDA) Address(c solana.Context, bump uint8, program *svm.Pubkey) (svm.Pubkey, uint64) {
	var address svm.Pubkey
	group := s.Signer(bump)[1:]
	if solana.CreateAddress(c, group, program[:], address[:]) != 0 {
		return address, svm.InvalidSeeds
	}
	return address, svm.Success
}

// Verify checks account i is the PDA for bump (InvalidArgument otherwise)
// and returns its signer bytes.
func (s *StaticPDA) Verify(c solana.Context, i uint64, bump uint8, program *svm.Pubkey) ([]byte, uint64) {
	key, code := s.Address(c, bump, program)
	if code != svm.Success {
		return nil, code
	}
	if !KeyEq(c, i, &key) {
		return nil, svm.InvalidArgument
	}
	return s.buf, svm.Success
}

// Find is find_program_address: one sol_try_find_program_address syscall
// (solana.FindAddress) tries bumps 255..1 at 1,500 CU each.
func (s *StaticPDA) Find(c solana.Context, program *svm.Pubkey) (svm.Pubkey, uint8, uint64) {
	// The seed group without the trailing bump seed: [count][len][bytes]...
	group := s.buf[1 : len(s.buf)-2]
	group[0]--
	var out [33]byte
	code := solana.FindAddress(c, group, program[:], out[:])
	group[0]++
	if code != 0 {
		return svm.Pubkey{}, 0, svm.InvalidSeeds
	}
	var address svm.Pubkey
	copy(address[:], out[:32])
	return address, out[32], svm.Success
}

// Static PDAs of the token library.
var (
	TokenPDA             = NewStaticPDA(TokenPDASeeds)
	DispatchAuthorityPDA = NewStaticPDA(MailboxDispatchAuthorityPDASeeds)
	IgpQuoteAuthorityPDA = NewStaticPDA(IgpQuoteAuthorityPDASeeds)
	MailboxOutboxPDA     = NewStaticPDA(MailboxOutboxPDASeeds)
)

// InvokeSigned CPIs with raw signer bytes (nil for none).
func InvokeSigned(c solana.Context, program uint64, metas *svm.Metas, data []byte, signer []byte) uint64 {
	return solana.Invoke(c, program, metas.Bytes(), data, signer)
}

// KeyEq reports whether account i's key is *k. Unlike svm.KeyIs it copies
// no 32-byte arrays: goSVM copies unaligned arrays byte by byte.
func KeyEq(c solana.Context, i uint64, k *svm.Pubkey) bool {
	b := solana.Key(c, i)
	for j := 0; j < 32; j++ {
		if b[j] != k[j] {
			return false
		}
	}
	return true
}

// OwnerEq reports whether account i is owned by *k, without copies.
func OwnerEq(c solana.Context, i uint64, k *svm.Pubkey) bool {
	b := solana.Owner(c, i)
	for j := 0; j < 32; j++ {
		if b[j] != k[j] {
			return false
		}
	}
	return true
}
