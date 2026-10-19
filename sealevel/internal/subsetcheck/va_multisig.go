package subsetcheck

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	ecdsa "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/ecdsa-signature"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	quoteverifier "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/quote-verifier"
	"gosvm/solana"
)

// vaMultisig touches the ecdsa-signature, quote-verifier and multisig-ism
// libraries. It lives in its own file so other ports' subsetcheck additions
// don't conflict with it.
func vaMultisig(c solana.Context, data []byte) uint64 {
	s, e := ecdsa.FromBytes(data)
	if e != ecdsa.OK {
		return uint64(e)
	}
	var h [32]byte
	digest, code := ecdsa.EthSignedMessageHash(c, &h)
	if code != 0 {
		return code
	}
	if _, code = s.RecoverEthereumAddress(c, digest[:]); code != 0 {
		return code
	}
	var q quoteverifier.SvmSignedQuote
	r := borsh.NewReader(data)
	q.DecodeBorsh(&r)
	w := borsh.NewWriter(64)
	q.EncodeBorsh(&w)
	signers := borsh.ReadSet(&r, borsh.ReadBytes20, borsh.Less20)
	if _, code := q.VerifySigner(c, &h, 1, &h, signers); code != 0 {
		return code
	}
	if code := q.ValidateSubmission(0, 1); code != 0 {
		return code
	}
	return q.Validate(0, 1)
}

func versioned(c solana.Context, data []byte) uint64 {
	if packageversioned.IsGetProgramVersion(data) {
		return packageversioned.ProcessGetProgramVersion(c)
	}
	return 0
}
