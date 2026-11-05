package subsetcheck

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	ecdsa "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/ecdsa-signature"
	multisigism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/multisig-ism"
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

func multisig(c solana.Context, data []byte) uint64 {
	ix, code := multisigism.DecodeInstruction(data)
	if code != 0 {
		return code
	}
	m, e := multisigism.ParseMessageIDMetadata(ix.Message)
	if e != multisigism.OK {
		return uint64(e)
	}
	var vt multisigism.ValidatorsAndThreshold
	r := borsh.NewReader(data)
	vt.DecodeBorsh(&r)
	w := borsh.NewWriter(vt.Size())
	vt.EncodeBorsh(&w)
	w.Raw(m.Encode())
	w.Raw(ix.Encode())
	h, code := multisigism.CheckpointSigningHash(c, &m.OriginMerkleTreeHook, 1, &m.MerkleRoot, m.MerkleIndex, &m.MerkleRoot)
	if code != 0 {
		return code
	}
	if e, code := multisigism.Verify(c, &h, m.Signatures, vt.Validators, vt.Threshold); code != 0 || e != multisigism.OK {
		return 1
	}
	_ = multisigism.DomainDataPDASeeds(1)
	return solana.SetReturnData(c, w.Bytes())
}
