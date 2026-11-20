// Package accesscontrol ports rust/sealevel/libraries/access-control. The
// owner is an Option<Pubkey> stored in the caller's account data.
package accesscontrol

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Owner is the Rust Option<Pubkey> owner field.
type Owner = borsh.Option[svm.Pubkey]

// EnsureOwnerSigner checks that account i is the owner and signed. No owner is
// InvalidArgument, a missing signature MissingRequiredSignature, a different
// key InvalidArgument, in that order.
func EnsureOwnerSigner(c solana.Context, owner Owner, i uint64) uint64 {
	if !owner.Some {
		return svm.InvalidArgument
	}
	if !solana.Signer(c, i) {
		return svm.MissingRequiredSignature
	}
	if !svm.KeyIs(c, i, owner.Value) {
		return svm.InvalidArgument
	}
	return svm.Success
}

// TransferOwnership sets *owner to newOwner if account i is the current owner
// and signed, logging "Ownership transferred to {:?}" like Rust. It does not
// store the account.
func TransferOwnership(c solana.Context, owner *Owner, i uint64, newOwner Owner) uint64 {
	if code := EnsureOwnerSigner(c, *owner, i); code != svm.Success {
		return code
	}
	*owner = newOwner
	m := svm.NewMsg("Ownership transferred to ")
	m.OptionPubkey(newOwner.Some, &newOwner.Value)
	m.Emit(c)
	return svm.Success
}
