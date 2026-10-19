package subsetcheck

import (
	ecdsa "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/ecdsa-signature"
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
	_, code = s.RecoverEthereumAddress(c, digest[:])
	return code
}
