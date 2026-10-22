// Package keccaktest is a reference Keccak-256 and a native solana.Context
// using it, for host tests only. Programs never import it.
package keccaktest

import (
	"math/bits"

	"gosvm/solana"
)

// Keccak256 is a reference Keccak-256 (rate 136, 0x01 padding).
func Keccak256(data []byte) []byte {
	rc := [24]uint64{0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000, 0x000000000000808b,
		0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008a, 0x0000000000000088, 0x0000000080008009,
		0x000000008000000a, 0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002,
		0x8000000000000080, 0x000000000000800a, 0x800000008000000a, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001,
		0x8000000080008008}
	rot := [25]int{0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14}
	var a [25]uint64
	permute := func() {
		for round := 0; round < 24; round++ {
			var c, d [5]uint64
			for x := 0; x < 5; x++ {
				c[x] = a[x] ^ a[x+5] ^ a[x+10] ^ a[x+15] ^ a[x+20]
			}
			for x := 0; x < 5; x++ {
				d[x] = c[(x+4)%5] ^ bits.RotateLeft64(c[(x+1)%5], 1)
			}
			var b [25]uint64
			for x := 0; x < 5; x++ {
				for y := 0; y < 5; y++ {
					b[y+5*((2*x+3*y)%5)] = bits.RotateLeft64(a[x+5*y]^d[x], rot[x+5*y])
				}
			}
			for i := 0; i < 25; i++ {
				a[i] = b[i] ^ (^b[(i%5+1)%5+5*(i/5)] & b[(i%5+2)%5+5*(i/5)])
			}
			a[0] ^= rc[round]
		}
	}
	padded := append(append([]byte(nil), data...), 0x01)
	for len(padded)%136 != 0 {
		padded = append(padded, 0)
	}
	padded[len(padded)-1] |= 0x80
	for off := 0; off < len(padded); off += 136 {
		for i := 0; i < 17; i++ {
			for j := 0; j < 8; j++ {
				a[i] ^= uint64(padded[off+i*8+j]) << (8 * j)
			}
		}
		permute()
	}
	out := make([]byte, 32)
	for i := 0; i < 32; i++ {
		out[i] = byte(a[i/8] >> (8 * (i % 8)))
	}
	return out
}

// Context returns a native context whose Keccak callback is Keccak256.
func Context() solana.Context {
	return solana.Context{Keccak: Keccak256}
}
