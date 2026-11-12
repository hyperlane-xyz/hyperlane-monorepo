// Package multisigismmessageid ports
// rust/sealevel/programs/ism/multisig-ism-message-id: a multisig ISM that
// accepts a threshold of validator signatures over a checkpoint whose
// message ID matches the message being verified. No merkle proofs.
package multisigismmessageid

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	multisigism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/multisig-ism"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// ISMType is the module type returned by the Type instruction.
const ISMType = hyperlanecore.ModuleTypeMessageIDMultisig

// Error codes (ProgramError::Custom).
const (
	ErrAccountOutOfOrder             uint64 = 1
	ErrAccountNotOwner               uint64 = 2
	ErrProgramIDNotOwner             uint64 = 3
	ErrAccountNotInitialized         uint64 = 4
	ErrInvalidSignatureRecoveryID    uint64 = 5
	ErrInvalidSignature              uint64 = 6
	ErrThresholdNotMet               uint64 = 7
	ErrInvalidValidatorsAndThreshold uint64 = 8
	ErrAlreadyInitialized            uint64 = 9
	ErrInvalidMetadata               uint64 = 10
)

// AccessControlPDASeeds are access_control_pda_seeds!().
var AccessControlPDASeeds = [][]byte{[]byte("multisig_ism_message_id"), []byte("-"), []byte("access_control")}

// DomainDataPDASeeds are domain_data_pda_seeds!(domain).
func DomainDataPDASeeds(domain uint32) [][]byte { return multisigism.DomainDataPDASeeds(domain) }

// Instruction variants (Borsh enum indices, after the 8-byte
// PROGRAM_INSTRUCTION_DISCRIMINATOR).
const (
	InstructionInitialize                uint8 = 0
	InstructionSetValidatorsAndThreshold uint8 = 1
	InstructionGetOwner                  uint8 = 2
	InstructionTransferOwnership         uint8 = 3
)

// Instruction is the program-specific Instruction enum.
type Instruction struct {
	Kind uint8
	// SetValidatorsAndThreshold
	Domain uint32
	Config multisigism.ValidatorsAndThreshold
	// TransferOwnership
	NewOwner accesscontrol.Owner
}

func (ix *Instruction) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(ix.Kind)
	switch ix.Kind {
	case InstructionSetValidatorsAndThreshold:
		w.U32(ix.Domain)
		ix.Config.EncodeBorsh(w)
	case InstructionTransferOwnership:
		w.OptionTag(ix.NewOwner.Some)
		if ix.NewOwner.Some {
			w.Bytes32(ix.NewOwner.Value)
		}
	}
}

func (ix *Instruction) DecodeBorsh(r *borsh.Reader) {
	ix.Kind = r.EnumTag()
	switch ix.Kind {
	case InstructionInitialize, InstructionGetOwner:
	case InstructionSetValidatorsAndThreshold:
		ix.Domain = r.U32()
		ix.Config.DecodeBorsh(r)
	case InstructionTransferOwnership:
		ix.NewOwner.Some = r.OptionTag()
		if ix.NewOwner.Some {
			ix.NewOwner.Value = r.Bytes32()
		}
	default:
		r.Fail()
	}
}

// AccessControlData is the access control PDA's data.
type AccessControlData struct {
	BumpSeed uint8
	Owner    accesscontrol.Owner
}

func (a *AccessControlData) EncodeBorsh(w *borsh.Writer) {
	w.U8(a.BumpSeed)
	w.OptionTag(a.Owner.Some)
	if a.Owner.Some {
		w.Bytes32(a.Owner.Value)
	}
}

func (a *AccessControlData) DecodeBorsh(r *borsh.Reader) {
	a.BumpSeed = r.U8()
	a.Owner.Some = r.OptionTag()
	if a.Owner.Some {
		a.Owner.Value = r.Bytes32()
	}
}

// Size is SizedData::size: always bump + Option tag + pubkey.
func (a *AccessControlData) Size() int { return 1 + 1 + 32 }

// DomainData is a domain data PDA's data.
type DomainData struct {
	BumpSeed               uint8
	ValidatorsAndThreshold multisigism.ValidatorsAndThreshold
}

func (d *DomainData) EncodeBorsh(w *borsh.Writer) {
	w.U8(d.BumpSeed)
	d.ValidatorsAndThreshold.EncodeBorsh(w)
}

func (d *DomainData) DecodeBorsh(r *borsh.Reader) {
	d.BumpSeed = r.U8()
	d.ValidatorsAndThreshold.DecodeBorsh(r)
}

// Process is the program entrypoint.
func Process(c solana.Context) uint64 {
	data := solana.Instruction(c)
	if packageversioned.IsGetProgramVersion(data) {
		return packageversioned.ProcessGetProgramVersion(c)
	}

	if ix, code := ism.Decode(data); code == svm.Success {
		switch ix.Kind {
		case ism.KindType:
			out := [5]byte{byte(ISMType), byte(ISMType >> 8), byte(ISMType >> 16), byte(ISMType >> 24), accountmeta.SimulationReturnDataTrailer}
			return solana.SetReturnData(c, out[:])
		case ism.KindVerify:
			return verify(c, ix.Metadata, ix.Message)
		case ism.KindVerifyAccountMetas:
			msg, ok := hyperlanecore.DecodeMessage(ix.Message)
			if !ok {
				return svm.InvalidArgument
			}
			return domainPDAMetas(c, msg.Origin)
		case ism.KindVerifyMetadataSpec:
			msg, ok := hyperlanecore.DecodeMessage(ix.Message)
			if !ok {
				return svm.InvalidArgument
			}
			return metadataSpec(c, msg.Origin)
		}
	}

	if ix, code := multisigism.DecodeInstruction(data); code == svm.Success {
		msg, ok := hyperlanecore.DecodeMessage(ix.Message)
		if !ok {
			return svm.InvalidArgument
		}
		if ix.Kind == multisigism.KindValidatorsAndThreshold {
			return getValidatorsAndThreshold(c, msg.Origin)
		}
		return domainPDAMetas(c, msg.Origin)
	}

	ix, code := accountutils.DiscriminatorDecode[Instruction](accountutils.ProgramInstructionDiscriminator, data)
	if code != svm.Success {
		return code
	}
	switch ix.Kind {
	case InstructionInitialize:
		return initialize(c)
	case InstructionSetValidatorsAndThreshold:
		return setValidatorsAndThreshold(c, ix.Domain, &ix.Config)
	case InstructionGetOwner:
		return getOwner(c)
	}
	return transferOwnership(c, ix.NewOwner)
}

// initialize creates the access control PDA.
//
// Accounts:
// 0. `[signer]` The new owner and payer of the access control PDA.
// 1. `[writable]` The access control PDA account.
// 2. `[executable]` The system program account.
func initialize(c solana.Context) uint64 {
	it := svm.NewAccountIter(c)
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, owner) {
		return svm.MissingRequiredSignature
	}
	pda, code := it.Next()
	if code != svm.Success {
		return code
	}
	programID := svm.ProgramID(c)
	key, seeds, code := svm.FindProgramAddressSeeds(c, AccessControlPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, pda, key) {
		return ErrAccountOutOfOrder
	}
	if _, initialized, code := accountutils.FetchAccount[AccessControlData](c, pda); code == svm.Success && initialized {
		return ErrAlreadyInitialized
	}
	systemProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, systemProgram, svm.SystemProgramID) {
		return ErrAccountOutOfOrder
	}
	value := AccessControlData{BumpSeed: seeds.Bump(), Owner: borsh.SomeOf(svm.Key(c, owner))}
	if code := accountutils.CreatePDAAccount(c, owner, accountutils.AccountDataSize(&value), programID, systemProgram, pda, &seeds); code != svm.Success {
		return code
	}
	return accountutils.Store(c, pda, &value, false)
}

// verify checks a threshold of validator signatures over the message's
// checkpoint.
//
// Accounts:
// 0. `[]` The PDA relating to the message's origin domain.
func verify(c solana.Context, metadataBytes, messageBytes []byte) uint64 {
	metadata, e := multisigism.ParseMessageIDMetadata(metadataBytes)
	if e != multisigism.OK {
		return ErrInvalidMetadata
	}
	msg, ok := hyperlanecore.DecodeMessage(messageBytes)
	if !ok {
		return svm.InvalidArgument
	}
	it := svm.NewAccountIter(c)
	vt, code := validatorsAndThreshold(c, &it, msg.Origin)
	if code != svm.Success {
		return code
	}
	var id [32]byte
	if code := hyperlanecore.MessageID(c, messageBytes, 0, uint64(len(messageBytes)), id[:]); code != 0 {
		return code
	}
	hash, code := multisigism.CheckpointSigningHash(c, &metadata.OriginMerkleTreeHook, msg.Origin, &metadata.MerkleRoot, metadata.MerkleIndex, &id)
	if code != 0 {
		return code
	}
	e, code = multisigism.Verify(c, &hash, metadata.Signatures, vt.Validators, vt.Threshold)
	if code != 0 {
		return code
	}
	switch e {
	case multisigism.ErrInvalidSignature:
		return ErrInvalidSignature
	case multisigism.ErrThresholdNotMet:
		return ErrThresholdNotMet
	case multisigism.ErrInvalidMetadata:
		return ErrInvalidMetadata
	}
	return svm.Success
}

// domainPDAMetas returns the origin's domain data PDA as the only account
// (VerifyAccountMetas and ValidatorsAndThresholdAccountMetas).
func domainPDAMetas(c solana.Context, domain uint32) uint64 {
	key, _, code := svm.FindProgramAddress(c, DomainDataPDASeeds(domain), svm.ProgramID(c))
	if code != svm.Success {
		return code
	}
	var metas [1]accountmeta.SerializableAccountMeta
	metas[0] = accountmeta.Readonly(key, false)
	return solana.SetReturnData(c, accountmeta.EncodeMetasReturnData(metas[:]))
}

// getValidatorsAndThreshold returns SimulationReturnData<ValidatorsAndThreshold>.
//
// Accounts:
// 0. `[]` The PDA relating to the provided domain.
func getValidatorsAndThreshold(c solana.Context, domain uint32) uint64 {
	it := svm.NewAccountIter(c)
	vt, code := validatorsAndThreshold(c, &it, domain)
	if code != svm.Success {
		return code
	}
	w := borsh.NewWriter(vt.Size() + 1)
	vt.EncodeBorsh(&w)
	accountmeta.EndSimulationReturnData(&w)
	return solana.SetReturnData(c, w.Bytes())
}

// metadataSpec returns SimulationReturnData<MetadataSpecResult>.
//
// Accounts:
// 0. `[]` This program's VAM PDA.
// 1. `[]` (optional) The domain data PDA for the domain.
//
// Without a matching account 1 the spec is None and the accounts to retry
// with are [vam_pda, domain_pda].
func metadataSpec(c solana.Context, domain uint32) uint64 {
	programID := svm.ProgramID(c)
	vam, _, code := svm.FindProgramAddress(c, ism.VerifyAccountMetasPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	domainPDA, _, code := svm.FindProgramAddress(c, DomainDataPDASeeds(domain), programID)
	if code != svm.Success {
		return code
	}
	var result ism.MetadataSpecResult
	if solana.Count(c) < 2 || !svm.KeyIs(c, 1, domainPDA) {
		result.Accounts = [][32]byte{vam, domainPDA}
		return solana.SetReturnData(c, ism.EncodeMetadataSpecReturnData(&result))
	}
	it := svm.NewAccountIter(c)
	it.Next()
	vt, code := validatorsAndThreshold(c, &it, domain)
	if code != svm.Success {
		return code
	}
	result.Spec = borsh.SomeOf(ism.MetadataSpec{Kind: ism.SpecMultisigMessageID, Validators: vt.Validators, Threshold: vt.Threshold})
	return solana.SetReturnData(c, ism.EncodeMetadataSpecReturnData(&result))
}

// validatorsAndThreshold reads the domain data PDA at the iterator's next
// account: owner, then data, then key (from the stored bump).
func validatorsAndThreshold(c solana.Context, it *svm.AccountIter, domain uint32) (multisigism.ValidatorsAndThreshold, uint64) {
	var vt multisigism.ValidatorsAndThreshold
	pda, code := it.Next()
	if code != svm.Success {
		return vt, code
	}
	programID := svm.ProgramID(c)
	if !svm.OwnerIs(c, pda, programID) {
		return vt, ErrProgramIDNotOwner
	}
	data, initialized, code := accountutils.FetchAccount[DomainData](c, pda)
	if code != svm.Success {
		return vt, code
	}
	if !initialized {
		return vt, ErrAccountNotInitialized
	}
	key, code := svm.CreateProgramAddress(c, DomainDataPDASeeds(domain), data.BumpSeed, programID)
	if code != svm.Success {
		return vt, code
	}
	if !svm.KeyIs(c, pda, key) {
		return vt, ErrAccountOutOfOrder
	}
	return data.ValidatorsAndThreshold, svm.Success
}

// validate is ValidatorsAndThreshold::validate: 0 < threshold <= len and no
// duplicate validators.
func validate(vt *multisigism.ValidatorsAndThreshold) uint64 {
	n := len(vt.Validators)
	if vt.Threshold == 0 || int(vt.Threshold) > n {
		return ErrInvalidValidatorsAndThreshold
	}
	for i := 1; i < n; i++ {
		for j := 0; j < i; j++ {
			if vt.Validators[i] == vt.Validators[j] {
				return ErrInvalidValidatorsAndThreshold
			}
		}
	}
	return svm.Success
}

// setValidatorsAndThreshold sets a domain's validators and threshold,
// creating the domain data PDA if needed.
//
// Accounts:
// 0. `[signer]` The access control owner and payer of the domain PDA.
// 1. `[]` The access control PDA account.
// 2. `[writable]` The PDA relating to the provided domain.
// 3. `[executable]` OPTIONAL - The system program account. Required if creating the domain PDA.
func setValidatorsAndThreshold(c solana.Context, domain uint32, config *multisigism.ValidatorsAndThreshold) uint64 {
	if code := validate(config); code != svm.Success {
		return code
	}
	it := svm.NewAccountIter(c)
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	acPDA, code := it.Next()
	if code != svm.Success {
		return code
	}
	ac, code := accessControlData(c, acPDA)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, ac.Owner, owner); code != svm.Success {
		return code
	}
	domainPDA, code := it.Next()
	if code != svm.Success {
		return code
	}
	programID := svm.ProgramID(c)
	var bump uint8
	existing, initialized, code := accountutils.FetchAccount[DomainData](c, domainPDA)
	if code == svm.Success && initialized {
		key, code := svm.CreateProgramAddress(c, DomainDataPDASeeds(domain), existing.BumpSeed, programID)
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, domainPDA, key) {
			return ErrAccountOutOfOrder
		}
		if !svm.OwnerIs(c, domainPDA, programID) {
			return ErrProgramIDNotOwner
		}
		bump = existing.BumpSeed
	} else {
		// Initial size; the store below reallocates if needed.
		const domainPDASize = 1024
		key, seeds, code := svm.FindProgramAddressSeeds(c, DomainDataPDASeeds(domain), programID)
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, domainPDA, key) {
			return ErrAccountOutOfOrder
		}
		systemProgram, code := it.Next()
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, systemProgram, svm.SystemProgramID) {
			return ErrAccountOutOfOrder
		}
		if code := accountutils.CreatePDAAccount(c, owner, domainPDASize, programID, systemProgram, domainPDA, &seeds); code != svm.Success {
			return code
		}
		bump = seeds.Bump()
	}
	value := DomainData{BumpSeed: bump, ValidatorsAndThreshold: *config}
	return accountutils.Store(c, domainPDA, &value, true)
}

// getOwner returns SimulationReturnData<Option<Pubkey>>.
//
// Accounts:
// 0. `[]` The access control PDA account.
func getOwner(c solana.Context) uint64 {
	it := svm.NewAccountIter(c)
	pda, code := it.Next()
	if code != svm.Success {
		return code
	}
	ac, code := accessControlData(c, pda)
	if code != svm.Success {
		return code
	}
	w := borsh.NewWriter(34)
	w.OptionTag(ac.Owner.Some)
	if ac.Owner.Some {
		w.Bytes32(ac.Owner.Value)
	}
	accountmeta.EndSimulationReturnData(&w)
	return solana.SetReturnData(c, w.Bytes())
}

// accessControlData reads the access control PDA: data, then key (from the
// stored bump), then owner.
func accessControlData(c solana.Context, pda uint64) (AccessControlData, uint64) {
	ac, initialized, code := accountutils.FetchAccount[AccessControlData](c, pda)
	if code != svm.Success {
		return ac, code
	}
	if !initialized {
		return ac, ErrAccountNotInitialized
	}
	programID := svm.ProgramID(c)
	key, code := svm.CreateProgramAddress(c, AccessControlPDASeeds, ac.BumpSeed, programID)
	if code != svm.Success {
		return ac, code
	}
	if !svm.KeyIs(c, pda, key) {
		return ac, ErrAccountOutOfOrder
	}
	if !svm.OwnerIs(c, pda, programID) {
		return ac, ErrProgramIDNotOwner
	}
	return ac, svm.Success
}

// transferOwnership sets a new access control owner.
//
// Accounts:
// 0. `[signer]` The current access control owner.
// 1. `[writeable]` The access control PDA account.
//
// Rust also logs "Ownership transferred to {:?}" (no goSVM sol_log yet).
func transferOwnership(c solana.Context, newOwner accesscontrol.Owner) uint64 {
	it := svm.NewAccountIter(c)
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	pda, code := it.Next()
	if code != svm.Success {
		return code
	}
	ac, code := accessControlData(c, pda)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.TransferOwnership(c, &ac.Owner, owner, newOwner); code != svm.Success {
		return code
	}
	return accountutils.Store(c, pda, &ac, false)
}
