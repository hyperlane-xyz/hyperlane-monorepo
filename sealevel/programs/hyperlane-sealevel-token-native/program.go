// Package tokennative ports rust/sealevel/programs/hyperlane-sealevel-token-native:
// a warp route that escrows native lamports in a System-owned collateral PDA.
package tokennative

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// NativeCollateralPDASeeds are hyperlane_token_native_collateral_pda_seeds!().
var NativeCollateralPDASeeds = [][]byte{[]byte("hyperlane_token"), []byte("-"), []byte("native_collateral")}

var nativeCollateralPDA = tokenlib.NewStaticPDA(NativeCollateralPDASeeds)

// NativePlugin is plugin::NativePlugin.
type NativePlugin struct {
	NativeCollateralBump uint8
}

func (p *NativePlugin) EncodeBorsh(w *borsh.Writer) { w.U8(p.NativeCollateralBump) }
func (p *NativePlugin) DecodeBorsh(r *borsh.Reader) { p.NativeCollateralBump = r.U8() }
func (p *NativePlugin) Size() int                   { return 1 }

// Token is this program's HyperlaneToken.
type Token = tokenlib.HyperlaneToken[NativePlugin, *NativePlugin]

// Process is the program entrypoint.
func Process(c solana.Context) uint64 { return tokenlib.Process[NativePlugin](c) }

// verifyNativeCollateral checks the collateral PDA against the stored bump
// and returns its signer bytes.
func (p *NativePlugin) verifyNativeCollateral(c solana.Context, programID *svm.Pubkey, i uint64) ([]byte, uint64) {
	return nativeCollateralPDA.Verify(c, i, p.NativeCollateralBump, programID)
}

// Initialize creates the native collateral PDA (0 bytes, System-owned).
//
// Accounts: 0 native collateral PDA (w).
func (p *NativePlugin) Initialize(c solana.Context, programID *svm.Pubkey, it *svm.AccountIter, systemProgram, tokenAccount, payer uint64) uint64 {
	collateral, code := it.Next()
	if code != svm.Success {
		return code
	}
	key, seeds, code := svm.FindProgramAddressSeeds(c, NativeCollateralPDASeeds, *programID)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, collateral, &key) {
		return svm.InvalidArgument
	}
	if code := accountutils.CreatePDAAccount(c, payer, 0, svm.SystemProgramID, systemProgram, collateral, &seeds); code != svm.Success {
		return code
	}
	p.NativeCollateralBump = seeds.Bump()
	return svm.Success
}

// TransferIn moves lamports from the sender into the collateral PDA, and the
// fee to the beneficiary wallet.
//
// Accounts: 0 system program, 1 native collateral PDA (w).
func (p *NativePlugin) TransferIn(c solana.Context, programID *svm.Pubkey, decimals uint8, sender uint64, it *svm.AccountIter, amount uint64, fee tokenlib.Fee) uint64 {
	systemProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, systemProgram, &svm.SystemProgramID) {
		return svm.InvalidArgument
	}
	collateral, code := it.Next()
	if code != svm.Success {
		return code
	}
	if _, code := p.verifyNativeCollateral(c, programID, collateral); code != svm.Success {
		return code
	}
	if code := svm.SystemTransfer(c, systemProgram, sender, collateral, amount, nil); code != svm.Success {
		return code
	}
	if fee.Some {
		return svm.SystemTransfer(c, systemProgram, sender, fee.Beneficiary, fee.Amount, nil)
	}
	return svm.Success
}

// FeeBeneficiary is the beneficiary wallet itself.
func (p *NativePlugin) FeeBeneficiary(c solana.Context, beneficiaryOwner *svm.Pubkey) (svm.Pubkey, uint64) {
	return *beneficiaryOwner, svm.Success
}

// TransferOut pays lamports from the collateral PDA to the recipient, which
// must leave the PDA rent exempt.
//
// Accounts: 0 system program, 1 native collateral PDA (w).
func (p *NativePlugin) TransferOut(c solana.Context, programID *svm.Pubkey, decimals uint8, _ uint64, recipient uint64, it *svm.AccountIter, amount uint64) uint64 {
	systemProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, systemProgram, &svm.SystemProgramID) {
		return svm.InvalidArgument
	}
	collateral, code := it.Next()
	if code != svm.Success {
		return code
	}
	signer, code := p.verifyNativeCollateral(c, programID, collateral)
	if code != svm.Success {
		return code
	}
	metas := new(svm.Metas)
	metas.Add(collateral, true, true)
	metas.Add(recipient, true, false)
	d := svm.TransferData(amount)
	if code := tokenlib.InvokeSigned(c, systemProgram, metas, d[:], signer); code != svm.Success {
		return code
	}
	return accountutils.VerifyRentExempt(c, collateral)
}

// TransferOutAccountMetas returns [system program, native collateral (w)]
// with a writable recipient.
//
// The token account holding p was verified as this program's token PDA, and
// its stored collateral bump came from find_program_address at init, so one
// create_program_address replaces the bump search.
func (p *NativePlugin) TransferOutAccountMetas(c solana.Context, programID *svm.Pubkey, _ *hyperlanecore.H256) ([]accountmeta.SerializableAccountMeta, bool, uint64) {
	key, code := nativeCollateralPDA.Address(c, p.NativeCollateralBump, programID)
	if code != svm.Success {
		return nil, false, code
	}
	metas := make([]accountmeta.SerializableAccountMeta, 2)
	tokenlib.SetMeta(&metas[0], &svm.SystemProgramID, false, false)
	tokenlib.SetMeta(&metas[1], &key, false, true)
	return metas, true, svm.Success
}
