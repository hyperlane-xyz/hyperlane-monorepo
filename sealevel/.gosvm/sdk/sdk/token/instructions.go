package token

import (
	"gosvm/sdk/cpi"
	"gosvm/sdk/pda"
	"gosvm/solana"
)

// The builders below target classic Token or Token-2022, selected by the
// program index. Each checks that program, the owner, executable flag and
// required privileges of every account it names, and the authority's
// transaction signature or PDA seeds under the caller. They do not decode
// account bytes: Token enforces balances, mint relationships, decimals and
// extension rules, and its errors propagate unchanged.

// owned reports whether index is a non-executable account owned by program.
func owned(c solana.Context, index, program uint64) bool {
	if index >= solana.Count(c) || len(solana.Key(c, index)) != 32 || solana.Executable(c, index) {
		return false
	}
	owner := solana.Owner(c, index)
	key := solana.Key(c, program)
	if len(owner) != 32 || len(key) != 32 {
		return false
	}
	for j := uint64(0); j < 32; j++ {
		if owner[j] != key[j] {
			return false
		}
	}
	return true
}

// signedBy requires the authority's transaction signature for nil seeds,
// otherwise that it is the seeds' PDA under the calling program.
func signedBy(c solana.Context, authority uint64, seeds *pda.Seeds) uint64 {
	if authority >= solana.Count(c) || len(solana.Key(c, authority)) != 32 {
		return ErrAuthority
	}
	if seeds == nil {
		if !solana.Signer(c, authority) {
			return ErrAuthority
		}
		return 0
	}
	id := solana.ProgramID(c)
	if len(id) != 32 {
		return ErrAuthority
	}
	var program [32]byte
	for j := uint64(0); j < 32; j++ {
		program[j] = id[j]
	}
	matches, code := seeds.Matches(c, authority, program)
	if code != 0 {
		return code
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

// amountData encodes opcode, a little-endian amount and decimals.
func amountData(opcode byte, amount uint64, decimals byte) [10]byte {
	var data [10]byte
	data[0] = opcode
	for j := uint64(0); j < 8; j++ {
		data[1+j] = byte(amount >> (j * 8))
	}
	data[9] = decimals
	return data
}

// InitializeMint2 initializes an allocated mint owned by the token program.
// Token-2022 mint extensions must be initialized before it. hasFreeze selects
// the optional freeze authority.
func InitializeMint2(c solana.Context, program, mint uint64, decimals byte, authority, freeze [32]byte, hasFreeze bool) uint64 {
	if !IsProgram(c, program) {
		return 2001
	}
	if !owned(c, mint, program) {
		return ErrMint
	}
	if !solana.Writable(c, mint) {
		return ErrWritable
	}
	var data [67]byte
	data[0] = 20
	data[1] = decimals
	for j := uint64(0); j < 32; j++ {
		data[2+j] = authority[j]
	}
	size := uint64(35)
	if hasFreeze {
		data[34] = 1
		for j := uint64(0); j < 32; j++ {
			data[35+j] = freeze[j]
		}
		size = 67
	}
	var metas cpi.Metas
	if metas.Add(mint, true, false) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:size], nil)
}

// InitializeMetadataPointer initializes Token-2022's MetadataPointer extension
// on an allocated, uninitialized mint, before InitializeMint2. A zero key
// encodes no authority or no metadata address.
func InitializeMetadataPointer(c solana.Context, program, mint uint64, authority, metadata [32]byte) uint64 {
	if !IsProgram(c, program) || !equalKey(solana.Key(c, program), Program2022ID()) {
		return 2001
	}
	if !owned(c, mint, program) {
		return ErrMint
	}
	if !solana.Writable(c, mint) {
		return ErrWritable
	}
	var data [66]byte
	data[0] = 39 // MetadataPointerExtension
	data[1] = 0  // Initialize
	for j := uint64(0); j < 32; j++ {
		data[2+j] = authority[j]
		data[34+j] = metadata[j]
	}
	var metas cpi.Metas
	if metas.Add(mint, true, false) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], nil)
}

// InitializeAccount3 initializes an allocated token account for mint with the
// supplied owner key. It reads Rent from the runtime.
func InitializeAccount3(c solana.Context, program, account, mint uint64, owner [32]byte) uint64 {
	if !IsProgram(c, program) {
		return 2001
	}
	if !owned(c, account, program) {
		return ErrAccount
	}
	if !solana.Writable(c, account) {
		return ErrWritable
	}
	if !owned(c, mint, program) {
		return ErrMint
	}
	var data [33]byte
	data[0] = 18
	for j := uint64(0); j < 32; j++ {
		data[1+j] = owner[j]
	}
	var metas cpi.Metas
	if metas.Add(account, true, false) != 0 || metas.Add(mint, false, false) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], nil)
}

// InitializeAccount is the original form, with the owner and Rent sysvar as
// accounts. The owner may be the account itself, as for a self-owned vault.
func InitializeAccount(c solana.Context, program, account, mint, owner, rent uint64) uint64 {
	if !IsProgram(c, program) {
		return 2001
	}
	if !owned(c, account, program) {
		return ErrAccount
	}
	if !solana.Writable(c, account) {
		return ErrWritable
	}
	if !owned(c, mint, program) {
		return ErrMint
	}
	rentID := [32]byte{6, 167, 213, 23, 25, 44, 92, 81, 33, 140, 201, 76, 61, 74, 241, 127, 88, 218, 238, 8, 155, 161, 253, 68, 227, 219, 217, 138, 0, 0, 0, 0}
	if owner >= solana.Count(c) || len(solana.Key(c, owner)) != 32 || rent >= solana.Count(c) || !equalKey(solana.Key(c, rent), rentID) {
		return ErrAccount
	}
	var data [1]byte
	data[0] = 1
	var metas cpi.Metas
	if metas.Add(account, true, false) != 0 || metas.Add(mint, false, false) != 0 || metas.Add(owner, false, false) != 0 || metas.Add(rent, false, false) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], nil)
}

// GetAccountDataSize asks the token program for the size of a token account
// for mint, including mint-required and up to 16 additional extension types.
// The program returns it as a little-endian uint64 in return data; read it with
// solana.GetReturnData and validate the setting token program before decoding.
func GetAccountDataSize(c solana.Context, program, mint uint64, extensions []uint16) uint64 {
	if !IsProgram(c, program) {
		return 2001
	}
	if !owned(c, mint, program) {
		return ErrMint
	}
	if len(extensions) > 16 {
		return ErrAccount
	}
	var data [33]byte
	data[0] = 21
	for j := uint64(0); j < uint64(len(extensions)); j++ {
		data[1+2*j] = byte(extensions[j])
		data[2+2*j] = byte(extensions[j] >> 8)
	}
	var metas cpi.Metas
	if metas.Add(mint, false, false) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:1+2*uint64(len(extensions))], nil)
}

// MintToChecked mints amount to destination. The mint authority signs with its
// transaction signature.
func MintToChecked(c solana.Context, program, mint, destination, authority, amount uint64, decimals byte) uint64 {
	return mintTo(c, program, mint, destination, authority, amount, decimals, nil)
}

// MintToCheckedSigned signs for a PDA mint authority, which may be the mint.
func MintToCheckedSigned(c solana.Context, program, mint, destination, authority, amount uint64, decimals byte, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return mintTo(c, program, mint, destination, authority, amount, decimals, seeds)
}

func mintTo(c solana.Context, program, mint, destination, authority, amount uint64, decimals byte, seeds *pda.Seeds) uint64 {
	if !IsProgram(c, program) {
		return 2001
	}
	if !owned(c, mint, program) {
		return ErrMint
	}
	if !owned(c, destination, program) {
		return ErrAccount
	}
	if !solana.Writable(c, mint) || !solana.Writable(c, destination) {
		return ErrWritable
	}
	code := signedBy(c, authority, seeds)
	if code != 0 {
		return code
	}
	data := amountData(14, amount, decimals)
	var metas cpi.Metas
	if metas.Add(mint, true, false) != 0 || metas.Add(destination, true, false) != 0 || metas.Add(authority, false, true) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], seeds)
}

// BurnChecked burns amount from source, signed by its owner.
func BurnChecked(c solana.Context, program, source, mint, authority, amount uint64, decimals byte) uint64 {
	return burn(c, program, source, mint, authority, amount, decimals, nil)
}

// BurnCheckedSigned signs for a PDA source owner.
func BurnCheckedSigned(c solana.Context, program, source, mint, authority, amount uint64, decimals byte, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return burn(c, program, source, mint, authority, amount, decimals, seeds)
}

func burn(c solana.Context, program, source, mint, authority, amount uint64, decimals byte, seeds *pda.Seeds) uint64 {
	if !IsProgram(c, program) {
		return 2001
	}
	if !owned(c, source, program) {
		return ErrAccount
	}
	if !owned(c, mint, program) {
		return ErrMint
	}
	if !solana.Writable(c, source) || !solana.Writable(c, mint) {
		return ErrWritable
	}
	code := signedBy(c, authority, seeds)
	if code != 0 {
		return code
	}
	data := amountData(15, amount, decimals)
	var metas cpi.Metas
	if metas.Add(source, true, false) != 0 || metas.Add(mint, true, false) != 0 || metas.Add(authority, false, true) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], seeds)
}

// TransferChecked moves amount from source to destination, signed by the
// source owner. Token-2022 applies any transfer fee to the destination.
func TransferChecked(c solana.Context, program, source, mint, destination, authority, amount uint64, decimals byte) uint64 {
	return transferChecked(c, program, source, mint, destination, authority, amount, decimals, nil)
}

// TransferCheckedSigned signs for a PDA source owner, which may be the source
// account itself, as for a self-owned escrow.
func TransferCheckedSigned(c solana.Context, program, source, mint, destination, authority, amount uint64, decimals byte, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return transferChecked(c, program, source, mint, destination, authority, amount, decimals, seeds)
}

func transferChecked(c solana.Context, program, source, mint, destination, authority, amount uint64, decimals byte, seeds *pda.Seeds) uint64 {
	if !IsProgram(c, program) {
		return 2001
	}
	if !owned(c, source, program) || !owned(c, destination, program) {
		return ErrAccount
	}
	if !owned(c, mint, program) {
		return ErrMint
	}
	if !solana.Writable(c, source) || !solana.Writable(c, destination) {
		return ErrWritable
	}
	code := signedBy(c, authority, seeds)
	if code != 0 {
		return code
	}
	data := amountData(12, amount, decimals)
	var metas cpi.Metas
	if metas.Add(source, true, false) != 0 || metas.Add(mint, false, false) != 0 || metas.Add(destination, true, false) != 0 || metas.Add(authority, false, true) != 0 {
		return cpi.ErrMetas
	}
	return invoke(c, program, &metas, data[:], seeds)
}
