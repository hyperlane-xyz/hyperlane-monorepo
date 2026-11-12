// Package tokensynthetic ports rust/sealevel/programs/hyperlane-sealevel-token:
// a warp route that burns and mints a synthetic Token-2022 mint whose PDA is
// also its mint authority.
package tokensynthetic

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// PDA seeds: hyperlane_token_mint_pda_seeds!() and
// hyperlane_token_ata_payer_pda_seeds!().
var (
	MintPDASeeds     = [][]byte{[]byte("hyperlane_token"), []byte("-"), []byte("mint")}
	ATAPayerPDASeeds = [][]byte{[]byte("hyperlane_token"), []byte("-"), []byte("ata_payer")}
)

var (
	mintPDA     = tokenlib.NewStaticPDA(MintPDASeeds)
	ataPayerPDA = tokenlib.NewStaticPDA(ATAPayerPDASeeds)
)

// MintAccountSize is SyntheticPlugin::MINT_ACCOUNT_SIZE: a Token-2022 mint
// with the MetadataPointer extension.
const MintAccountSize = 234

// SyntheticPlugin is plugin::SyntheticPlugin.
type SyntheticPlugin struct {
	Mint         svm.Pubkey
	MintBump     uint8
	ATAPayerBump uint8
}

func (p *SyntheticPlugin) EncodeBorsh(w *borsh.Writer) {
	w.Bytes32(p.Mint)
	w.U8(p.MintBump)
	w.U8(p.ATAPayerBump)
}

func (p *SyntheticPlugin) DecodeBorsh(r *borsh.Reader) {
	p.Mint = r.Bytes32()
	p.MintBump = r.U8()
	p.ATAPayerBump = r.U8()
}

func (p *SyntheticPlugin) Size() int { return 32 + 1 + 1 }

// Token is this program's HyperlaneToken.
type Token = tokenlib.HyperlaneToken[SyntheticPlugin, *SyntheticPlugin]

// Process is the program entrypoint.
func Process(c solana.Context) uint64 { return tokenlib.Process[SyntheticPlugin](c) }

// verifyMint checks the mint PDA (InvalidArgument) and its Token-2022 owner
// (IncorrectProgramId), returning its signer bytes.
func (p *SyntheticPlugin) verifyMint(c solana.Context, programID *svm.Pubkey, i uint64) ([]byte, uint64) {
	signer, code := mintPDA.Verify(c, i, p.MintBump, programID)
	if code != svm.Success {
		return nil, code
	}
	if !tokenlib.KeyEq(c, i, &p.Mint) {
		return nil, svm.InvalidArgument
	}
	if !tokenlib.OwnerEq(c, i, &tokenlib.SPLToken2022ProgramID) {
		return nil, svm.IncorrectProgramID
	}
	return signer, svm.Success
}

func token2022(c solana.Context, i uint64) bool {
	return tokenlib.KeyEq(c, i, &tokenlib.SPLToken2022ProgramID) && solana.Executable(c, i)
}

// Initialize creates the mint PDA (owned by Token-2022, initialized by a
// following InitializeMint2) and the ATA payer PDA.
//
// Accounts: 0 mint PDA (w), 1 ATA payer PDA (w).
func (p *SyntheticPlugin) Initialize(c solana.Context, programID *svm.Pubkey, it *svm.AccountIter, systemProgram, tokenAccount, payer uint64) uint64 {
	mint, code := it.Next()
	if code != svm.Success {
		return code
	}
	mintKey, mintSeeds, code := svm.FindProgramAddressSeeds(c, MintPDASeeds, *programID)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, mint, &mintKey) {
		return svm.InvalidArgument
	}
	if code := accountutils.CreatePDAAccount(c, payer, MintAccountSize, tokenlib.SPLToken2022ProgramID, systemProgram, mint, &mintSeeds); code != svm.Success {
		return code
	}
	ataPayer, code := it.Next()
	if code != svm.Success {
		return code
	}
	ataPayerKey, ataPayerSeeds, code := svm.FindProgramAddressSeeds(c, ATAPayerPDASeeds, *programID)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, ataPayer, &ataPayerKey) {
		return svm.InvalidArgument
	}
	if code := accountutils.CreatePDAAccount(c, payer, 0, svm.SystemProgramID, systemProgram, ataPayer, &ataPayerSeeds); code != svm.Success {
		return code
	}
	p.Mint = mintKey
	p.MintBump = mintSeeds.Bump()
	p.ATAPayerBump = ataPayerSeeds.Bump()
	return svm.Success
}

// TransferIn burns from the sender's ATA and transfers the fee to the
// beneficiary ATA.
//
// Accounts: 0 Token-2022 program, 1 mint (w), 2 sender ATA (w).
func (p *SyntheticPlugin) TransferIn(c solana.Context, programID *svm.Pubkey, decimals uint8, sender uint64, it *svm.AccountIter, amount uint64, fee tokenlib.Fee) uint64 {
	tokenProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !token2022(c, tokenProgram) {
		return svm.InvalidArgument
	}
	mint, code := it.Next()
	if code != svm.Success {
		return code
	}
	if _, code := p.verifyMint(c, programID, mint); code != svm.Success {
		return code
	}
	senderATA, code := it.Next()
	if code != svm.Success {
		return code
	}
	senderKey := svm.Key(c, sender)
	mintKey := svm.Key(c, mint)
	expected, code := tokenlib.AssociatedTokenAddress(c, &senderKey, &mintKey, &tokenlib.SPLToken2022ProgramID)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, senderATA, &expected) {
		return svm.InvalidArgument
	}
	if code := tokenlib.BurnCheckedWithSigner(c, tokenProgram, senderATA, mint, sender, amount, decimals); code != svm.Success {
		return code
	}
	if fee.Some {
		return tokenlib.TransferChecked(c, tokenProgram, senderATA, mint, fee.Beneficiary, sender, fee.Amount, decimals, nil)
	}
	return svm.Success
}

// FeeBeneficiary is the beneficiary's Token-2022 ATA for the mint.
func (p *SyntheticPlugin) FeeBeneficiary(c solana.Context, beneficiaryOwner *svm.Pubkey) (svm.Pubkey, uint64) {
	return tokenlib.AssociatedTokenAddress(c, beneficiaryOwner, &p.Mint, &tokenlib.SPLToken2022ProgramID)
}

// TransferOut creates the recipient's ATA if needed and mints to it.
//
// Accounts: 0 Token-2022 program, 1 ATA program, 2 mint (w), 3 recipient ATA
// (w), 4 ATA payer PDA (w).
func (p *SyntheticPlugin) TransferOut(c solana.Context, programID *svm.Pubkey, decimals uint8, systemProgram, recipient uint64, it *svm.AccountIter, amount uint64) uint64 {
	tokenProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !token2022(c, tokenProgram) {
		return svm.InvalidArgument
	}
	ataProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, ataProgram, &tokenlib.AssociatedTokenProgramID) || !solana.Executable(c, ataProgram) {
		return svm.InvalidArgument
	}
	mint, code := it.Next()
	if code != svm.Success {
		return code
	}
	_, code = p.verifyMint(c, programID, mint)
	if code != svm.Success {
		return code
	}
	recipientATA, code := it.Next()
	if code != svm.Success {
		return code
	}
	recipientKey := svm.Key(c, recipient)
	mintKey := svm.Key(c, mint)
	expected, code := tokenlib.AssociatedTokenAddress(c, &recipientKey, &mintKey, &tokenlib.SPLToken2022ProgramID)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, recipientATA, &expected) {
		return svm.InvalidArgument
	}
	ataPayer, code := it.Next()
	if code != svm.Success {
		return code
	}
	ataPayerSigner, code := ataPayerPDA.Verify(c, ataPayer, p.ATAPayerBump, programID)
	if code != svm.Success {
		return code
	}
	if code := tokenlib.CreateAssociatedTokenAccountIdempotent(c, ataProgram, ataPayer, recipientATA, recipient, mint, systemProgram, tokenProgram, ataPayerSigner); code != svm.Success {
		return code
	}
	if code := accountutils.VerifyRentExempt(c, ataPayer); code != svm.Success {
		return code
	}
	return tokenlib.MintToChecked(c, tokenProgram, mint, recipientATA, mint, amount, decimals, mintPDA.Signer(p.MintBump))
}

// TransferOutAccountMetas returns TransferOut's accounts; the recipient need
// not be writable.
func (p *SyntheticPlugin) TransferOutAccountMetas(c solana.Context, programID *svm.Pubkey, recipient *hyperlanecore.H256) ([]accountmeta.SerializableAccountMeta, bool, uint64) {
	ataPayer, code := ataPayerPDA.Address(c, p.ATAPayerBump, programID)
	if code != svm.Success {
		return nil, false, code
	}
	recipientKey := svm.Pubkey(*recipient)
	recipientATA, code := tokenlib.AssociatedTokenAddress(c, &recipientKey, &p.Mint, &tokenlib.SPLToken2022ProgramID)
	if code != svm.Success {
		return nil, false, code
	}
	metas := make([]accountmeta.SerializableAccountMeta, 5)
	tokenlib.SetMeta(&metas[0], &tokenlib.SPLToken2022ProgramID, false, false)
	tokenlib.SetMeta(&metas[1], &tokenlib.AssociatedTokenProgramID, false, false)
	tokenlib.SetMeta(&metas[2], &p.Mint, false, true)
	tokenlib.SetMeta(&metas[3], &recipientATA, false, true)
	tokenlib.SetMeta(&metas[4], &ataPayer, false, true)
	return metas, false, svm.Success
}
