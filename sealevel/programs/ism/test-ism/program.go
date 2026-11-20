// Package testism ports rust/sealevel/programs/ism/test-ism: an Interchain
// Security Module that approves whenever its storage says so.
// NOT INTENDED FOR USE IN PRODUCTION.
package testism

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// ISMType is the module type returned by the Type instruction.
const ISMType = hyperlanecore.ModuleTypeUnused

// ErrVerifyNotAccepted is TestIsmError::VerifyNotAccepted.
const ErrVerifyNotAccepted uint64 = 69420

// StoragePDASeeds are test_ism_storage_pda_seeds!().
var StoragePDASeeds = [][]byte{[]byte("test_ism"), []byte("-"), []byte("storage")}

// TestIsmInstruction variants (Borsh enum indices).
const (
	InstructionInit      uint8 = 0
	InstructionSetAccept uint8 = 1
)

// Storage is TestIsmStorage, stored as AccountData<TestIsmStorage>.
type Storage struct {
	Accept bool
}

func (s *Storage) EncodeBorsh(w *borsh.Writer) { w.Bool(s.Accept) }
func (s *Storage) DecodeBorsh(r *borsh.Reader) { s.Accept = r.Bool() }

// Size is SizedData::size (one bool byte).
func (s *Storage) Size() int { return 1 }

// Process is the program entrypoint.
func Process(c solana.Context) uint64 {
	data := solana.Instruction(c)
	if ix, code := ism.Decode(data); code == svm.Success {
		switch ix.Kind {
		case ism.KindVerify:
			return verify(c)
		case ism.KindVerifyAccountMetas:
			return verifyAccountMetas(c)
		case ism.KindType:
			var out [5]byte
			out[0] = byte(ISMType)
			out[1] = byte(ISMType >> 8)
			out[2] = byte(ISMType >> 16)
			out[3] = byte(ISMType >> 24)
			out[4] = accountmeta.SimulationReturnDataTrailer
			return solana.SetReturnData(c, out[:])
		case ism.KindVerifyMetadataSpec:
			result := ism.MetadataSpecResult{Spec: borsh.SomeOf(ism.MetadataSpec{Kind: ism.SpecNull})}
			return solana.SetReturnData(c, ism.EncodeMetadataSpecReturnData(&result))
		}
	}

	r := borsh.NewReader(data)
	switch r.EnumTag() {
	case InstructionInit:
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return initialize(c)
	case InstructionSetAccept:
		accept := r.Bool()
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return setAccept(c, accept)
	}
	return svm.InvalidInstructionData
}

// initialize creates the storage PDA.
//
// Accounts:
// 0. `[executable]` System program.
// 1. `[signer]` Payer.
// 2. `[writeable]` Storage PDA.
func initialize(c solana.Context) uint64 {
	it := svm.NewAccountIter(c)
	systemProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, systemProgram, svm.SystemProgramID) {
		return svm.InvalidArgument
	}
	payer, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, payer) {
		return svm.MissingRequiredSignature
	}
	storage, code := it.Next()
	if code != svm.Success {
		return code
	}
	programID := svm.ProgramID(c)
	key, seeds, code := svm.FindProgramAddressSeeds(c, StoragePDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, storage, key) {
		return svm.InvalidArgument
	}
	value := Storage{Accept: true}
	if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(&value), programID, systemProgram, storage, &seeds); code != svm.Success {
		return code
	}
	return accountutils.Store(c, storage, &value, false)
}

// setAccept sets whether messages are accepted.
//
// Accounts:
// 0. `[writeable]` Storage PDA. Not validated: this is a test program.
func setAccept(c solana.Context, accept bool) uint64 {
	it := svm.NewAccountIter(c)
	storage, code := it.Next()
	if code != svm.Success {
		return code
	}
	value, _, code := accountutils.FetchAccount[Storage](c, storage)
	if code != svm.Success {
		return code
	}
	value.Accept = accept
	return accountutils.Store(c, storage, &value, false)
}

// verify succeeds iff storage accepts.
//
// Accounts:
// 0. `[]` Storage PDA.
func verify(c solana.Context) uint64 {
	it := svm.NewAccountIter(c)
	storage, code := it.Next()
	if code != svm.Success {
		return code
	}
	value, _, code := accountutils.FetchAccount[Storage](c, storage)
	if code != svm.Success {
		return code
	}
	if !value.Accept {
		return ErrVerifyNotAccepted
	}
	return svm.Success
}

// verifyAccountMetas returns the storage PDA as Verify's only account.
func verifyAccountMetas(c solana.Context) uint64 {
	key, _, code := svm.FindProgramAddress(c, StoragePDASeeds, svm.ProgramID(c))
	if code != svm.Success {
		return code
	}
	var metas [1]accountmeta.SerializableAccountMeta
	metas[0] = accountmeta.Readonly(key, false)
	return solana.SetReturnData(c, accountmeta.EncodeMetasReturnData(metas[:]))
}
