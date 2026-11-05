// Package ism is a test-only ISM: Verify succeeds when the metadata is
// empty or its first byte is 1, and fails with Custom(1) otherwise.
package ism

import "gosvm/solana"

const verifyDiscriminator = "\xf3\x35\xd6\x00\xd0\x12\xe7\x43"

func Process(c solana.Context) uint64 {
	ix := solana.Instruction(c)
	if len(ix) < 12 || string(ix[:8]) != verifyDiscriminator {
		return 2
	}
	n := uint64(ix[8]) | uint64(ix[9])<<8 | uint64(ix[10])<<16 | uint64(ix[11])<<24
	if n > 0 && (uint64(len(ix)) < 13 || ix[12] != 1) {
		return 1
	}
	return 0
}
