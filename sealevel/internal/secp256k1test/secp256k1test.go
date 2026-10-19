// Package secp256k1test stands in for the secp256k1_recover syscall in native
// tests, using recovery results computed by Rust (solana-program's
// secp256k1_recover) in sealevel/testdata/rust_vectors.json. Programs never
// import it.
//
// A vector group's "recover_<name>" entries pack hash(32) || signature(65) ||
// public key(64) || address(20); add entries to tools/rust-vectors for every
// (hash, signature) a test recovers.
package secp256k1test

import (
	"strings"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/keccaktest"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"gosvm/solana"
)

// Entry is one recovery vector.
type Entry struct {
	Hash      [32]byte
	Signature [65]byte
	PublicKey [64]byte
	Address   [20]byte
}

// Entries returns every recover_<name> entry of the groups, keyed by name.
func Entries(t testing.TB, groups ...string) map[string]Entry {
	t.Helper()
	out := map[string]Entry{}
	for _, g := range groups {
		for name, v := range testvectors.Rust(t, g) {
			if !strings.HasPrefix(name, "recover_") {
				continue
			}
			b := v.Bytes(t)
			if len(b) != 32+65+64+20 {
				t.Fatalf("%s/%s: %d bytes", g, name, len(b))
			}
			var e Entry
			copy(e.Hash[:], b[:32])
			copy(e.Signature[:], b[32:97])
			copy(e.PublicKey[:], b[97:161])
			copy(e.Address[:], b[161:])
			out[strings.TrimPrefix(name, "recover_")] = e
		}
	}
	return out
}

// Recover returns a Context.RecoverSecp256k1 callback over the groups'
// entries. Recovery ID > 3 is status 2 (InvalidRecoveryId); any (hash,
// signature) not in the table is status 3 (InvalidSignature), which is what
// the runtime returns for the invalid signatures tests use. Do not rely on it
// for valid signatures missing from the table.
func Recover(t testing.TB, groups ...string) func(hash []byte, recoveryID uint64, signature []byte) ([]byte, uint64) {
	t.Helper()
	table := map[string][]byte{}
	for _, e := range Entries(t, groups...) {
		v := e.Signature[64]
		if v >= 27 {
			v -= 27
		}
		key := string(e.Hash[:]) + string(e.Signature[:64]) + string([]byte{v})
		table[key] = append([]byte(nil), e.PublicKey[:]...)
	}
	return func(hash []byte, recoveryID uint64, signature []byte) ([]byte, uint64) {
		if recoveryID > 3 {
			return nil, 2
		}
		if k, ok := table[string(hash)+string(signature)+string([]byte{byte(recoveryID)})]; ok {
			return append([]byte(nil), k...), 0
		}
		return nil, 3
	}
}

// Context is keccaktest.Context plus Recover over the groups.
func Context(t testing.TB, groups ...string) solana.Context {
	t.Helper()
	c := keccaktest.Context()
	c.RecoverSecp256k1 = Recover(t, groups...)
	return c
}
