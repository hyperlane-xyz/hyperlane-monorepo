// Package pda provides bounded PDA seeds with explicit byte/scalar encoding.
package pda

import "gosvm/solana"

const ErrSeeds uint64 = 3001

type Seeds struct {
	buffer [529]byte
	used   uint64
	count  uint64
}

func (s *Seeds) AddBytes(b []byte) uint64 {
	if s.count >= 16 || len(b) > 32 || s.used > 528 || uint64(len(b))+1 > 528-s.used {
		return ErrSeeds
	}
	s.buffer[1+s.used] = byte(len(b))
	for j := uint64(0); j < uint64(len(b)); j++ {
		s.buffer[2+s.used+j] = b[j]
	}
	s.used = s.used + 1 + uint64(len(b))
	s.count++
	s.buffer[0] = byte(s.count)
	return 0
}

func (s *Seeds) AddKey(key [32]byte) uint64 { return s.AddBytes(key[:]) }
func (s *Seeds) AddByte(value byte) uint64  { var b [1]byte; b[0] = value; return s.AddBytes(b[:]) }
func (s *Seeds) AddUint32(value uint32) uint64 {
	var b [4]byte
	for j := uint64(0); j < 4; j++ {
		b[j] = byte(value >> (j * 8))
	}
	return s.AddBytes(b[:])
}
func (s *Seeds) AddUint64(value uint64) uint64 {
	var b [8]byte
	for j := uint64(0); j < 8; j++ {
		b[j] = byte(value >> (j * 8))
	}
	return s.AddBytes(b[:])
}

// Bytes borrows the builder; it must not outlive its backing Seeds value.
func (s *Seeds) Bytes() []byte { return s.buffer[:1+s.used] }

func (s *Seeds) Address(c solana.Context, program [32]byte) ([32]byte, uint64) {
	var address [32]byte
	code := solana.CreateAddress(c, s.Bytes(), program[:], address[:])
	return address, code
}

func (s *Seeds) Matches(c solana.Context, index uint64, program [32]byte) (bool, uint64) {
	if index >= solana.Count(c) {
		return false, 2005
	}
	key := solana.Key(c, index)
	if len(key) != 32 {
		return false, 2005
	}
	address, code := s.Address(c, program)
	if code != 0 {
		return false, code
	}
	for j := uint64(0); j < 32; j++ {
		if key[j] != address[j] {
			return false, 0
		}
	}
	return true, 0
}
