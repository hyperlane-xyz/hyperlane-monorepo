package compositeism

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
)

// Instruction variants (Borsh enum indices of instruction::Instruction).
const (
	IxInitialize uint8 = iota
	IxUpdateConfig
	IxGetOwner
	IxTransferOwnership
	IxSetDomainIsm
	IxRemoveDomainIsm
	IxPause
	IxUnpause
	ixKinds
)

// Instruction is instruction::Instruction, encoded after
// PROGRAM_INSTRUCTION_DISCRIMINATOR. Node is the payload of Initialize,
// UpdateConfig and SetDomainIsm; Domain of SetDomainIsm and RemoveDomainIsm;
// NewOwner of TransferOwnership.
type Instruction struct {
	Kind     uint8
	Node     IsmNode
	Domain   uint32
	NewOwner borsh.Option[[32]byte]
}

func (ix *Instruction) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(ix.Kind)
	switch ix.Kind {
	case IxInitialize, IxUpdateConfig:
		ix.Node.EncodeBorsh(w)
	case IxTransferOwnership:
		w.OptionTag(ix.NewOwner.Some)
		if ix.NewOwner.Some {
			w.Bytes32(ix.NewOwner.Value)
		}
	case IxSetDomainIsm:
		w.U32(ix.Domain)
		ix.Node.EncodeBorsh(w)
	case IxRemoveDomainIsm:
		w.U32(ix.Domain)
	}
}

func (ix *Instruction) DecodeBorsh(r *borsh.Reader) {
	ix.Kind = r.EnumTag()
	switch ix.Kind {
	case IxInitialize, IxUpdateConfig:
		ix.Node.DecodeBorsh(r)
	case IxGetOwner, IxPause, IxUnpause:
	case IxTransferOwnership:
		if r.OptionTag() {
			ix.NewOwner = borsh.SomeOf(r.Bytes32())
		}
	case IxSetDomainIsm:
		ix.Domain = r.U32()
		ix.Node.DecodeBorsh(r)
	case IxRemoveDomainIsm:
		ix.Domain = r.U32()
	default:
		r.Fail()
	}
}

// Encode is DiscriminatorEncode::encode.
func (ix *Instruction) Encode() []byte {
	return accountutils.DiscriminatorEncode(accountutils.ProgramInstructionDiscriminator, ix)
}

// DecodeInstruction is DiscriminatorDecode::decode (InvalidInstructionData on
// any mismatch).
func DecodeInstruction(data []byte) (Instruction, uint64) {
	return accountutils.DiscriminatorDecode[Instruction](accountutils.ProgramInstructionDiscriminator, data)
}

// Storage is CompositeIsmStorage, stored as AccountData in the VAM PDA.
type Storage struct {
	BumpSeed uint8
	Owner    borsh.Option[[32]byte]
	Root     borsh.Option[IsmNode]
}

func (s *Storage) EncodeBorsh(w *borsh.Writer) {
	w.U8(s.BumpSeed)
	w.OptionTag(s.Owner.Some)
	if s.Owner.Some {
		w.Bytes32(s.Owner.Value)
	}
	w.OptionTag(s.Root.Some)
	if s.Root.Some {
		s.Root.Value.EncodeBorsh(w)
	}
}

func (s *Storage) DecodeBorsh(r *borsh.Reader) {
	s.BumpSeed = r.U8()
	if r.OptionTag() {
		s.Owner = borsh.SomeOf(r.Bytes32())
	}
	if r.OptionTag() {
		s.Root.Some = true
		s.Root.Value.DecodeBorsh(r)
		s.Root.Some = r.Ok()
	}
}

// Size is SizedData::size (the Borsh length).
func (s *Storage) Size() int {
	n := 1 + 1 + 1
	if s.Owner.Some {
		n += 32
	}
	if s.Root.Some {
		n += s.Root.Value.Size()
	}
	return n
}

// DomainStorage is DomainIsmStorage, stored as AccountData in a domain PDA.
type DomainStorage struct {
	BumpSeed uint8
	Domain   uint32
	Ism      borsh.Option[IsmNode]
}

func (s *DomainStorage) EncodeBorsh(w *borsh.Writer) {
	w.U8(s.BumpSeed)
	w.U32(s.Domain)
	w.OptionTag(s.Ism.Some)
	if s.Ism.Some {
		s.Ism.Value.EncodeBorsh(w)
	}
}

func (s *DomainStorage) DecodeBorsh(r *borsh.Reader) {
	s.BumpSeed = r.U8()
	s.Domain = r.U32()
	if r.OptionTag() {
		s.Ism.Some = true
		s.Ism.Value.DecodeBorsh(r)
		s.Ism.Some = r.Ok()
	}
}

// Size is SizedData::size (the Borsh length).
func (s *DomainStorage) Size() int {
	n := 1 + 4 + 1
	if s.Ism.Some {
		n += s.Ism.Value.Size()
	}
	return n
}
