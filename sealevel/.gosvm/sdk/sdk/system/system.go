// Package system provides bounded rent-funded account creation and transfers.
package system

import (
	"gosvm/sdk/cpi"
	"gosvm/sdk/pda"
	"gosvm/solana"
)

const ErrProgram uint64 = 3021
const ErrAccount uint64 = 3022
const ErrAuthority uint64 = 3023
const ErrSize uint64 = 3024

func zeroKey(b []byte) bool {
	if len(b) != 32 {
		return false
	}
	for j := uint64(0); j < 32; j++ {
		if b[j] != 0 {
			return false
		}
	}
	return true
}

func sameKey(a, b []byte) bool {
	if len(a) != 32 || len(b) != 32 {
		return false
	}
	for j := uint64(0); j < 32; j++ {
		if a[j] != b[j] {
			return false
		}
	}
	return true
}

func validate(c solana.Context, program, payer, account uint64) uint64 {
	if program >= solana.Count(c) || !solana.Executable(c, program) || !zeroKey(solana.Key(c, program)) {
		return ErrProgram
	}
	if payer >= solana.Count(c) || account >= solana.Count(c) {
		return ErrAccount
	}
	if !solana.Writable(c, payer) || !solana.Writable(c, account) || solana.Executable(c, payer) || solana.Executable(c, account) || len(solana.Key(c, payer)) != 32 || len(solana.Key(c, account)) != 32 || sameKey(solana.Key(c, payer), solana.Key(c, account)) {
		return ErrAccount
	}
	if !solana.Signer(c, payer) {
		return ErrAuthority
	}
	if !zeroKey(solana.Owner(c, payer)) || len(solana.Data(c, payer)) != 0 {
		return ErrAccount
	}
	return 0
}

// Create funds at least one lamport and the target's current rent minimum, then
// assigns the supplied owner. The one-lamport floor retains accounts at free rent.
// The payer and new target must be transaction signers. Target is an empty,
// unfunded System account; initial allocation is bounded to the CPI 10 KiB cap.
func Create(c solana.Context, program, payer, account, size uint64, owner [32]byte) uint64 {
	return create(c, program, payer, account, size, owner, nil)
}

// CreateSigned supplies the new target's PDA seeds under the calling program.
// The payer must still be a transaction signer. It does not search for a bump.
func CreateSigned(c solana.Context, program, payer, account, size uint64, owner [32]byte, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return create(c, program, payer, account, size, owner, seeds)
}

func create(c solana.Context, program, payer, account, size uint64, owner [32]byte, seeds *pda.Seeds) uint64 {
	code := validate(c, program, payer, account)
	if code != 0 {
		return code
	}
	if size > 10240 {
		return ErrSize
	}
	if !zeroKey(solana.Owner(c, account)) || len(solana.Data(c, account)) != 0 || solana.Lamports(c, account) != 0 {
		return ErrAccount
	}
	code = authorize(c, account, seeds)
	if code != 0 {
		return code
	}
	lamports, status := MinimumBalance(c, size)
	if status != 0 {
		return status
	}
	if lamports == 0 {
		lamports = 1
	}
	var data [52]byte // System CreateAccount: u32 opcode, u64 lamports/space, key.
	for j := uint64(0); j < 8; j++ {
		data[4+j] = byte(lamports >> (j * 8))
		data[12+j] = byte(size >> (j * 8))
	}
	for j := uint64(0); j < 32; j++ {
		data[20+j] = owner[j]
	}
	var metas cpi.Metas
	if metas.Add(payer, true, true) != 0 || metas.Add(account, true, true) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], seeds)
}

// authorize requires a transaction signature for nil seeds, otherwise that the
// account is the seeds' PDA under the calling program. It does not search bumps.
func authorize(c solana.Context, account uint64, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		if !solana.Signer(c, account) {
			return ErrAuthority
		}
		return 0
	}
	programKey := solana.ProgramID(c)
	if len(programKey) != 32 {
		return ErrAuthority
	}
	var id [32]byte
	for j := uint64(0); j < 32; j++ {
		id[j] = programKey[j]
	}
	matches, status := seeds.Matches(c, account, id)
	if status != 0 {
		return status
	}
	if !matches {
		return ErrAuthority
	}
	return 0
}

func invoke(c solana.Context, program uint64, metas *cpi.Metas, data []byte, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return cpi.Invoke(c, program, metas, data, nil)
	}
	var signers cpi.Signers
	code := signers.Add(seeds)
	if code != 0 {
		return code
	}
	return cpi.Invoke(c, program, metas, data, &signers)
}

// Transfer requires a writable empty System payer with a transaction signature.
// Real System errors, including insufficient funds, propagate unchanged.
func Transfer(c solana.Context, program, payer, account, amount uint64) uint64 {
	code := validate(c, program, payer, account)
	if code != 0 {
		return code
	}
	var data [12]byte
	data[0] = 2
	for j := uint64(0); j < 8; j++ {
		data[4+j] = byte(amount >> (j * 8))
	}
	var metas cpi.Metas
	if metas.Add(payer, true, true) != 0 || metas.Add(account, true, false) != 0 {
		return cpi.ErrMetas
	}
	return cpi.Invoke(c, program, &metas, data[:], nil)
}

// TransferSigned moves lamports out of a data-less System-owned PDA under the
// calling program, such as a native-SOL vault, signing with its seeds. The
// destination is a distinct writable, non-executable account. System errors,
// including insufficient funds, propagate unchanged.
func TransferSigned(c solana.Context, program, source, destination, amount uint64, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	code := validatePair(c, program, source, destination)
	if code != 0 {
		return code
	}
	if !zeroKey(solana.Owner(c, source)) || len(solana.Data(c, source)) != 0 {
		return ErrAccount
	}
	code = authorize(c, source, seeds)
	if code != 0 {
		return code
	}
	var data [12]byte
	data[0] = 2
	for j := uint64(0); j < 8; j++ {
		data[4+j] = byte(amount >> (j * 8))
	}
	var metas cpi.Metas
	if metas.Add(source, true, true) != 0 || metas.Add(destination, true, false) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], seeds)
}

// Allocate sets the data length of an empty System-owned transaction signer.
// It does not fund rent; the transaction fails if the result is not exempt.
func Allocate(c solana.Context, program, account, size uint64) uint64 {
	return allocate(c, program, account, size, nil)
}

// AllocateSigned allocates a PDA under the calling program with its seeds.
func AllocateSigned(c solana.Context, program, account, size uint64, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return allocate(c, program, account, size, seeds)
}

func allocate(c solana.Context, program, account, size uint64, seeds *pda.Seeds) uint64 {
	code := validateTarget(c, program, account, false, seeds)
	if code != 0 {
		return code
	}
	if size > 10240 {
		return ErrSize
	}
	var data [12]byte
	data[0] = 8
	for j := uint64(0); j < 8; j++ {
		data[4+j] = byte(size >> (j * 8))
	}
	var metas cpi.Metas
	if metas.Add(account, true, true) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], seeds)
}

// Assign transfers a System-owned transaction signer whose data is empty or
// all zero, such as a just-allocated account, to owner.
func Assign(c solana.Context, program, account uint64, owner [32]byte) uint64 {
	return assign(c, program, account, owner, nil)
}

// AssignSigned assigns a PDA under the calling program with its seeds.
func AssignSigned(c solana.Context, program, account uint64, owner [32]byte, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return assign(c, program, account, owner, seeds)
}

func assign(c solana.Context, program, account uint64, owner [32]byte, seeds *pda.Seeds) uint64 {
	code := validateTarget(c, program, account, true, seeds)
	if code != 0 {
		return code
	}
	var data [36]byte
	data[0] = 1
	for j := uint64(0); j < 32; j++ {
		data[4+j] = owner[j]
	}
	var metas cpi.Metas
	if metas.Add(account, true, true) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], seeds)
}

// CreatePDA creates a PDA under the calling program even when its address
// already holds lamports, which makes CreateAccount fail. An unfunded target
// uses CreateSigned. A funded one is topped up from the payer to the current
// rent minimum (at least one lamport), then allocated and assigned with its
// seeds. The payer still needs a transaction signature. The target must be an
// empty System-owned account.
func CreatePDA(c solana.Context, program, payer, account, size uint64, owner [32]byte, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	if account >= solana.Count(c) {
		return ErrAccount
	}
	if solana.Lamports(c, account) == 0 {
		return create(c, program, payer, account, size, owner, seeds)
	}
	code := validate(c, program, payer, account)
	if code != 0 {
		return code
	}
	if size > 10240 {
		return ErrSize
	}
	if !zeroKey(solana.Owner(c, account)) || len(solana.Data(c, account)) != 0 {
		return ErrAccount
	}
	code = authorize(c, account, seeds)
	if code != 0 {
		return code
	}
	lamports, status := MinimumBalance(c, size)
	if status != 0 {
		return status
	}
	if lamports == 0 {
		lamports = 1
	}
	current := solana.Lamports(c, account)
	if current < lamports {
		code = Transfer(c, program, payer, account, lamports-current)
		if code != 0 {
			return code
		}
	}
	code = allocate(c, program, account, size, seeds)
	if code != 0 {
		return code
	}
	return assign(c, program, account, owner, seeds)
}

// validatePair checks the System program and two distinct writable,
// non-executable accounts, without payer signer or ownership policy.
func validatePair(c solana.Context, program, source, destination uint64) uint64 {
	if program >= solana.Count(c) || !solana.Executable(c, program) || !zeroKey(solana.Key(c, program)) {
		return ErrProgram
	}
	if source >= solana.Count(c) || destination >= solana.Count(c) {
		return ErrAccount
	}
	if !solana.Writable(c, source) || !solana.Writable(c, destination) || solana.Executable(c, source) || solana.Executable(c, destination) || len(solana.Key(c, source)) != 32 || len(solana.Key(c, destination)) != 32 || sameKey(solana.Key(c, source), solana.Key(c, destination)) {
		return ErrAccount
	}
	return 0
}

// validateTarget checks the System program and a writable, non-executable,
// System-owned account authorized by its signature or PDA seeds. Its data must
// be empty, or with zeroed set, all zero bytes.
func validateTarget(c solana.Context, program, account uint64, zeroed bool, seeds *pda.Seeds) uint64 {
	if program >= solana.Count(c) || !solana.Executable(c, program) || !zeroKey(solana.Key(c, program)) {
		return ErrProgram
	}
	if account >= solana.Count(c) {
		return ErrAccount
	}
	if !solana.Writable(c, account) || solana.Executable(c, account) || len(solana.Key(c, account)) != 32 || !zeroKey(solana.Owner(c, account)) {
		return ErrAccount
	}
	data := solana.Data(c, account)
	if len(data) != 0 && !zeroed {
		return ErrAccount
	}
	for j := uint64(0); j < uint64(len(data)); j++ {
		if data[j] != 0 {
			return ErrAccount
		}
	}
	return authorize(c, account, seeds)
}
