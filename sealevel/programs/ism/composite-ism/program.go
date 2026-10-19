// Package compositeism ports rust/sealevel/programs/ism/composite-ism: one
// program whose VAM PDA stores a tree of ISM nodes (aggregation, routing,
// fallback routing, amount routing, multisig, pausable, rate-limited,
// trusted relayer, test), with per-domain subtrees in domain PDAs.
//
// The Rust program walks the tree recursively. goSVM rejects recursion, so
// every walk here (Borsh codec, config validation, Verify, VerifyAccountMetas,
// VerifyMetadataSpec) is a loop over an explicit stack that visits nodes, and
// reports errors, in the same order as the Rust recursion. Rust's msg! lines
// are not emitted (goSVM has no logging yet).
package compositeism

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// DomainIsmSeed and ProcessAuthoritySeed are accounts::DOMAIN_ISM_SEED and
// accounts::PROCESS_AUTHORITY_SEED.
var (
	DomainIsmSeed        = []byte("domain_ism")
	ProcessAuthoritySeed = []byte("process_authority")
)

// BPFLoaderUpgradeableID is BPFLoaderUpgradeab1e11111111111111111111111.
var BPFLoaderUpgradeableID = svm.Pubkey{2, 168, 246, 145, 78, 136, 161, 176, 226, 16, 21, 62, 247, 99, 174, 43, 0, 194, 185, 61, 22, 193, 36, 210, 192, 83, 122, 16, 4, 128, 0, 0}

// package_versioned's GetProgramVersion discriminator and PACKAGE_VERSION.
const (
	getProgramVersion = "\x96\xe6\xb0\xa2\xec\x60\xb7\xab"
	packageVersion    = "1.0.0"
)

// Process is the program entrypoint (processor::process_instruction).
func Process(c solana.Context) uint64 {
	data := solana.Instruction(c)
	if string(data) == getProgramVersion {
		return getVersion(c)
	}
	if ix, code := ism.Decode(data); code == svm.Success {
		if ix.Kind == ism.KindType {
			return returnU32(c, hyperlanecore.ModuleTypeComposite)
		}
		message, ok := hyperlanecore.DecodeMessage(ix.Message)
		if !ok {
			return svm.InvalidArgument
		}
		switch ix.Kind {
		case ism.KindVerify:
			return verify(c, ix.Metadata, ix.Message, &message)
		case ism.KindVerifyAccountMetas:
			return verifyAccountMetas(c, ix.Metadata, ix.Message, &message)
		}
		return getMetadataSpec(c, ix.Message, &message)
	}

	ix, code := DecodeInstruction(data)
	if code != svm.Success {
		return code
	}
	switch ix.Kind {
	case IxInitialize:
		return initialize(c, &ix.Node)
	case IxUpdateConfig:
		return updateConfig(c, &ix.Node)
	case IxGetOwner:
		return getOwner(c)
	case IxTransferOwnership:
		return transferOwnership(c, ix.NewOwner)
	case IxSetDomainIsm:
		return setDomainIsm(c, ix.Domain, &ix.Node)
	case IxRemoveDomainIsm:
		return removeDomainIsm(c, ix.Domain)
	case IxPause:
		return setPaused(c, true)
	}
	return setPaused(c, false)
}

func getVersion(c solana.Context) uint64 {
	var b [4 + len(packageVersion) + 1]byte
	b[0] = byte(len(packageVersion))
	copy(b[4:], packageVersion)
	b[len(b)-1] = accountmeta.SimulationReturnDataTrailer
	return solana.SetReturnData(c, b[:])
}

func returnU32(c solana.Context, v uint32) uint64 {
	var out [5]byte
	out[0] = byte(v)
	out[1] = byte(v >> 8)
	out[2] = byte(v >> 16)
	out[3] = byte(v >> 24)
	out[4] = accountmeta.SimulationReturnDataTrailer
	return solana.SetReturnData(c, out[:])
}

// fetchStorage is CompositeIsmAccount::fetch_data into s. ok is false for
// empty or uninitialized data.
func fetchStorage(data []byte, s *Storage) (bool, uint64) {
	if len(data) == 0 {
		return false, svm.Success
	}
	r := borsh.NewReader(data)
	if !r.Bool() {
		if !r.Ok() {
			return false, svm.BorshIoError
		}
		return false, svm.Success
	}
	s.DecodeBorsh(&r)
	if !r.Ok() {
		return false, svm.BorshIoError
	}
	return true, svm.Success
}

// fetchDomainStorage is DomainIsmAccount::fetch_data into s.
func fetchDomainStorage(data []byte, s *DomainStorage) (bool, uint64) {
	if len(data) == 0 {
		return false, svm.Success
	}
	r := borsh.NewReader(data)
	if !r.Bool() {
		if !r.Ok() {
			return false, svm.BorshIoError
		}
		return false, svm.Success
	}
	s.DecodeBorsh(&r)
	if !r.Ok() {
		return false, svm.BorshIoError
	}
	return true, svm.Success
}

// loadStorage is load_and_verify_storage.
func loadStorage(c solana.Context, i uint64, programID *svm.Pubkey) (*Storage, uint64) {
	if !svm.OwnerIs(c, i, *programID) {
		return nil, ErrProgramIDNotOwner
	}
	s := new(Storage)
	ok, code := fetchStorage(solana.Data(c, i), s)
	if code != svm.Success {
		return nil, code
	}
	if !ok {
		return nil, ErrAccountNotInitialized
	}
	key, code := svm.CreateProgramAddress(c, ism.VerifyAccountMetasPDASeeds, s.BumpSeed, *programID)
	if code != svm.Success {
		return nil, code
	}
	if !svm.KeyIs(c, i, key) {
		return nil, ErrInvalidStoragePda
	}
	return s, svm.Success
}

func domainSeeds(domain uint32, le *[4]byte) [][]byte {
	le[0] = byte(domain)
	le[1] = byte(domain >> 8)
	le[2] = byte(domain >> 16)
	le[3] = byte(domain >> 24)
	return [][]byte{DomainIsmSeed, le[:]}
}

// deriveDomainPDA is accounts::derive_domain_pda.
func deriveDomainPDA(c solana.Context, programID *svm.Pubkey, domain uint32) (svm.Pubkey, uint64) {
	var le [4]byte
	key, _, code := svm.FindProgramAddress(c, domainSeeds(domain, &le), *programID)
	return key, code
}

// loadDomainStorage is load_and_validate_domain_ism_storage: nil when the
// account is not owned by this program.
func loadDomainStorage(c solana.Context, programID *svm.Pubkey, domain uint32, i uint64) (*DomainStorage, uint64) {
	if !svm.OwnerIs(c, i, *programID) {
		return nil, svm.Success
	}
	s := new(DomainStorage)
	ok, code := fetchDomainStorage(solana.Data(c, i), s)
	if code != svm.Success {
		return nil, code
	}
	if !ok {
		return nil, svm.UninitializedAccount
	}
	var le [4]byte
	key, code := svm.CreateProgramAddress(c, domainSeeds(domain, &le), s.BumpSeed, *programID)
	if code != svm.Success {
		return nil, svm.InvalidSeeds
	}
	if !svm.KeyIs(c, i, key) {
		return nil, svm.InvalidAccountData
	}
	return s, svm.Success
}

// parseUpgradeAuthority is parse_program_data_upgrade_authority.
func parseUpgradeAuthority(data []byte) (svm.Pubkey, bool, uint64) {
	var key svm.Pubkey
	if len(data) < 13 || data[12] == 0 {
		return key, false, svm.Success
	}
	if len(data) < 45 {
		return key, false, svm.InvalidAccountData
	}
	copy(key[:], data[13:45])
	return key, true, svm.Success
}

// initialize creates the storage PDA.
//
// Accounts:
// 0. `[signer]` The new owner and payer (the upgrade authority, if any).
// 1. `[writable]` The storage PDA.
// 2. `[executable]` The system program.
// 3. `[]` The program's BPF upgradeable loader ProgramData account.
func initialize(c solana.Context, root *IsmNode) uint64 {
	programID := svm.ProgramID(c)
	if code := validateConfig(&programID, root); code != svm.Success {
		return code
	}
	normalize(root)

	it := svm.NewAccountIter(c)
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, owner) {
		return svm.MissingRequiredSignature
	}
	storageAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	key, seeds, code := svm.FindProgramAddressSeeds(c, ism.VerifyAccountMetasPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, storageAcct, key) {
		return ErrInvalidStoragePda
	}
	if ok, code := fetchStorage(solana.Data(c, storageAcct), new(Storage)); ok && code == svm.Success {
		return ErrAlreadyInitialized
	}
	system, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, system, svm.SystemProgramID) {
		return ErrInvalidSystemProgram
	}
	programData, code := it.Next()
	if code != svm.Success {
		return code
	}
	programDataKey, _, code := svm.FindProgramAddress(c, [][]byte{programID[:]}, BPFLoaderUpgradeableID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, programData, programDataKey) {
		return ErrInvalidProgramDataAccount
	}
	if svm.OwnerIs(c, programData, BPFLoaderUpgradeableID) {
		authority, has, code := parseUpgradeAuthority(solana.Data(c, programData))
		if code != svm.Success {
			return code
		}
		if has && !svm.KeyIs(c, owner, authority) {
			return svm.MissingRequiredSignature
		}
	}

	storage := new(Storage)
	storage.BumpSeed = seeds.Bump()
	storage.Owner = borsh.SomeOf(svm.Key(c, owner))
	storage.Root = borsh.SomeOf(*root)
	if code := accountutils.CreatePDAAccount(c, owner, accountutils.AccountDataSize(storage), programID, system, storageAcct, &seeds); code != svm.Success {
		return code
	}
	return accountutils.Store(c, storageAcct, storage, false)
}

// updateConfig replaces the root ISM node. Owner-gated.
//
// Accounts:
// 0. `[signer]` The owner (payer for any rent top-up).
// 1. `[writable]` The storage PDA.
// 2. `[executable]` The system program.
func updateConfig(c solana.Context, root *IsmNode) uint64 {
	programID := svm.ProgramID(c)
	if code := validateConfig(&programID, root); code != svm.Success {
		return code
	}
	normalize(root)

	it := svm.NewAccountIter(c)
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	storageAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	system, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, system, svm.SystemProgramID) {
		return ErrInvalidSystemProgram
	}
	storage, code := loadStorage(c, storageAcct, &programID)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, storage.Owner, owner); code != svm.Success {
		return code
	}
	storage.Root = borsh.SomeOf(*root)
	return accountutils.StoreWithRentExemptRealloc(c, storageAcct, storage, owner, system)
}

// setDomainIsm creates or updates the domain PDA for a Routing table.
//
// Accounts:
// 0. `[signer]` The owner.
// 1. `[]` The storage PDA.
// 2. `[writable]` The domain PDA.
// 3. `[executable]` The system program.
func setDomainIsm(c solana.Context, domain uint32, node *IsmNode) uint64 {
	if code := validateDomainIsm(node); code != svm.Success {
		return code
	}
	normalize(node)

	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	storageAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	domainAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	system, code := it.Next()
	if code != svm.Success {
		return code
	}
	storage, code := loadStorage(c, storageAcct, &programID)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, storage.Owner, owner); code != svm.Success {
		return code
	}
	var le [4]byte
	expected, seeds, code := svm.FindProgramAddressSeeds(c, domainSeeds(domain, &le), programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, domainAcct, expected) {
		return ErrInvalidDomainPda
	}
	if !svm.KeyIs(c, system, svm.SystemProgramID) {
		return ErrInvalidSystemProgram
	}

	ds := new(DomainStorage)
	ds.BumpSeed = seeds.Bump()
	ds.Domain = domain
	ds.Ism = borsh.SomeOf(*node)
	if svm.DataIsEmpty(c, domainAcct) {
		if code := accountutils.VerifyAccountUninitialized(c, domainAcct); code != svm.Success {
			return code
		}
		if code := accountutils.CreatePDAAccount(c, owner, accountutils.AccountDataSize(ds), programID, system, domainAcct, &seeds); code != svm.Success {
			return code
		}
		return accountutils.Store(c, domainAcct, ds, false)
	}
	return accountutils.StoreWithRentExemptRealloc(c, domainAcct, ds, owner, system)
}

// removeDomainIsm closes a domain PDA, returning its rent to the owner.
//
// Accounts:
// 0. `[signer, writable]` The owner.
// 1. `[]` The storage PDA.
// 2. `[writable]` The domain PDA.
func removeDomainIsm(c solana.Context, domain uint32) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	storageAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	domainAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	storage, code := loadStorage(c, storageAcct, &programID)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, storage.Owner, owner); code != svm.Success {
		return code
	}
	expected, code := deriveDomainPDA(c, &programID, domain)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, domainAcct, expected) {
		return ErrInvalidDomainPda
	}
	if !svm.OwnerIs(c, domainAcct, programID) {
		return ErrProgramIDNotOwner
	}
	// AccountInfoExt::close_account.
	if !solana.Writable(c, domainAcct) || svm.SameKey(c, domainAcct, owner) {
		return svm.InvalidAccountData
	}
	switch solana.CloseAccount(c, domainAcct, owner) {
	case 0:
		return svm.Success
	case 2014:
		return svm.ArithmeticOverflow
	case 2010:
		return svm.InvalidRealloc
	}
	// The refund account is read-only or executable. Rust moves the lamports
	// anyway and the runtime rejects the instruction afterwards.
	return svm.InvalidAccountData
}

// getOwner returns the owner as SimulationReturnData<Option<Pubkey>>.
//
// Accounts:
// 0. `[]` The storage PDA.
func getOwner(c solana.Context) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	storageAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	storage, code := loadStorage(c, storageAcct, &programID)
	if code != svm.Success {
		return code
	}
	var out [34]byte
	n := 1
	if storage.Owner.Some {
		out[0] = 1
		copy(out[1:33], storage.Owner.Value[:])
		n = 33
	}
	out[n] = accountmeta.SimulationReturnDataTrailer
	return solana.SetReturnData(c, out[:n+1])
}

// transferOwnership changes the owner.
//
// Accounts:
// 0. `[signer]` The current owner.
// 1. `[writable]` The storage PDA.
func transferOwnership(c solana.Context, newOwner borsh.Option[[32]byte]) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	storageAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	storage, code := loadStorage(c, storageAcct, &programID)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.TransferOwnership(c, &storage.Owner, owner, newOwner); code != svm.Success {
		return code
	}
	return accountutils.Store(c, storageAcct, storage, false)
}

// setPaused sets every Pausable node of the root tree. Owner-gated.
//
// Accounts:
// 0. `[signer]` The owner.
// 1. `[writable]` The storage PDA.
func setPaused(c solana.Context, paused bool) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	storageAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	storage, code := loadStorage(c, storageAcct, &programID)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, storage.Owner, owner); code != svm.Success {
		return code
	}
	if storage.Root.Some {
		flipPausable(&storage.Root.Value, paused)
	}
	return accountutils.Store(c, storageAcct, storage, false)
}
