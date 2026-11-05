package compositeism

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	multisigism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/multisig-ism"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// multisigError is From<MultisigIsmError> for Error.
func multisigError(e multisigism.Error) uint64 {
	switch e {
	case multisigism.ErrInvalidSignature:
		return ErrInvalidSignature
	case multisigism.ErrThresholdNotMet:
		return ErrThresholdNotMet
	}
	return ErrInvalidMetadata
}

// verifyMultisig is verify_node's MultisigMessageId arm: a threshold of
// validator signatures over CheckpointWithMessageId {metadata's hook, root
// and index, the message's origin and ID}.
func verifyMultisig(c solana.Context, n *IsmNode, metadata []byte, message *hyperlanecore.HyperlaneMessage, encoded []byte) uint64 {
	meta, e := multisigism.ParseMessageIDMetadata(metadata)
	if e != multisigism.OK {
		return ErrInvalidMetadata
	}
	if len(meta.Signatures) < int(n.Threshold) {
		return ErrInvalidMetadata
	}
	var id [32]byte
	if code := hyperlanecore.MessageID(c, encoded, 0, uint64(len(encoded)), id[:]); code != 0 {
		return code
	}
	hash, code := multisigism.CheckpointSigningHash(c, &meta.OriginMerkleTreeHook, message.Origin, &meta.MerkleRoot, meta.MerkleIndex, &id)
	if code != 0 {
		return code
	}
	e, code = multisigism.Verify(c, &hash, meta.Signatures, n.Validators, n.Threshold)
	if code != 0 {
		return code
	}
	if e != multisigism.OK {
		return multisigError(e)
	}
	return svm.Success
}

// legacyMultisigSpec resolves a MessageIdMultisig fallback ISM, which lacks
// VerifyMetadataSpec, through its ValidatorsAndThreshold instruction.
func (s *specContext) legacyMultisigSpec(c solana.Context, fallback *svm.Pubkey, domainKey, fallbackVAM svm.Pubkey) specResult {
	domainData, _, code := svm.FindProgramAddress(c, multisigism.DomainDataPDASeeds(s.message.Origin), *fallback)
	if code != svm.Success {
		return specResult{code: code}
	}
	if !(s.count > 3 && svm.KeyIs(c, 3, domainData)) {
		return unresolved(domainKey, fallbackVAM, domainData, *fallback)
	}
	ix := multisigism.Instruction{Kind: multisigism.KindValidatorsAndThreshold, Message: s.encoded}
	if invokeOne(c, fallback, 3, ix.Encode()) != svm.Success {
		return specResult{code: ErrFallbackIsmCallFailed}
	}
	data, ok := returnData(c)
	if !ok {
		return specResult{code: ErrFallbackIsmCallFailed}
	}
	r := borsh.NewReader(data)
	var vat multisigism.ValidatorsAndThreshold
	vat.DecodeBorsh(&r)
	r.U8()
	if !r.Done() {
		return specResult{code: ErrFallbackIsmCallFailed}
	}
	return specResult{resolved: true, spec: ism.MetadataSpec{Kind: ism.SpecMultisigMessageID, Validators: vat.Validators, Threshold: vat.Threshold}}
}
