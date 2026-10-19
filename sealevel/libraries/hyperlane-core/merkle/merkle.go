// Package merkle ports hyperlane-core's accumulator::incremental::IncrementalMerkle over its Borsh layout:
// branch [32][32]byte then count as u64le, 1,032 bytes. Functions operate on
// a tree view, usually a subslice of account data, without copying it.
package merkle

import (
	"math/bits"

	"gosvm/solana"
)

const (
	Depth    = 32
	Size     = Depth*32 + 8
	offCount = Depth * 32
)

// ErrFull is returned when the tree already holds u32::MAX - 1 leaves; the
// Rust implementation panics there.
const ErrFull uint64 = 1

// Count is the number of ingested leaves.
func Count(tree []byte) uint64 {
	v := uint64(0)
	for j := uint64(0); j < 8; j++ {
		v = v | uint64(tree[offCount+j])<<(j*8)
	}
	return v
}

func setCount(tree []byte, v uint64) {
	for j := uint64(0); j < 8; j++ {
		tree[offCount+j] = byte(v >> (j * 8))
	}
}

// Init writes the default tree: each branch entry is ZERO_HASHES[i], count 0.
func Init(tree []byte) {
	copy(tree[:Depth*32], zeroHashes[:Depth*32])
	setCount(tree, 0)
}

// Ingest appends leaf (32 bytes) to the tree.
func Ingest(c solana.Context, tree, leaf []byte) uint64 {
	count := Count(tree)
	if count >= 0xffffffff {
		return ErrFull
	}
	count++
	setCount(tree, count)
	// buf[0:32] is the left input, buf[32:64] the running node.
	var buf [64]byte
	copy(buf[32:64], leaf[:32])
	size := count
	for i := uint64(0); i < Depth; i++ {
		if size&1 == 1 {
			copy(tree[i*32:i*32+32], buf[32:64])
			return 0
		}
		copy(buf[0:32], tree[i*32:i*32+32])
		if code := solana.Keccak256(c, buf[:], 0, 64, buf[:], 32); code != 0 {
			return code
		}
		size = size >> 1
	}
	return 0
}

// Root writes the current root into root[0:32].
func Root(c solana.Context, tree, root []byte) uint64 {
	count := Count(tree)
	skip := uint64(bits.TrailingZeros64(count))
	if skip >= Depth {
		for j := uint64(0); j < 32; j++ {
			root[j] = zeroHashes[Depth*32+j]
		}
		return 0
	}
	var buf [64]byte
	// The running node lives in buf[32:64] when it is the right input and is
	// moved to buf[0:32] when it is the left one.
	for j := uint64(0); j < 32; j++ {
		buf[32+j] = zeroHashes[skip*32+j]
	}
	size := count >> skip
	for i := skip; i < Depth; i++ {
		if size&1 == 1 {
			copy(buf[0:32], tree[i*32:i*32+32])
		} else {
			copy(buf[0:32], buf[32:64])
			for j := uint64(0); j < 32; j++ {
				buf[32+j] = zeroHashes[i*32+j]
			}
		}
		if code := solana.Keccak256(c, buf[:], 0, 64, buf[:], 32); code != 0 {
			return code
		}
		size = size >> 1
	}
	copy(root[:32], buf[32:64])
	return 0
}
