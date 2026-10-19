// Package ata derives associated token account addresses and creates them
// through the real Associated Token Account program, for classic Token and
// Token-2022 mints. A program PDA can pay, as Solana programs that create
// recipient accounts on delivery do.
package ata

import (
	"gosvm/sdk/cpi"
	"gosvm/sdk/pda"
	"gosvm/sdk/token"
	"gosvm/solana"
)

const ErrProgram uint64 = 3030
const ErrAccount uint64 = 3031
const ErrAuthority uint64 = 3032

// ProgramID is the Associated Token Account program,
// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL.
func ProgramID() [32]byte {
	return [32]byte{140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89}
}

func copyKey(c solana.Context, index uint64) ([32]byte, bool) {
	var key [32]byte
	if index >= solana.Count(c) || len(solana.Key(c, index)) != 32 {
		return key, false
	}
	k := solana.Key(c, index)
	for j := uint64(0); j < 32; j++ {
		key[j] = k[j]
	}
	return key, true
}

func zero(b []byte) bool {
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

// Address derives the canonical associated token account of wallet for mint
// under tokenProgram, the program's find_program_address over seeds wallet,
// token program and mint. It returns the address and bump; the search costs one
// CreateAddress call per candidate bump.
func Address(c solana.Context, wallet, tokenProgram, mint [32]byte) ([32]byte, byte, uint64) {
	var seeds pda.Seeds
	if seeds.AddKey(wallet) != 0 || seeds.AddKey(tokenProgram) != 0 || seeds.AddKey(mint) != 0 {
		var none [32]byte
		return none, 0, pda.ErrSeeds
	}
	return seeds.FindAddress(c, ProgramID())
}

// Matches reports whether the account at index is that associated address.
func Matches(c solana.Context, index uint64, wallet, tokenProgram, mint [32]byte) (bool, uint64) {
	key, ok := copyKey(c, index)
	if !ok {
		return false, ErrAccount
	}
	address, _, code := Address(c, wallet, tokenProgram, mint)
	if code != 0 {
		return false, code
	}
	return address == key, 0
}

// CreateIdempotent creates the wallet's associated token account for mint, or
// succeeds without change when it already exists. Accounts are context
// indices: the ATA program, payer, the derived account, wallet, mint, System
// and the mint's token program. The payer needs a transaction signature.
func CreateIdempotent(c solana.Context, program, payer, account, wallet, mint, system, tokenProgram uint64) uint64 {
	return create(c, 1, program, payer, account, wallet, mint, system, tokenProgram, nil)
}

// CreateIdempotentSigned pays with a PDA under the calling program. ATA's
// System calls require the payer to be System-owned without data. The caller
// checks the payer's remaining rent afterwards if it must stay exempt.
func CreateIdempotentSigned(c solana.Context, program, payer, account, wallet, mint, system, tokenProgram uint64, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return create(c, 1, program, payer, account, wallet, mint, system, tokenProgram, seeds)
}

// Create creates the account and fails, with the ATA program's error, if it
// already exists.
func Create(c solana.Context, program, payer, account, wallet, mint, system, tokenProgram uint64) uint64 {
	return create(c, 0, program, payer, account, wallet, mint, system, tokenProgram, nil)
}

// CreateSigned is Create with a PDA payer.
func CreateSigned(c solana.Context, program, payer, account, wallet, mint, system, tokenProgram uint64, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return create(c, 0, program, payer, account, wallet, mint, system, tokenProgram, seeds)
}

func create(c solana.Context, opcode byte, program, payer, account, wallet, mint, system, tokenProgram uint64, seeds *pda.Seeds) uint64 {
	id, ok := copyKey(c, program)
	if !ok || id != ProgramID() || !solana.Executable(c, program) {
		return ErrProgram
	}
	if !token.IsProgram(c, tokenProgram) {
		return ErrProgram
	}
	if system >= solana.Count(c) || !solana.Executable(c, system) || !zero(solana.Key(c, system)) {
		return ErrProgram
	}
	tokenKey, _ := copyKey(c, tokenProgram)
	mintKey, ok := copyKey(c, mint)
	if !ok || solana.Executable(c, mint) || len(solana.Owner(c, mint)) != 32 {
		return ErrAccount
	}
	for j := uint64(0); j < 32; j++ {
		if solana.Owner(c, mint)[j] != tokenKey[j] {
			return ErrAccount
		}
	}
	walletKey, ok := copyKey(c, wallet)
	if !ok {
		return ErrAccount
	}
	if account >= solana.Count(c) || !solana.Writable(c, account) {
		return ErrAccount
	}
	matches, code := Matches(c, account, walletKey, tokenKey, mintKey)
	if code != 0 {
		return code
	}
	if !matches {
		return ErrAccount
	}
	if payer >= solana.Count(c) || !solana.Writable(c, payer) || solana.Executable(c, payer) || len(solana.Key(c, payer)) != 32 || !zero(solana.Owner(c, payer)) || len(solana.Data(c, payer)) != 0 {
		return ErrAccount
	}
	if seeds == nil {
		if !solana.Signer(c, payer) {
			return ErrAuthority
		}
	} else {
		var caller [32]byte
		id := solana.ProgramID(c)
		if len(id) != 32 {
			return ErrAuthority
		}
		for j := uint64(0); j < 32; j++ {
			caller[j] = id[j]
		}
		found, status := seeds.Matches(c, payer, caller)
		if status != 0 {
			return status
		}
		if !found {
			return ErrAuthority
		}
	}
	var data [1]byte
	data[0] = opcode
	var metas cpi.Metas
	if metas.Add(payer, true, true) != 0 || metas.Add(account, true, false) != 0 || metas.Add(wallet, false, false) != 0 || metas.Add(mint, false, false) != 0 || metas.Add(system, false, false) != 0 || metas.Add(tokenProgram, false, false) != 0 {
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
