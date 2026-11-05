package accesscontrol_test

import (
	"bytes"
	"testing"

	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

func key(b byte) (k [32]byte) { copy(k[:], bytes.Repeat([]byte{b}, 32)); return }

func ctx(k [32]byte, signer bool) solana.Context {
	return solana.Context{Accounts: []solana.Account{{Key: k[:], Owner: make([]byte, 32), Signer: signer}}}
}

// Mirrors access-control's test_ensure_owner_signer and test_transfer_ownership.
func TestEnsureOwnerSigner(t *testing.T) {
	owner := accesscontrol.Owner(borsh.SomeOf(key(1)))
	if code := accesscontrol.EnsureOwnerSigner(ctx(key(1), true), owner, 0); code != 0 {
		t.Fatalf("owner signer %#x", code)
	}
	if code := accesscontrol.EnsureOwnerSigner(ctx(key(1), false), owner, 0); code != svm.MissingRequiredSignature {
		t.Fatalf("not signer %#x", code)
	}
	if code := accesscontrol.EnsureOwnerSigner(ctx(key(2), true), owner, 0); code != svm.InvalidArgument {
		t.Fatalf("not owner %#x", code)
	}
	// No owner is InvalidArgument even before the signature check.
	if code := accesscontrol.EnsureOwnerSigner(ctx(key(1), false), accesscontrol.Owner{}, 0); code != svm.InvalidArgument {
		t.Fatalf("no owner %#x", code)
	}
}

func TestTransferOwnership(t *testing.T) {
	owner := accesscontrol.Owner(borsh.SomeOf(key(1)))
	next := accesscontrol.Owner(borsh.SomeOf(key(2)))
	if code := accesscontrol.TransferOwnership(ctx(key(1), true), &owner, 0, next); code != 0 || owner != next {
		t.Fatalf("transfer %#x %v", code, owner)
	}
	if code := accesscontrol.TransferOwnership(ctx(key(1), true), &owner, 0, next); code != svm.InvalidArgument {
		t.Fatalf("old owner %#x", code)
	}
	if code := accesscontrol.TransferOwnership(ctx(key(2), false), &owner, 0, accesscontrol.Owner{}); code != svm.MissingRequiredSignature {
		t.Fatalf("unsigned %#x", code)
	}
	if code := accesscontrol.TransferOwnership(ctx(key(2), true), &owner, 0, accesscontrol.Owner{}); code != 0 || owner.Some {
		t.Fatalf("renounce %#x %v", code, owner)
	}
	if code := accesscontrol.TransferOwnership(ctx(key(2), true), &owner, 0, accesscontrol.Owner{}); code != svm.InvalidArgument {
		t.Fatalf("after renounce %#x", code)
	}
}
