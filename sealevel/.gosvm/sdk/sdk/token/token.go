// Package token provides checked classic SPL Token references and transfers.
// Frozen accounts reach SPL Token for its exact error. Token-2022, native SOL,
// delegate-authorized transfers and multisig are outside this initial contract.
package token

import (
	"gosvm/sdk/cpi"
	"gosvm/sdk/pda"
	"gosvm/solana"
)

const ErrAccount uint64 = 3010
const ErrIdentity uint64 = 3011
const ErrMint uint64 = 3012
const ErrAuthority uint64 = 3013
const ErrWritable uint64 = 3014

type Account struct {
	index uint64
	key   [32]byte
	write bool
}
type State struct {
	Mint      [32]byte
	Authority [32]byte
	Amount    uint64
	Frozen    bool
}

func ProgramID() [32]byte {
	return [32]byte{6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169}
}

func equalKey(bytes []byte, key [32]byte) bool {
	if len(bytes) != 32 {
		return false
	}
	for j := uint64(0); j < 32; j++ {
		if bytes[j] != key[j] {
			return false
		}
	}
	return true
}

func validate(c solana.Context, index uint64, writable bool) uint64 {
	if index >= solana.Count(c) {
		return ErrAccount
	}
	key := solana.Key(c, index)
	data := solana.Data(c, index)
	if len(key) != 32 || len(data) != 165 || solana.Executable(c, index) || !equalKey(solana.Owner(c, index), ProgramID()) {
		return ErrAccount
	}
	if writable && !solana.Writable(c, index) {
		return ErrWritable
	}
	if (data[108] != 1 && data[108] != 2) || data[109] != 0 || data[110] != 0 || data[111] != 0 || data[112] != 0 {
		return ErrAccount
	}
	return 0
}

func Load(c solana.Context, index uint64, writable bool) (Account, uint64) {
	var ref Account
	code := validate(c, index, writable)
	if code != 0 {
		return ref, code
	}
	key := solana.Key(c, index)
	ref.index = index
	ref.write = writable
	for j := uint64(0); j < 32; j++ {
		ref.key[j] = key[j]
	}
	return ref, 0
}

func validateReference(c solana.Context, ref Account) uint64 {
	code := validate(c, ref.index, ref.write)
	if code != 0 {
		return code
	}
	if !equalKey(solana.Key(c, ref.index), ref.key) {
		return ErrIdentity
	}
	return 0
}

// Read validates the reference again and reads current bytes after prior CPIs.
func Read(c solana.Context, ref Account) (State, uint64) {
	var state State
	code := validateReference(c, ref)
	if code != 0 {
		return state, code
	}
	data := solana.Data(c, ref.index)
	for j := uint64(0); j < 32; j++ {
		state.Mint[j] = data[j]
		state.Authority[j] = data[32+j]
	}
	for j := uint64(0); j < 8; j++ {
		state.Amount = state.Amount | uint64(data[64+j])<<(j*8)
	}
	state.Frozen = data[108] == 2
	return state, 0
}

// Balance revalidates the same account contract as Read, without copying mint
// and authority fields when callers only need the current amount.
func Balance(c solana.Context, ref Account) (uint64, uint64) {
	code := validateReference(c, ref)
	if code != 0 {
		return 0, code
	}
	data := solana.Data(c, ref.index)
	amount := uint64(0)
	for j := uint64(0); j < 8; j++ {
		amount = amount | uint64(data[64+j])<<(j*8)
	}
	return amount, 0
}

func Transfer(c solana.Context, program uint64, source, destination Account, authority, amount uint64) uint64 {
	return transfer(c, program, source, destination, authority, amount, nil)
}

func TransferSigned(c solana.Context, program uint64, source, destination Account, authority, amount uint64, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return transfer(c, program, source, destination, authority, amount, seeds)
}

func transfer(c solana.Context, program uint64, source, destination Account, authority, amount uint64, seeds *pda.Seeds) uint64 {
	if program >= solana.Count(c) || !solana.IsTokenProgram(c, program) {
		return 2001
	}
	if !source.write || !destination.write {
		return ErrWritable
	}
	code := validateReference(c, source)
	if code != 0 {
		return code
	}
	status := validateReference(c, destination)
	if status != 0 {
		return status
	}
	src := solana.Data(c, source.index)
	dst := solana.Data(c, destination.index)
	for j := uint64(0); j < 32; j++ {
		if src[j] != dst[j] {
			return ErrMint
		}
	}
	if authority >= solana.Count(c) {
		return ErrAuthority
	}
	authorityKey := solana.Key(c, authority)
	if len(authorityKey) != 32 {
		return ErrAuthority
	}
	for j := uint64(0); j < 32; j++ {
		if src[32+j] != authorityKey[j] {
			return ErrAuthority
		}
	}
	if seeds == nil && !solana.Signer(c, authority) {
		return ErrAuthority
	}
	var data [9]byte
	data[0] = 3
	for j := uint64(0); j < 8; j++ {
		data[1+j] = byte(amount >> (j * 8))
	}
	var metas cpi.Metas
	if metas.Add(source.index, true, false) != 0 || metas.Add(destination.index, true, false) != 0 || metas.Add(authority, false, true) != 0 {
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
