package tokencrosscollateral

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

// InstructionDiscriminator is CROSS_COLLATERAL_INSTRUCTION_DISCRIMINATOR.
var InstructionDiscriminator = accountutils.Discriminator{2, 2, 2, 2, 2, 2, 2, 2}

// CrossCollateralInstruction variants (Borsh enum indices).
const (
	KindSetCrossCollateralRouters uint8 = iota
	KindTransferRemoteTo
	KindHandleLocal
	KindHandleLocalAccountMetas
)

// CrossCollateralRouterUpdate variants.
const (
	UpdateAdd uint8 = iota
	UpdateRemove
)

// CrossCollateralRouterUpdate is instruction::CrossCollateralRouterUpdate:
// Add{domain, router} (Router.Some, always) or Remove(RemoteRouterConfig)
// (Router None removes the whole domain).
type CrossCollateralRouterUpdate struct {
	Kind   uint8
	Domain uint32
	Router borsh.Option[hyperlanecore.H256]
}

func (u *CrossCollateralRouterUpdate) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(u.Kind)
	if u.Kind == UpdateAdd {
		w.U32(u.Domain)
		w.Bytes32(u.Router.Value)
		return
	}
	cc.WriteRemoteRouterConfig(w, cc.RemoteRouterConfig{Domain: u.Domain, Router: u.Router})
}

func (u *CrossCollateralRouterUpdate) DecodeBorsh(r *borsh.Reader) {
	u.Kind = r.EnumTag()
	switch u.Kind {
	case UpdateAdd:
		u.Domain = r.U32()
		u.Router = borsh.SomeOf(r.Bytes32())
	case UpdateRemove:
		cfg := cc.ReadRemoteRouterConfig(r)
		u.Domain = cfg.Domain
		u.Router = cfg.Router
	default:
		r.Fail()
	}
}

func readUpdate(r *borsh.Reader) CrossCollateralRouterUpdate {
	var u CrossCollateralRouterUpdate
	u.DecodeBorsh(r)
	return u
}

func writeUpdate(w *borsh.Writer, u CrossCollateralRouterUpdate) { u.EncodeBorsh(w) }

// TransferRemoteTo is instruction::TransferRemoteTo.
type TransferRemoteTo struct {
	DestinationDomain uint32
	Recipient         hyperlanecore.H256
	AmountOrID        borsh.U256
	TargetRouter      hyperlanecore.H256
}

func (t *TransferRemoteTo) EncodeBorsh(w *borsh.Writer) {
	w.U32(t.DestinationDomain)
	w.Bytes32(t.Recipient)
	w.U256(t.AmountOrID)
	w.Bytes32(t.TargetRouter)
}

func (t *TransferRemoteTo) DecodeBorsh(r *borsh.Reader) {
	t.DestinationDomain = r.U32()
	t.Recipient = r.Bytes32()
	t.AmountOrID = r.U256()
	t.TargetRouter = r.Bytes32()
}

// HandleLocal is instruction::HandleLocal. Message is a view into the
// instruction data.
type HandleLocal struct {
	SenderProgramID svm.Pubkey
	Message         []byte
}

func (h *HandleLocal) EncodeBorsh(w *borsh.Writer) {
	w.Bytes32(h.SenderProgramID)
	w.ByteVec(h.Message)
}

func (h *HandleLocal) DecodeBorsh(r *borsh.Reader) {
	h.SenderProgramID = r.Bytes32()
	h.Message = r.ByteVecView()
}

// Instruction is the decoded CrossCollateralInstruction; Kind selects the
// payload field.
type Instruction struct {
	Kind     uint8
	Updates  []CrossCollateralRouterUpdate
	Transfer TransferRemoteTo
	Handle   HandleLocal
}

func (ix *Instruction) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(ix.Kind)
	switch ix.Kind {
	case KindSetCrossCollateralRouters:
		borsh.WriteVec(w, ix.Updates, writeUpdate)
	case KindTransferRemoteTo:
		ix.Transfer.EncodeBorsh(w)
	case KindHandleLocal, KindHandleLocalAccountMetas:
		ix.Handle.EncodeBorsh(w)
	}
}

func (ix *Instruction) DecodeBorsh(r *borsh.Reader) {
	ix.Kind = r.EnumTag()
	switch ix.Kind {
	case KindSetCrossCollateralRouters:
		ix.Updates = borsh.ReadVec(r, readUpdate)
	case KindTransferRemoteTo:
		ix.Transfer.DecodeBorsh(r)
	case KindHandleLocal, KindHandleLocalAccountMetas:
		ix.Handle.DecodeBorsh(r)
	default:
		r.Fail()
	}
}

// DecodeInstruction is CrossCollateralInstruction::decode: any failure is
// InvalidInstructionData.
func DecodeInstruction(data []byte, ix *Instruction) uint64 {
	if len(data) < accountutils.DiscriminatorLength {
		return svm.InvalidInstructionData
	}
	for i := 0; i < accountutils.DiscriminatorLength; i++ {
		if data[i] != InstructionDiscriminator[i] {
			return svm.InvalidInstructionData
		}
	}
	r := borsh.NewReader(data[accountutils.DiscriminatorLength:])
	ix.DecodeBorsh(&r)
	if !r.Done() {
		return svm.InvalidInstructionData
	}
	return svm.Success
}

// EncodeInstruction is CrossCollateralInstruction::encode.
func EncodeInstruction(ix *Instruction) []byte {
	return accountutils.DiscriminatorEncode(InstructionDiscriminator, ix)
}
