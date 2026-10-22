package accountutils_test

import (
	"bytes"
	"crypto/sha256"
	"testing"

	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// bumpContext models create_program_address with a fixed canonical bump:
// bumps above canonical are "on curve"; the address hashes the seeds. It
// counts derivations.
func bumpContext(canonical byte, calls *int, accounts ...solana.Account) solana.Context {
	return solana.Context{Accounts: accounts, DeriveAddress: func(seeds, program, out []byte) uint64 {
		*calls++
		if seeds[len(seeds)-1] > canonical {
			return 1
		}
		h := sha256.Sum256(append(append([]byte(nil), seeds...), program...))
		copy(out, h[:])
		return 0
	}}
}

var pdaSeeds = [][]byte{[]byte("foo"), []byte("-"), []byte("bar")}

func pdaKey(t *testing.T, canonical, bump byte, program svm.Pubkey) []byte {
	var calls int
	c := bumpContext(canonical, &calls)
	k, code := svm.CreateProgramAddress(c, pdaSeeds, bump, program)
	if code != svm.Success {
		t.Fatal(code)
	}
	return k[:]
}

func TestVerifyPDAWithBumpHintMatchesFind(t *testing.T) {
	program := svm.Pubkey{9}
	const canonical = 250
	key := pdaKey(t, canonical, canonical, program)
	for _, h := range []struct {
		hint  uint8
		has   bool
		calls int
	}{{0, false, 6}, {canonical, true, 1}, {canonical + 1, true, 7}, {0, true, 7}} {
		var calls int
		c := bumpContext(canonical, &calls, solana.Account{Key: key})
		bump, ok, code := accountutils.VerifyPDAWithBumpHint(c, 0, pdaSeeds, h.hint, h.has, program)
		if code != svm.Success || !ok || bump != canonical || calls != h.calls {
			t.Fatalf("hint %d/%v: bump %d ok %v code %d after %d derivations", h.hint, h.has, bump, ok, code, calls)
		}
	}
	// A real but non-canonical PDA passes with its own bump as the hint (only
	// program-owned accounts may supply hints) and fails without one.
	nonCanonical := pdaKey(t, canonical, canonical-3, program)
	var calls int
	c := bumpContext(canonical, &calls, solana.Account{Key: nonCanonical}, solana.Account{Key: bytes.Repeat([]byte{1}, 32)})
	if bump, ok, _ := accountutils.VerifyPDAWithBumpHint(c, 0, pdaSeeds, canonical-3, true, program); !ok || bump != canonical-3 {
		t.Fatal("hint fast path")
	}
	if _, ok, _ := accountutils.VerifyPDAWithBumpHint(c, 0, pdaSeeds, 0, false, program); ok {
		t.Fatal("non-canonical PDA accepted without a hint")
	}
	for _, hint := range []uint8{canonical, canonical + 1} {
		if _, ok, _ := accountutils.VerifyPDAWithBumpHint(c, 1, pdaSeeds, hint, true, program); ok {
			t.Fatal("wrong key accepted")
		}
	}
}

func TestStoredBump(t *testing.T) {
	program := svm.Pubkey{9}
	d := accountutils.Discriminator{'F', 'O', 'O', 'F', 'O', 'O', 'F', 'O'}
	const canonical = 250
	key := pdaKey(t, canonical, canonical, program)
	data := func(bump byte) []byte {
		return append(append(append([]byte{1}, d[:]...), bump), bytes.Repeat([]byte{7}, 16)...)
	}
	account := func(owner svm.Pubkey, b []byte) solana.Account {
		o := owner
		return solana.Account{Key: key, Owner: o[:], Data: b}
	}
	var calls int
	c := bumpContext(canonical, &calls, account(program, data(canonical)))
	if bump, ok := accountutils.StoredBump(c, 0, d, program); !ok || bump != canonical {
		t.Fatal("stored bump")
	}
	if bump, ok, code := accountutils.VerifyPDAWithStoredBump(c, 0, d, pdaSeeds, program); !ok || bump != canonical || code != 0 || calls != 1 {
		t.Fatalf("verify: %d %v %d after %d", bump, ok, code, calls)
	}
	uninitialized := data(canonical)
	uninitialized[0] = 0
	wrongDisc := data(canonical)
	wrongDisc[1] ^= 1
	for name, a := range map[string]solana.Account{
		"owner":         account(svm.Pubkey{8}, data(canonical)),
		"uninitialized": account(program, uninitialized),
		"discriminator": account(program, wrongDisc),
		"short":         account(program, data(canonical)[:9]),
	} {
		c := bumpContext(canonical, &calls, a)
		if _, ok := accountutils.StoredBump(c, 0, d, program); ok {
			t.Fatalf("%s: stored bump read", name)
		}
	}
	// A wrong stored bump falls back to the search.
	calls = 0
	c = bumpContext(canonical, &calls, account(program, data(canonical+1)))
	if bump, ok, _ := accountutils.VerifyPDAWithStoredBump(c, 0, d, pdaSeeds, program); !ok || bump != canonical || calls != 7 {
		t.Fatalf("fallback: bump %d ok %v after %d", bump, ok, calls)
	}
}
