// Package subsetcheck imports every shared library so build-programs.sh can
// check them against goSVM's Go subset even before a program reaches them.
// goSVM checks every declaration of an imported package, used or not.
package subsetcheck

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	recipient "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/message-recipient-interface"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

type pair = borsh.Pair[uint32, uint64]

// Process instantiates the generic helpers with representative types.
func Process(c solana.Context) uint64 {
	data := solana.Instruction(c)
	r := borsh.NewReader(data)
	w := borsh.NewWriter(64)

	m := borsh.ReadMap(&r, borsh.ReadU32, borsh.ReadU64, borsh.LessU32)
	borsh.WriteMap(&w, m, borsh.WriteU32, borsh.WriteU64)
	m = borsh.SortPairs(append(m, pair{Key: 1, Value: 2}), borsh.LessU32)
	s := borsh.ReadSet(&r, borsh.ReadBytes20, borsh.Less20)
	borsh.WriteSet(&w, s, borsh.WriteBytes20)
	o := borsh.ReadOption(&r, borsh.ReadString)
	borsh.WriteOption(&w, o, borsh.WriteString)
	borsh.WriteVec(&w, borsh.ReadVec(&r, borsh.ReadByteVec), borsh.WriteByteVec)

	var spec ism.MetadataSpecResult
	spec.DecodeBorsh(&r)
	spec.EncodeBorsh(&w)
	ix, _ := ism.Decode(data)
	w.Raw(ix.Encode())
	rix, _ := recipient.Decode(data)
	w.Raw(rix.Encode())
	metas, _ := accountmeta.DecodeMetasReturnData(data)
	w.Raw(accountmeta.EncodeMetasReturnData(metas))
	msg, _ := hyperlanecore.DecodeMessage(data)
	w.Raw(msg.Encode())
	tm, _ := hyperlanecore.DecodeTokenMessage(data)
	w.Raw(tm.Encode())

	var owner accesscontrol.Owner
	code := accesscontrol.TransferOwnership(c, &owner, 0, borsh.SomeOf(svm.Key(c, 0)))
	if code != 0 {
		return code
	}
	h, _, code := accountutils.FetchAccount[recipient.HandleInstruction](c, 0)
	if code != 0 {
		return code
	}
	if code := accountutils.Store(c, 0, &h, true); code != 0 {
		return code
	}
	if _, code := accountutils.DiscriminatorDecode[recipient.HandleInstruction](accountutils.ProgramInstructionDiscriminator, data); code != 0 {
		return code
	}
	w.Raw(accountutils.DiscriminatorEncode(accountutils.ProgramInstructionDiscriminator, &h))
	tail := accountutils.ReadOptionalDiscriminated[recipient.HandleInstruction](&r, accountutils.ProgramInstructionDiscriminator)
	accountutils.WriteOptionalDiscriminated(&w, accountutils.ProgramInstructionDiscriminator, &tail)
	if code := accountutils.VerifyRentExempt(c, 0); code != 0 {
		return code
	}
	if code := accountutils.VerifyAccountUninitialized(c, 0); code != 0 {
		return code
	}
	it := svm.NewAccountIter(c)
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != 0 {
		return code
	}
	_, code = svm.CreateProgramAddress(c, ism.VerifyAccountMetasPDASeeds, 1, svm.ProgramID(c))
	if code != 0 {
		return code
	}
	if len(m) > 9 || accountutils.InitState(c, 0, svm.ProgramID(c)) == accountutils.OwnerMismatch {
		return 1
	}
	return solana.SetReturnData(c, w.Bytes())
}
