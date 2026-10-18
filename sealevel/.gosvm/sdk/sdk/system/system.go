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
	if seeds == nil {
		if !solana.Signer(c, account) {
			return ErrAuthority
		}
	} else {
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
	if seeds == nil {
		return cpi.Invoke(c, program, &metas, data[:], nil)
	}
	var signers cpi.Signers
	code = signers.Add(seeds)
	if code != 0 {
		return code
	}
	return cpi.Invoke(c, program, &metas, data[:], &signers)
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
