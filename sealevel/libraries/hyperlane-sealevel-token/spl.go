package tokenlib

// SPL Token / Token-2022 and Associated Token Account instruction encodings
// (spl-token-2022-interface 2.1.0, spl-associated-token-account-interface
// 2.0.0), built as raw CPIs. The programs never parse token account data.

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Program and sysvar IDs.
var (
	// SPLToken2022ProgramID is TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.
	SPLToken2022ProgramID = svm.Pubkey{6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252}
	// SPLTokenProgramID is TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.
	SPLTokenProgramID = svm.Pubkey{6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169}
	// AssociatedTokenProgramID is ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL.
	AssociatedTokenProgramID = svm.Pubkey{140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89}
	// RentSysvarID is SysvarRent111111111111111111111111111111111.
	RentSysvarID = svm.Pubkey{6, 167, 213, 23, 25, 44, 92, 81, 33, 140, 201, 76, 61, 74, 241, 127, 88, 218, 238, 8, 155, 161, 253, 68, 227, 219, 217, 138, 0, 0, 0, 0}
)

// TokenInstruction discriminators.
const (
	splInitializeAccount  uint8 = 1
	splTransferChecked    uint8 = 12
	splMintToChecked      uint8 = 14
	splBurnChecked        uint8 = 15
	splGetAccountDataSize uint8 = 21
	ataCreateIdempotent   uint8 = 1
)

// AssociatedTokenAddress is get_associated_token_address_with_program_id:
// find_program_address([wallet, token_program, mint], ATA program).
func AssociatedTokenAddress(c solana.Context, wallet, mint, tokenProgram *svm.Pubkey) (svm.Pubkey, uint64) {
	key, _, code := svm.FindProgramAddress(c, [][]byte{wallet[:], tokenProgram[:], mint[:]}, AssociatedTokenProgramID)
	return key, code
}

// AmountDecimalsData encodes the *Checked instructions: [tag, amount u64 LE, decimals].
func AmountDecimalsData(tag uint8, amount uint64, decimals uint8) [10]byte {
	var d [10]byte
	d[0] = tag
	for i := 0; i < 8; i++ {
		d[1+i] = byte(amount >> (8 * uint64(i)))
	}
	d[9] = decimals
	return d
}

// TransferCheckedData is TokenInstruction::TransferChecked.
func TransferCheckedData(amount uint64, decimals uint8) [10]byte {
	return AmountDecimalsData(splTransferChecked, amount, decimals)
}

// MintToCheckedData is TokenInstruction::MintToChecked.
func MintToCheckedData(amount uint64, decimals uint8) [10]byte {
	return AmountDecimalsData(splMintToChecked, amount, decimals)
}

// BurnCheckedData is TokenInstruction::BurnChecked.
func BurnCheckedData(amount uint64, decimals uint8) [10]byte {
	return AmountDecimalsData(splBurnChecked, amount, decimals)
}

// GetAccountDataSizeData is GetAccountDataSize with no extension types.
func GetAccountDataSizeData() [1]byte { return [1]byte{splGetAccountDataSize} }

// InitializeAccountData is TokenInstruction::InitializeAccount.
func InitializeAccountData() [1]byte { return [1]byte{splInitializeAccount} }

// CreateIdempotentData is AssociatedTokenAccountInstruction::CreateIdempotent.
func CreateIdempotentData() [1]byte { return [1]byte{ataCreateIdempotent} }

// TransferChecked CPIs transfer_checked(source, mint, destination, authority,
// &[]) with authority signing: the transaction signer, or a PDA with seeds.
func TransferChecked(c solana.Context, tokenProgram, source, mint, destination, authority uint64, amount uint64, decimals uint8, seeds *svm.Seeds) uint64 {
	metas := new(svm.Metas)
	metas.Add(source, true, false)
	metas.Add(mint, false, false)
	metas.Add(destination, true, false)
	metas.Add(authority, false, true)
	d := TransferCheckedData(amount, decimals)
	return svm.Invoke(c, tokenProgram, metas, d[:], seeds)
}

// MintToChecked CPIs mint_to_checked(mint, account, authority, &[]).
func MintToChecked(c solana.Context, tokenProgram, mint, account, authority uint64, amount uint64, decimals uint8, seeds *svm.Seeds) uint64 {
	metas := new(svm.Metas)
	metas.Add(mint, true, false)
	metas.Add(account, true, false)
	metas.Add(authority, false, true)
	d := MintToCheckedData(amount, decimals)
	return svm.Invoke(c, tokenProgram, metas, d[:], seeds)
}

// BurnCheckedWithSigner CPIs burn_checked(account, mint, authority,
// &[authority]): the synthetic plugin passes the authority as its own
// multisig signer, so the metas list it twice (readonly, then signer).
func BurnCheckedWithSigner(c solana.Context, tokenProgram, account, mint, authority uint64, amount uint64, decimals uint8) uint64 {
	metas := new(svm.Metas)
	metas.Add(account, true, false)
	metas.Add(mint, true, false)
	metas.Add(authority, false, false)
	metas.Add(authority, false, true)
	d := BurnCheckedData(amount, decimals)
	return svm.Invoke(c, tokenProgram, metas, d[:], nil)
}

// CreateAssociatedTokenAccountIdempotent CPIs the ATA program's
// CreateIdempotent(payer, ata, wallet, mint, system, token_program).
func CreateAssociatedTokenAccountIdempotent(c solana.Context, ataProgram, payer, ata, wallet, mint, systemProgram, tokenProgram uint64, seeds *svm.Seeds) uint64 {
	metas := new(svm.Metas)
	metas.Add(payer, true, true)
	metas.Add(ata, true, false)
	metas.Add(wallet, false, false)
	metas.Add(mint, false, false)
	metas.Add(systemProgram, false, false)
	metas.Add(tokenProgram, false, false)
	d := CreateIdempotentData()
	return svm.Invoke(c, ataProgram, metas, d[:], seeds)
}
