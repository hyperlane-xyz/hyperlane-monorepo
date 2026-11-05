// Package validatorannounce ports rust/sealevel/programs/validator-announce:
// validators publicly announce their signature storage locations.
package validatorannounce

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	ecdsa "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/ecdsa-signature"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Error codes (ProgramError::Custom). SignerMismatch is defined but unused
// in Rust too: a wrong signer is InvalidAccountData.
const (
	ErrSignatureError uint64 = 1
	ErrSignerMismatch uint64 = 2
)

// ValidatorAnnouncePDASeeds are validator_announce_pda_seeds!().
var ValidatorAnnouncePDASeeds = [][]byte{[]byte("hyperlane_validator_announce"), []byte("-"), []byte("validator_announce")}

// StorageLocationsPDASeeds are validator_storage_locations_pda_seeds!(validator).
func StorageLocationsPDASeeds(validator *[20]byte) [][]byte {
	return [][]byte{[]byte("hyperlane_validator_announce"), []byte("-"), []byte("storage_locations"), []byte("-"), validator[:]}
}

// ReplayProtectionPDASeeds are replay_protection_pda_seeds!(replay_id).
func ReplayProtectionPDASeeds(replayID *[32]byte) [][]byte {
	return [][]byte{[]byte("hyperlane_validator_announce"), []byte("-"), []byte("replay_protection"), []byte("-"), replayID[:]}
}

// Instruction variants (Borsh enum indices).
const (
	InstructionInit     uint8 = 0
	InstructionAnnounce uint8 = 1
)

// Instruction is the Borsh Instruction enum: Init{mailbox, local_domain} or
// Announce{validator, storage_location, signature}.
type Instruction struct {
	Kind            uint8
	Mailbox         [32]byte
	LocalDomain     uint32
	Validator       [20]byte
	StorageLocation string
	Signature       []byte
}

func (ix *Instruction) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(ix.Kind)
	switch ix.Kind {
	case InstructionInit:
		w.Bytes32(ix.Mailbox)
		w.U32(ix.LocalDomain)
	case InstructionAnnounce:
		w.Bytes20(ix.Validator)
		w.String(ix.StorageLocation)
		w.ByteVec(ix.Signature)
	}
}

// DecodeBorsh reads the instruction; Signature is a view into the input.
func (ix *Instruction) DecodeBorsh(r *borsh.Reader) {
	ix.Kind = r.EnumTag()
	switch ix.Kind {
	case InstructionInit:
		ix.Mailbox = r.Bytes32()
		ix.LocalDomain = r.U32()
	case InstructionAnnounce:
		ix.Validator = r.Bytes20()
		ix.StorageLocation = r.String()
		ix.Signature = r.ByteVecView()
	default:
		r.Fail()
	}
}

// ReplayID is AnnounceInstruction::replay_id: keccak(validator || location).
func ReplayID(c solana.Context, validator *[20]byte, location string) ([32]byte, uint64) {
	buf := make([]byte, 20+len(location))
	copy(buf, validator[:])
	copy(buf[20:], location)
	var id [32]byte
	code := solana.Keccak256(c, buf, 0, uint64(len(buf)), id[:], 0)
	return id, code
}

// ValidatorAnnounce is the ValidatorAnnounce PDA's data.
type ValidatorAnnounce struct {
	BumpSeed    uint8
	Mailbox     [32]byte
	LocalDomain uint32
}

func (v *ValidatorAnnounce) EncodeBorsh(w *borsh.Writer) {
	w.U8(v.BumpSeed)
	w.Bytes32(v.Mailbox)
	w.U32(v.LocalDomain)
}

func (v *ValidatorAnnounce) DecodeBorsh(r *borsh.Reader) {
	v.BumpSeed = r.U8()
	v.Mailbox = r.Bytes32()
	v.LocalDomain = r.U32()
}

// Size is SizedData::size.
func (v *ValidatorAnnounce) Size() int { return 1 + 32 + 4 }

// StorageLocations is ValidatorStorageLocations.
type StorageLocations struct {
	BumpSeed         uint8
	StorageLocations []string
}

func (s *StorageLocations) EncodeBorsh(w *borsh.Writer) {
	w.U8(s.BumpSeed)
	borsh.WriteVec(w, s.StorageLocations, borsh.WriteString)
}

func (s *StorageLocations) DecodeBorsh(r *borsh.Reader) {
	s.BumpSeed = r.U8()
	s.StorageLocations = borsh.ReadVec(r, borsh.ReadString)
}

// Size is SizedData::size: bump, Vec length, then each String.
func (s *StorageLocations) Size() int {
	n := 1 + 4
	for i := range s.StorageLocations {
		n += 4 + len(s.StorageLocations[i])
	}
	return n
}

// ReplayProtection is the empty ReplayProtection(()) data.
type ReplayProtection struct{}

func (p *ReplayProtection) EncodeBorsh(w *borsh.Writer) {}
func (p *ReplayProtection) DecodeBorsh(r *borsh.Reader) {}
func (p *ReplayProtection) Size() int                   { return 0 }

// Process is the program entrypoint.
func Process(c solana.Context) uint64 {
	data := solana.Instruction(c)
	if packageversioned.IsGetProgramVersion(data) {
		return packageversioned.ProcessGetProgramVersion(c)
	}
	var ix Instruction
	r := borsh.NewReader(data)
	ix.DecodeBorsh(&r)
	if !r.Done() {
		return svm.InvalidInstructionData
	}
	if ix.Kind == InstructionInit {
		return processInit(c, &ix)
	}
	return processAnnounce(c, &ix)
}

// processInit creates the ValidatorAnnounce PDA.
//
// Accounts:
// 0. `[signer]` The payer.
// 1. `[executable]` The system program.
// 2. `[writable]` The ValidatorAnnounce PDA account.
func processInit(c solana.Context, ix *Instruction) uint64 {
	it := svm.NewAccountIter(c)
	payer, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, payer) {
		return svm.MissingRequiredSignature
	}
	systemProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, systemProgram, svm.SystemProgramID) {
		return svm.IncorrectProgramID
	}
	va, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Writable(c, va) {
		return svm.InvalidAccountData
	}
	if !svm.OwnerIs(c, va, svm.SystemProgramID) || !svm.DataIsEmpty(c, va) {
		return svm.AccountAlreadyInitialized
	}
	programID := svm.ProgramID(c)
	key, seeds, code := svm.FindProgramAddressSeeds(c, ValidatorAnnouncePDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, va, key) {
		return svm.IncorrectProgramID
	}
	value := ValidatorAnnounce{BumpSeed: seeds.Bump(), Mailbox: ix.Mailbox, LocalDomain: ix.LocalDomain}
	if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(&value), programID, systemProgram, va, &seeds); code != svm.Success {
		return code
	}
	return accountutils.Store(c, va, &value, false)
}

// processAnnounce records a validator's signed storage location.
//
// Accounts:
// 0. `[signer]` The payer.
// 1. `[executable]` The system program.
// 2. `[]` The ValidatorAnnounce PDA account.
// 3. `[writeable]` The validator-specific ValidatorStorageLocationsAccount PDA account.
// 4. `[writeable]` The ReplayProtection PDA account specific to the announcement being made.
func processAnnounce(c solana.Context, ix *Instruction) uint64 {
	it := svm.NewAccountIter(c)
	payer, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, payer) {
		return svm.MissingRequiredSignature
	}
	systemProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, systemProgram, svm.SystemProgramID) {
		return svm.IncorrectProgramID
	}
	vaInfo, code := it.Next()
	if code != svm.Success {
		return code
	}
	va, _, code := accountutils.FetchAccount[ValidatorAnnounce](c, vaInfo)
	if code != svm.Success {
		return code
	}
	programID := svm.ProgramID(c)
	// verify_self_account_info.
	expected, code := svm.CreateProgramAddress(c, ValidatorAnnouncePDASeeds, va.BumpSeed, programID)
	if code != svm.Success {
		return code
	}
	if !svm.OwnerIs(c, vaInfo, programID) || !svm.KeyIs(c, vaInfo, expected) {
		return svm.InvalidAccountData
	}
	locations, code := it.Next()
	if code != svm.Success {
		return code
	}
	replay, code := it.Next()
	if code != svm.Success {
		return code
	}
	replayID, code := ReplayID(c, &ix.Validator, ix.StorageLocation)
	if code != 0 {
		return code
	}
	replayKey, replaySeeds, code := svm.FindProgramAddressSeeds(c, ReplayProtectionPDASeeds(&replayID), programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, replay, replayKey) {
		return svm.IncorrectProgramID
	}
	if !solana.Writable(c, replay) {
		return svm.InvalidAccountData
	}
	if !svm.DataIsEmpty(c, replay) {
		return svm.AccountAlreadyInitialized
	}
	if code := verifySignedAnnouncement(c, ix, &va); code != svm.Success {
		return code
	}
	if code := updateStorageLocations(c, payer, systemProgram, locations, ix); code != svm.Success {
		return code
	}
	var rp ReplayProtection
	return accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(&rp), programID, systemProgram, replay, &replaySeeds)
}

// updateStorageLocations appends the location to the validator's storage
// locations PDA, creating it on the first announcement.
func updateStorageLocations(c solana.Context, payer, systemProgram, info uint64, ix *Instruction) uint64 {
	programID := svm.ProgramID(c)
	var value StorageLocations
	var newSize uint64
	if svm.OwnerIs(c, info, programID) && !svm.DataIsEmpty(c, info) {
		existing, _, code := accountutils.FetchAccount[StorageLocations](c, info)
		if code != svm.Success {
			return code
		}
		key, code := svm.CreateProgramAddress(c, StorageLocationsPDASeeds(&ix.Validator), existing.BumpSeed, programID)
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, info, key) {
			return svm.IncorrectProgramID
		}
		newSize = uint64(len(solana.Data(c, info))) + 4 + uint64(len(ix.StorageLocation))
		value = existing
		value.StorageLocations = append(value.StorageLocations, ix.StorageLocation)
	} else {
		key, seeds, code := svm.FindProgramAddressSeeds(c, StorageLocationsPDASeeds(&ix.Validator), programID)
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, info, key) {
			return svm.IncorrectProgramID
		}
		value.BumpSeed = seeds.Bump()
		value.StorageLocations = []string{ix.StorageLocation}
		newSize = accountutils.AccountDataSize(&value)
		if code := accountutils.CreatePDAAccount(c, payer, newSize, programID, systemProgram, info, &seeds); code != svm.Success {
			return code
		}
	}
	// A realloc may follow: keep the account rent exempt.
	existingSize := uint64(len(solana.Data(c, info)))
	rent, code := svm.MinimumBalance(c, newSize)
	if code != svm.Success {
		return code
	}
	lamports := solana.Lamports(c, info)
	if lamports < rent {
		if code := svm.SystemTransfer(c, systemProgram, payer, info, rent-lamports, nil); code != svm.Success {
			return code
		}
	}
	if existingSize != newSize {
		if code := accountutils.Resize(c, info, newSize); code != svm.Success {
			return code
		}
	}
	return accountutils.Store(c, info, &value, false)
}

const announcementDomainTag = "HYPERLANE_ANNOUNCEMENT"

// verifySignedAnnouncement checks that the validator signed the
// Announcement {validator, mailbox, local domain, storage location}.
func verifySignedAnnouncement(c solana.Context, ix *Instruction, va *ValidatorAnnounce) uint64 {
	// signing_hash = keccak(announcement_domain_hash(mailbox, domain) || location),
	// announcement_domain_hash = keccak(domain (u32 BE) || mailbox || "HYPERLANE_ANNOUNCEMENT").
	var dh [4 + 32 + len(announcementDomainTag)]byte
	dh[0] = byte(va.LocalDomain >> 24)
	dh[1] = byte(va.LocalDomain >> 16)
	dh[2] = byte(va.LocalDomain >> 8)
	dh[3] = byte(va.LocalDomain)
	copy(dh[4:], va.Mailbox[:])
	copy(dh[36:], announcementDomainTag)
	buf := make([]byte, 32+len(ix.StorageLocation))
	if code := solana.Keccak256(c, dh[:], 0, uint64(len(dh)), buf, 0); code != 0 {
		return code
	}
	copy(buf[32:], ix.StorageLocation)
	var signingHash [32]byte
	if code := solana.Keccak256(c, buf, 0, uint64(len(buf)), signingHash[:], 0); code != 0 {
		return code
	}
	digest, code := ecdsa.EthSignedMessageHash(c, &signingHash)
	if code != 0 {
		return code
	}
	var sig ecdsa.EcdsaSignature
	if sig.Parse(ix.Signature) != ecdsa.OK {
		return ErrSignatureError
	}
	signer, code := sig.RecoverEthereumAddress(c, digest[:])
	if code != 0 {
		return ErrSignatureError
	}
	if signer != ix.Validator {
		return svm.InvalidAccountData
	}
	return svm.Success
}
