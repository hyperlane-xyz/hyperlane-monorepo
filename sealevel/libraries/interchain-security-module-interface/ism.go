// Package ism ports rust/sealevel/libraries/interchain-security-module-interface.
package ism

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

// Instruction discriminators: the first 8 bytes of
// sha256("hyperlane-interchain-security-module:<name>").
var (
	TypeDiscriminator               = [8]byte{105, 97, 97, 88, 63, 124, 106, 18}
	VerifyDiscriminator             = [8]byte{243, 53, 214, 0, 208, 18, 231, 67}
	VerifyAccountMetasDiscriminator = [8]byte{200, 65, 157, 12, 89, 255, 131, 216}
	VerifyMetadataSpecDiscriminator = [8]byte{49, 24, 22, 218, 134, 132, 63, 155}
)

// VerifyAccountMetasPDASeeds are the seeds of the PDA passed to
// VerifyAccountMetas (and as account 0 of VerifyMetadataSpec).
var VerifyAccountMetasPDASeeds = [][]byte{
	[]byte("hyperlane_ism"), []byte("-"), []byte("verify"), []byte("-"), []byte("account_metas"),
}

// InstructionKind is the InterchainSecurityModuleInstruction variant.
type InstructionKind uint8

const (
	KindType InstructionKind = iota
	KindVerify
	KindVerifyAccountMetas
	KindVerifyMetadataSpec
)

// Instruction is InterchainSecurityModuleInstruction. Verify and
// VerifyAccountMetas use Metadata and Message; VerifyMetadataSpec uses Message.
// Decoded slices are views into the instruction data.
type Instruction struct {
	Kind     InstructionKind
	Metadata []byte
	Message  []byte
}

func discriminatorIs(b []byte, d [8]byte) bool {
	for i := 0; i < 8; i++ {
		if b[i] != d[i] {
			return false
		}
	}
	return true
}

// Decode is InterchainSecurityModuleInstruction::decode. Short input or an
// unknown discriminator is InvalidInstructionData; a payload that is not
// exactly the Borsh struct is BorshIoError. Type ignores trailing bytes.
func Decode(buf []byte) (Instruction, uint64) {
	var ix Instruction
	if len(buf) < 8 {
		return ix, svm.InvalidInstructionData
	}
	r := borsh.NewReader(buf[8:])
	switch {
	case discriminatorIs(buf, TypeDiscriminator):
		ix.Kind = KindType
		return ix, svm.Success
	case discriminatorIs(buf, VerifyDiscriminator):
		ix.Kind = KindVerify
		ix.Metadata = r.ByteVecView()
		ix.Message = r.ByteVecView()
	case discriminatorIs(buf, VerifyAccountMetasDiscriminator):
		ix.Kind = KindVerifyAccountMetas
		ix.Metadata = r.ByteVecView()
		ix.Message = r.ByteVecView()
	case discriminatorIs(buf, VerifyMetadataSpecDiscriminator):
		ix.Kind = KindVerifyMetadataSpec
		ix.Message = r.ByteVecView()
	default:
		return ix, svm.InvalidInstructionData
	}
	if !r.Done() {
		return Instruction{}, svm.BorshIoError
	}
	return ix, svm.Success
}

// Encode is InterchainSecurityModuleInstruction::encode.
func (ix *Instruction) Encode() []byte {
	w := borsh.NewWriter(16 + len(ix.Metadata) + len(ix.Message))
	switch ix.Kind {
	case KindType:
		w.Raw(TypeDiscriminator[:])
	case KindVerify:
		w.Raw(VerifyDiscriminator[:])
		w.ByteVec(ix.Metadata)
		w.ByteVec(ix.Message)
	case KindVerifyAccountMetas:
		w.Raw(VerifyAccountMetasDiscriminator[:])
		w.ByteVec(ix.Metadata)
		w.ByteVec(ix.Message)
	case KindVerifyMetadataSpec:
		w.Raw(VerifyMetadataSpecDiscriminator[:])
		w.ByteVec(ix.Message)
	}
	return w.Bytes()
}
