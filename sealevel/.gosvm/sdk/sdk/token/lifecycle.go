package token

import (
	"gosvm/sdk/cpi"
	"gosvm/sdk/pda"
	"gosvm/sdk/system"
	"gosvm/solana"
)

func nativeMint() [32]byte {
	return [32]byte{6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24, 192, 53, 218, 196, 57, 220, 26, 235, 59, 85, 152, 160, 240, 0, 0, 0, 0, 1}
}

func validateMint(c solana.Context, mint uint64) uint64 {
	if mint >= solana.Count(c) {
		return ErrMint
	}
	data := solana.Data(c, mint)
	key := solana.Key(c, mint)
	if len(key) != 32 || equalKey(key, nativeMint()) || len(data) != 82 || data[45] != 1 || solana.Executable(c, mint) || !equalKey(solana.Owner(c, mint), ProgramID()) {
		return ErrMint
	}
	// Mint's two COption<Pubkey> tags must be canonical even when their keys are unused.
	if data[0] > 1 || data[1] != 0 || data[2] != 0 || data[3] != 0 || data[46] > 1 || data[47] != 0 || data[48] != 0 || data[49] != 0 {
		return ErrMint
	}
	return 0
}

// Create rent-funds an empty System transaction-signer account and initializes
// a classic non-native token account with the supplied authority key. System
// creation and SPL InitializeAccount3 errors propagate. A failure after creation
// requires VM transaction rollback; native callbacks do not provide atomicity.
func Create(c solana.Context, systemProgram, tokenProgram, payer, account, mint uint64, authority [32]byte) uint64 {
	return create(c, systemProgram, tokenProgram, payer, account, mint, authority, nil)
}

// CreateSigned signs the new token account's System allocation with explicit
// PDA seeds under the caller. The payer still needs a transaction signature.
func CreateSigned(c solana.Context, systemProgram, tokenProgram, payer, account, mint uint64, authority [32]byte, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return create(c, systemProgram, tokenProgram, payer, account, mint, authority, seeds)
}

func create(c solana.Context, systemProgram, tokenProgram, payer, account, mint uint64, authority [32]byte, seeds *pda.Seeds) uint64 {
	if tokenProgram >= solana.Count(c) || !solana.IsTokenProgram(c, tokenProgram) {
		return 2001
	}
	code := validateMint(c, mint)
	if code != 0 {
		return code
	}
	if seeds == nil {
		code = system.Create(c, systemProgram, payer, account, 165, ProgramID())
	} else {
		code = system.CreateSigned(c, systemProgram, payer, account, 165, ProgramID(), seeds)
	}
	if code != 0 {
		return code
	}
	var instruction [33]byte
	instruction[0] = 18 // InitializeAccount3 embeds the authority and reads runtime Rent.
	for j := uint64(0); j < 32; j++ {
		instruction[1+j] = authority[j]
	}
	var metas cpi.Metas
	if metas.Add(account, true, false) != 0 || metas.Add(mint, false, false) != 0 {
		return cpi.ErrMetas
	}
	code = cpi.Invoke(c, tokenProgram, &metas, instruction[:], nil)
	if code != 0 {
		return code
	}
	ref, status := Load(c, account, true)
	if status != 0 {
		return status
	}
	current, status := Read(c, ref)
	if status != 0 {
		return status
	}
	if !equalKey(solana.Key(c, mint), current.Mint) {
		return ErrMint
	}
	if current.Authority != authority {
		return ErrAuthority
	}
	return 0
}

// Close validates a checked writable reference and the effective SPL close
// authority (explicit close authority, otherwise token owner). SPL enforces an
// empty non-native balance and checks refund overflow; exact errors propagate.
// Burned/System-owned token authority, wrapped SOL and multisig are unsupported.
func Close(c solana.Context, program uint64, source Account, refund, authority uint64) uint64 {
	return close(c, program, source, refund, authority, nil)
}

func CloseSigned(c solana.Context, program uint64, source Account, refund, authority uint64, seeds *pda.Seeds) uint64 {
	if seeds == nil {
		return pda.ErrSeeds
	}
	return close(c, program, source, refund, authority, seeds)
}

func close(c solana.Context, program uint64, source Account, refund, authority uint64, seeds *pda.Seeds) uint64 {
	if program >= solana.Count(c) || !solana.IsTokenProgram(c, program) {
		return 2001
	}
	if !source.write {
		return ErrWritable
	}
	code := validateReference(c, source)
	if code != 0 {
		return code
	}
	if refund >= solana.Count(c) || len(solana.Key(c, refund)) != 32 || solana.Executable(c, refund) || equalKey(solana.Key(c, refund), source.key) {
		return ErrAccount
	}
	if !solana.Writable(c, refund) {
		return ErrWritable
	}
	if authority >= solana.Count(c) || len(solana.Key(c, authority)) != 32 || solana.Executable(c, authority) {
		return ErrAuthority
	}
	data := solana.Data(c, source.index)
	if data[129] > 1 || data[130] != 0 || data[131] != 0 || data[132] != 0 {
		return ErrAccount
	}
	// SPL's System/incinerator-owner close path bypasses ordinary authorization;
	// this helper deliberately requires the normal signer/PDA ownership policy.
	var owner [32]byte
	for j := uint64(0); j < 32; j++ {
		owner[j] = data[32+j]
	}
	var zero [32]byte
	incinerator := [32]byte{0, 51, 144, 114, 141, 52, 17, 96, 121, 189, 201, 17, 191, 255, 0, 219, 212, 77, 46, 205, 204, 247, 156, 166, 225, 0, 56, 225, 0, 0, 0, 0}
	if owner == zero || owner == incinerator {
		return ErrAuthority
	}
	offset := uint64(32)
	if data[129] == 1 {
		offset = 133
	}
	key := solana.Key(c, authority)
	for j := uint64(0); j < 32; j++ {
		if data[offset+j] != key[j] {
			return ErrAuthority
		}
	}
	if seeds == nil && !solana.Signer(c, authority) {
		return ErrAuthority
	}
	var metas cpi.Metas
	if metas.Add(source.index, true, false) != 0 || metas.Add(refund, true, false) != 0 || metas.Add(authority, false, true) != 0 {
		return cpi.ErrMetas
	}
	var instruction [1]byte
	instruction[0] = 9
	if seeds == nil {
		return cpi.Invoke(c, program, &metas, instruction[:], nil)
	}
	var signers cpi.Signers
	code = signers.Add(seeds)
	if code != 0 {
		return code
	}
	return cpi.Invoke(c, program, &metas, instruction[:], &signers)
}
