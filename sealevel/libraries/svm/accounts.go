package svm

import "gosvm/solana"

// Pubkey is a Solana public key, H256-compatible.
type Pubkey = [32]byte

// SystemProgramID is 11111111111111111111111111111111.
var SystemProgramID Pubkey

// AccountIter walks the instruction's accounts in order, like Rust's
// next_account_info. SDK accessors trap on an out-of-range index, so always
// take indices from Next rather than indexing directly.
type AccountIter struct {
	next  uint64
	count uint64
}

// NewAccountIter starts at account 0.
func NewAccountIter(c solana.Context) AccountIter {
	return AccountIter{count: solana.Count(c)}
}

// Next returns the next account index, or NotEnoughAccountKeys.
func (it *AccountIter) Next() (uint64, uint64) {
	if it.next >= it.count {
		return 0, NotEnoughAccountKeys
	}
	i := it.next
	it.next++
	return i, Success
}

// HasMore reports whether accounts remain.
func (it *AccountIter) HasMore() bool { return it.next < it.count }

// Position returns the index Next would return.
func (it *AccountIter) Position() uint64 { return it.next }

// Key copies account i's key.
func Key(c solana.Context, i uint64) Pubkey {
	var k Pubkey
	copy(k[:], solana.Key(c, i))
	return k
}

// Owner copies account i's owner.
func Owner(c solana.Context, i uint64) Pubkey {
	var k Pubkey
	copy(k[:], solana.Owner(c, i))
	return k
}

// ProgramID copies the executing program's ID.
func ProgramID(c solana.Context) Pubkey {
	var k Pubkey
	copy(k[:], solana.ProgramID(c))
	return k
}

// Equal32 compares a 32-byte slice with a key.
func Equal32(b []byte, k Pubkey) bool {
	if len(b) != 32 {
		return false
	}
	for i := 0; i < 32; i++ {
		if b[i] != k[i] {
			return false
		}
	}
	return true
}

// KeyIs reports whether account i's key is k.
func KeyIs(c solana.Context, i uint64, k Pubkey) bool { return Equal32(solana.Key(c, i), k) }

// OwnerIs reports whether account i is owned by k.
func OwnerIs(c solana.Context, i uint64, k Pubkey) bool { return Equal32(solana.Owner(c, i), k) }

// SameKey reports whether accounts i and j have the same key.
func SameKey(c solana.Context, i, j uint64) bool { return Equal32(solana.Key(c, i), Key(c, j)) }

// DataIsEmpty reports whether account i has no data.
func DataIsEmpty(c solana.Context, i uint64) bool { return len(solana.Data(c, i)) == 0 }
