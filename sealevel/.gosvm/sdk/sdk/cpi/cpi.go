// Package cpi provides bounded account-meta and PDA-signer builders.
package cpi

import (
	"gosvm/sdk/pda"
	"gosvm/solana"
)

const ErrMetas uint64 = 3002
const ErrSigners uint64 = 3003

// MaxMetas and MaxSigners match solana.Invoke: account metas per CPI
// (repeated accounts count) and PDA signer groups per CPI.
const (
	MaxMetas   = 64
	MaxSigners = 4
)

// InlineMetas records live in the builder itself. The first Add beyond them
// moves the records to one MaxMetas-record array on the invocation heap
// (576 bytes, allocated once), so CPIs of up to 16 metas keep the builder's
// small frame and zeroing cost and never allocate.
const InlineMetas = 16

type Metas struct {
	buffer [InlineMetas * 9]byte
	count  uint64
	wide   *[MaxMetas * 9]byte
}

func (m *Metas) Add(index uint64, writable, signer bool) uint64 {
	flags := byte(0)
	if writable {
		flags = flags | 1
	}
	if signer {
		flags = flags | 2
	}
	if m.count < InlineMetas {
		for j := uint64(0); j < 8; j++ {
			m.buffer[m.count*9+j] = byte(index >> (j * 8))
		}
		m.buffer[m.count*9+8] = flags
	} else if m.count < MaxMetas {
		if m.wide == nil {
			m.wide = new([MaxMetas * 9]byte)
			copy(m.wide[:], m.buffer[:])
		}
		for j := uint64(0); j < 8; j++ {
			m.wide[m.count*9+j] = byte(index >> (j * 8))
		}
		m.wide[m.count*9+8] = flags
	} else {
		return ErrMetas
	}
	m.count++
	return 0
}

// Bytes borrows the records: inline, or the heap array after the 17th Add.
// A Metas copied after its records moved shares that array.
func (m *Metas) Bytes() []byte {
	if m.count > InlineMetas {
		return m.wide[:m.count*9]
	}
	return m.buffer[:m.count*9]
}

type Signers struct {
	buffer [1024]byte
	used   uint64
	count  uint64
}

func (s *Signers) Add(seeds *pda.Seeds) uint64 {
	if seeds == nil || s.count >= MaxSigners || s.used > 1023 {
		return ErrSigners
	}
	b := seeds.Bytes()
	if uint64(len(b)) > 1023-s.used {
		return ErrSigners
	}
	for j := uint64(0); j < uint64(len(b)); j++ {
		s.buffer[1+s.used+j] = b[j]
	}
	s.used = s.used + uint64(len(b))
	s.count++
	s.buffer[0] = byte(s.count)
	return 0
}

func (s *Signers) Bytes() []byte { return s.buffer[:1+s.used] }

func Invoke(c solana.Context, program uint64, metas *Metas, data []byte, signers *Signers) uint64 {
	if metas == nil {
		return ErrMetas
	}
	if signers == nil {
		return solana.Invoke(c, program, metas.Bytes(), data, nil)
	}
	return solana.Invoke(c, program, metas.Bytes(), data, signers.Bytes())
}

// SingleSigner encodes one signer group directly, without a Seeds-to-Signers copy.
// It preserves the seed count/length/capacity checks of pda.Seeds. General
// Signers keeps its four-group/1024-byte checks.
// The borrowed encoding must remain alive and unmodified through InvokeSingle.
type SingleSigner struct {
	buffer [530]byte
	used   uint64
	count  uint64
}

func (s *SingleSigner) AddBytes(b []byte) uint64 {
	if s.count >= 16 || len(b) > 32 || s.used > 528 || uint64(len(b))+1 > 528-s.used {
		return pda.ErrSeeds
	}
	s.buffer[2+s.used] = byte(len(b))
	for j := uint64(0); j < uint64(len(b)); j++ {
		s.buffer[3+s.used+j] = b[j]
	}
	s.used = s.used + 1 + uint64(len(b))
	s.count++
	s.buffer[0] = 1
	s.buffer[1] = byte(s.count)
	return 0
}

func (s *SingleSigner) AddByte(value byte) uint64 {
	var b [1]byte
	b[0] = value
	return s.AddBytes(b[:])
}

// Bytes borrows the builder, including the group prefix even for an empty group.
func (s *SingleSigner) Bytes() []byte {
	s.buffer[0] = 1
	return s.buffer[:2+s.used]
}

func InvokeSingle(c solana.Context, program uint64, metas *Metas, data []byte, signer *SingleSigner) uint64 {
	if metas == nil {
		return ErrMetas
	}
	if signer == nil {
		return solana.Invoke(c, program, metas.Bytes(), data, nil)
	}
	return solana.Invoke(c, program, metas.Bytes(), data, signer.Bytes())
}
