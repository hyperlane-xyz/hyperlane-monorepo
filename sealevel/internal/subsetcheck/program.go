// Package subsetcheck imports every shared library so build-programs.sh can
// check them against goSVM's Go subset even before a program reaches them.
// goSVM checks every declaration of an imported package, used or not.
package subsetcheck

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core/merkle"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token/collateral"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	recipient "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/message-recipient-interface"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
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
	var id [32]byte
	if code := hyperlanecore.MessageID(c, data, 0, uint64(len(data)), id[:]); code != 0 {
		return code
	}
	if len(data) >= merkle.Size {
		var root [32]byte
		if code := merkle.Root(c, data[:merkle.Size], root[:]); code != 0 {
			return code
		}
	}
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
	a := hyperlanecore.U256FromU128(uint64(len(m)), 0)
	b, ok := hyperlanecore.U256CheckedMul(&a, &a)
	b, ok2 := hyperlanecore.U256CheckedMulPow10(&b, 20)
	b = hyperlanecore.U256DivPow10(&b, 21)
	if n, fits := hyperlanecore.U256Uint64(&b); !ok || !ok2 || !fits || n > 9 || hyperlanecore.U256IsZero(&b) {
		return 1
	}
	clock, code := svm.GetClock(c)
	if code != 0 || clock.UnixTimestamp < 0 {
		return code
	}
	if len(m) > 9 || accountutils.InitState(c, 0, svm.ProgramID(c)) == accountutils.OwnerMismatch {
		return 1
	}
	if packageversioned.IsGetProgramVersion(data) {
		return packageversioned.ProcessGetProgramVersion(c)
	}
	w.Raw(cc.ISMReturnData(borsh.SomeOf(svm.Key(c, 0))))
	if quoted, code := tokenlib.IgpQuoted(data); quoted || code != 0 {
		return code
	}
	w.Raw(collateral.EscrowPDASeeds[2])
	tix := new(tokenlib.Instruction)
	if tokenlib.DecodeInstruction(data, tix) == 0 {
		w.Raw(tokenlib.EncodeInstruction(tix))
	}
	return solana.SetReturnData(c, w.Bytes())
}
