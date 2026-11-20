// Package recipient ports rust/sealevel/libraries/message-recipient-interface.
package recipient

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

// Instruction discriminators: the first 8 bytes of
// sha256("hyperlane-message-recipient:<name>").
var (
	InterchainSecurityModuleDiscriminator             = [8]byte{45, 18, 245, 87, 234, 46, 246, 15}
	InterchainSecurityModuleAccountMetasDiscriminator = [8]byte{190, 214, 218, 129, 67, 97, 4, 76}
	HandleDiscriminator                               = [8]byte{33, 210, 5, 66, 196, 212, 239, 142}
	HandleAccountMetasDiscriminator                   = [8]byte{194, 141, 30, 82, 241, 41, 169, 52}
)

// InterchainSecurityModuleAccountMetasPDASeeds are the seeds of the PDA passed
// to InterchainSecurityModuleAccountMetas.
var InterchainSecurityModuleAccountMetasPDASeeds = [][]byte{
	[]byte("hyperlane_message_recipient"), []byte("-"), []byte("interchain_security_module"), []byte("-"), []byte("account_metas"),
}

// HandleAccountMetasPDASeeds are the seeds of the PDA passed to HandleAccountMetas.
var HandleAccountMetasPDASeeds = [][]byte{
	[]byte("hyperlane_message_recipient"), []byte("-"), []byte("handle"), []byte("-"), []byte("account_metas"),
}

// InstructionKind is the MessageRecipientInstruction variant.
type InstructionKind uint8

const (
	KindInterchainSecurityModule InstructionKind = iota
	KindInterchainSecurityModuleAccountMetas
	KindHandle
	KindHandleAccountMetas
)

// HandleInstruction is the Handle/HandleAccountMetas payload. Decoded Message
// is a view into the instruction data.
type HandleInstruction struct {
	Origin  uint32
	Sender  [32]byte
	Message []byte
}

func (h *HandleInstruction) EncodeBorsh(w *borsh.Writer) {
	w.U32(h.Origin)
	w.Bytes32(h.Sender)
	w.ByteVec(h.Message)
}

func (h *HandleInstruction) DecodeBorsh(r *borsh.Reader) {
	h.Origin = r.U32()
	h.Sender = r.Bytes32()
	h.Message = r.ByteVecView()
}

// Instruction is MessageRecipientInstruction; Handle is set for the two
// handle variants.
type Instruction struct {
	Kind   InstructionKind
	Handle HandleInstruction
}

func discriminatorIs(b []byte, d [8]byte) bool {
	for i := 0; i < 8; i++ {
		if b[i] != d[i] {
			return false
		}
	}
	return true
}

// Decode is MessageRecipientInstruction::decode. Short input or an unknown
// discriminator is InvalidInstructionData; a bad Handle payload is
// BorshIoError. The unit variants ignore trailing bytes.
func Decode(buf []byte) (Instruction, uint64) {
	var ix Instruction
	if len(buf) < 8 {
		return ix, svm.InvalidInstructionData
	}
	switch {
	case discriminatorIs(buf, InterchainSecurityModuleDiscriminator):
		ix.Kind = KindInterchainSecurityModule
		return ix, svm.Success
	case discriminatorIs(buf, InterchainSecurityModuleAccountMetasDiscriminator):
		ix.Kind = KindInterchainSecurityModuleAccountMetas
		return ix, svm.Success
	case discriminatorIs(buf, HandleDiscriminator):
		ix.Kind = KindHandle
	case discriminatorIs(buf, HandleAccountMetasDiscriminator):
		ix.Kind = KindHandleAccountMetas
	default:
		return ix, svm.InvalidInstructionData
	}
	r := borsh.NewReader(buf[8:])
	ix.Handle.DecodeBorsh(&r)
	if !r.Done() {
		return Instruction{}, svm.BorshIoError
	}
	return ix, svm.Success
}

// Encode is MessageRecipientInstruction::encode.
func (ix *Instruction) Encode() []byte {
	w := borsh.NewWriter(48 + len(ix.Handle.Message))
	switch ix.Kind {
	case KindInterchainSecurityModule:
		w.Raw(InterchainSecurityModuleDiscriminator[:])
	case KindInterchainSecurityModuleAccountMetas:
		w.Raw(InterchainSecurityModuleAccountMetasDiscriminator[:])
	case KindHandle:
		w.Raw(HandleDiscriminator[:])
		ix.Handle.EncodeBorsh(&w)
	case KindHandleAccountMetas:
		w.Raw(HandleAccountMetasDiscriminator[:])
		ix.Handle.EncodeBorsh(&w)
	}
	return w.Bytes()
}
