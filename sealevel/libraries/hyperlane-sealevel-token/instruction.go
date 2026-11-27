package tokenlib

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

// Instruction variants (Borsh enum indices of instruction::Instruction).
const (
	KindInit uint8 = iota
	KindTransferRemote
	KindEnrollRemoteRouter
	KindEnrollRemoteRouters
	KindSetDestinationGasConfigs
	KindSetInterchainSecurityModule
	KindSetInterchainGasPaymaster
	KindTransferOwnership
	KindTransferRemoteWithMemo
	KindSetFeeConfig
)

// Init is instruction::Init.
type Init struct {
	Mailbox                  svm.Pubkey
	InterchainSecurityModule borsh.Option[svm.Pubkey]
	InterchainGasPaymaster   borsh.Option[cc.IGPConfig]
	Decimals                 uint8
	RemoteDecimals           uint8
}

func (i *Init) EncodeBorsh(w *borsh.Writer) {
	w.Bytes32(i.Mailbox)
	cc.WriteOptionalPubkey(w, i.InterchainSecurityModule)
	cc.WriteOptionalIGP(w, &i.InterchainGasPaymaster)
	w.U8(i.Decimals)
	w.U8(i.RemoteDecimals)
}

func (i *Init) DecodeBorsh(r *borsh.Reader) {
	i.Mailbox = r.Bytes32()
	i.InterchainSecurityModule = cc.ReadOptionalPubkey(r)
	i.InterchainGasPaymaster = cc.ReadOptionalIGP(r)
	i.Decimals = r.U8()
	i.RemoteDecimals = r.U8()
}

// TransferRemote is instruction::TransferRemote.
type TransferRemote struct {
	DestinationDomain uint32
	Recipient         hyperlanecore.H256
	AmountOrID        borsh.U256
}

func (t *TransferRemote) EncodeBorsh(w *borsh.Writer) {
	w.U32(t.DestinationDomain)
	w.Bytes32(t.Recipient)
	w.U256(t.AmountOrID)
}

func (t *TransferRemote) DecodeBorsh(r *borsh.Reader) {
	t.DestinationDomain = r.U32()
	t.Recipient = r.Bytes32()
	t.AmountOrID = r.U256()
}

// Instruction is the decoded instruction::Instruction. Kind selects which
// payload field is set. Memo is a view into the instruction data.
type Instruction struct {
	Kind          uint8
	Init          Init
	Transfer      TransferRemote
	Memo          []byte
	RouterConfig  cc.RemoteRouterConfig
	RouterConfigs []cc.RemoteRouterConfig
	GasConfigs    []cc.GasRouterConfig
	Pubkey        borsh.Option[svm.Pubkey] // ISM or new owner
	IGP           borsh.Option[cc.IGPConfig]
	FeeConfig     borsh.Option[FeeConfig]
}

func (ix *Instruction) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(ix.Kind)
	switch ix.Kind {
	case KindInit:
		ix.Init.EncodeBorsh(w)
	case KindTransferRemote:
		ix.Transfer.EncodeBorsh(w)
	case KindEnrollRemoteRouter:
		ix.RouterConfig.EncodeBorsh(w)
	case KindEnrollRemoteRouters:
		borsh.WriteVec(w, ix.RouterConfigs, cc.WriteRemoteRouterConfig)
	case KindSetDestinationGasConfigs:
		borsh.WriteVec(w, ix.GasConfigs, cc.WriteGasRouterConfig)
	case KindSetInterchainSecurityModule, KindTransferOwnership:
		cc.WriteOptionalPubkey(w, ix.Pubkey)
	case KindSetInterchainGasPaymaster:
		cc.WriteOptionalIGP(w, &ix.IGP)
	case KindTransferRemoteWithMemo:
		ix.Transfer.EncodeBorsh(w)
		w.ByteVec(ix.Memo)
	case KindSetFeeConfig:
		w.OptionTag(ix.FeeConfig.Some)
		if ix.FeeConfig.Some {
			ix.FeeConfig.Value.EncodeBorsh(w)
		}
	}
}

func (ix *Instruction) DecodeBorsh(r *borsh.Reader) {
	ix.Kind = r.EnumTag()
	switch ix.Kind {
	case KindInit:
		ix.Init.DecodeBorsh(r)
	case KindTransferRemote:
		ix.Transfer.DecodeBorsh(r)
	case KindEnrollRemoteRouter:
		ix.RouterConfig.DecodeBorsh(r)
	case KindEnrollRemoteRouters:
		ix.RouterConfigs = borsh.ReadVec(r, cc.ReadRemoteRouterConfig)
	case KindSetDestinationGasConfigs:
		ix.GasConfigs = borsh.ReadVec(r, cc.ReadGasRouterConfig)
	case KindSetInterchainSecurityModule, KindTransferOwnership:
		ix.Pubkey = cc.ReadOptionalPubkey(r)
	case KindSetInterchainGasPaymaster:
		ix.IGP = cc.ReadOptionalIGP(r)
	case KindTransferRemoteWithMemo:
		ix.Transfer.DecodeBorsh(r)
		ix.Memo = r.ByteVecView()
	case KindSetFeeConfig:
		if r.OptionTag() {
			ix.FeeConfig.Value.DecodeBorsh(r)
			ix.FeeConfig.Some = r.Ok()
		}
	default:
		r.Fail()
	}
}

// DecodeInstruction is Instruction::decode (DiscriminatorDecode with
// PROGRAM_INSTRUCTION_DISCRIMINATOR): any failure is InvalidInstructionData.
func DecodeInstruction(data []byte, ix *Instruction) uint64 {
	if len(data) < accountutils.DiscriminatorLength {
		return svm.InvalidInstructionData
	}
	for i := 0; i < accountutils.DiscriminatorLength; i++ {
		if data[i] != accountutils.ProgramInstructionDiscriminator[i] {
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

// EncodeInstruction is Instruction::encode: the discriminator, then Borsh.
func EncodeInstruction(ix *Instruction) []byte {
	return accountutils.DiscriminatorEncode(accountutils.ProgramInstructionDiscriminator, ix)
}
