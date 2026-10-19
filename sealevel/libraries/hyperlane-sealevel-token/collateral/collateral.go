// Package collateral is the CollateralPlugin of
// rust/sealevel/programs/hyperlane-sealevel-token-collateral: it escrows SPL
// Token or Token-2022 tokens in a PDA token account. It is a library so the
// collateral and cross-collateral programs share it.
package collateral

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// PDA seeds: hyperlane_token_escrow_pda_seeds!() and
// hyperlane_token_ata_payer_pda_seeds!().
var (
	EscrowPDASeeds   = [][]byte{[]byte("hyperlane_token"), []byte("-"), []byte("escrow")}
	ATAPayerPDASeeds = [][]byte{[]byte("hyperlane_token"), []byte("-"), []byte("ata_payer")}
)

var (
	escrowPDA   = tokenlib.NewStaticPDA(EscrowPDASeeds)
	ataPayerPDA = tokenlib.NewStaticPDA(ATAPayerPDASeeds)
)

// CollateralPlugin is plugin::CollateralPlugin.
type CollateralPlugin struct {
	SPLTokenProgram svm.Pubkey
	Mint            svm.Pubkey
	Escrow          svm.Pubkey
	EscrowBump      uint8
	ATAPayerBump    uint8
}

func (p *CollateralPlugin) EncodeBorsh(w *borsh.Writer) {
	w.Bytes32(p.SPLTokenProgram)
	w.Bytes32(p.Mint)
	w.Bytes32(p.Escrow)
	w.U8(p.EscrowBump)
	w.U8(p.ATAPayerBump)
}

func (p *CollateralPlugin) DecodeBorsh(r *borsh.Reader) {
	p.SPLTokenProgram = r.Bytes32()
	p.Mint = r.Bytes32()
	p.Escrow = r.Bytes32()
	p.EscrowBump = r.U8()
	p.ATAPayerBump = r.U8()
}

func (p *CollateralPlugin) Size() int { return 32 + 32 + 32 + 1 + 1 }

// Token is a HyperlaneToken with collateral plugin data.
type Token = tokenlib.HyperlaneToken[CollateralPlugin, *CollateralPlugin]

// Initialize creates and initializes the escrow token account and the ATA
// payer PDA.
//
// Accounts: 0 SPL Token or Token-2022 program, 1 mint, 2 Rent sysvar,
// 3 escrow PDA (w), 4 ATA payer PDA (w).
func (p *CollateralPlugin) Initialize(c solana.Context, programID *svm.Pubkey, it *svm.AccountIter, systemProgram, tokenAccount, payer uint64) uint64 {
	tokenProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, tokenProgram, &tokenlib.SPLToken2022ProgramID) && !tokenlib.KeyEq(c, tokenProgram, &tokenlib.SPLTokenProgramID) {
		return svm.IncorrectProgramID
	}
	tokenProgramKey := svm.Key(c, tokenProgram)
	mint, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.OwnerEq(c, mint, &tokenProgramKey) {
		return svm.IllegalOwner
	}
	rent, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, rent, &tokenlib.RentSysvarID) {
		return svm.IncorrectProgramID
	}
	escrow, code := it.Next()
	if code != svm.Success {
		return code
	}
	escrowKey, escrowSeeds, code := svm.FindProgramAddressSeeds(c, EscrowPDASeeds, *programID)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, escrow, &escrowKey) {
		return svm.IncorrectProgramID
	}

	// GetAccountDataSize returns the escrow's size as u64 return data.
	metas := new(svm.Metas)
	metas.Add(mint, false, false)
	d := tokenlib.GetAccountDataSizeData()
	if code := svm.Invoke(c, tokenProgram, metas, d[:], nil); code != svm.Success {
		return code
	}
	var size [8]byte
	var setter svm.Pubkey
	n := solana.GetReturnData(c, size[:], setter[:])
	if n == 0 || setter != tokenProgramKey || n != 8 {
		return svm.InvalidArgument
	}
	space := uint64(0)
	for j := 0; j < 8; j++ {
		space |= uint64(size[j]) << (8 * uint64(j))
	}

	if code := accountutils.CreatePDAAccount(c, payer, space, tokenProgramKey, systemProgram, escrow, &escrowSeeds); code != svm.Success {
		return code
	}
	metas = new(svm.Metas)
	metas.Add(escrow, true, false)
	metas.Add(mint, false, false)
	metas.Add(escrow, false, false)
	metas.Add(rent, false, false)
	ia := tokenlib.InitializeAccountData()
	if code := svm.Invoke(c, tokenProgram, metas, ia[:], nil); code != svm.Success {
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
		return svm.IncorrectProgramID
	}
	if code := accountutils.CreatePDAAccount(c, payer, 0, svm.SystemProgramID, systemProgram, ataPayer, &ataPayerSeeds); code != svm.Success {
		return code
	}

	p.SPLTokenProgram = tokenProgramKey
	p.Mint = svm.Key(c, mint)
	p.Escrow = escrowKey
	p.EscrowBump = escrowSeeds.Bump()
	p.ATAPayerBump = ataPayerSeeds.Bump()
	return svm.Success
}

// checkTokenProgram is the stored token program check: key
// (IncorrectProgramId), then executable (InvalidAccountData).
func (p *CollateralPlugin) checkTokenProgram(c solana.Context, i uint64) uint64 {
	if !tokenlib.KeyEq(c, i, &p.SPLTokenProgram) {
		return svm.IncorrectProgramID
	}
	if !solana.Executable(c, i) {
		return svm.InvalidAccountData
	}
	return svm.Success
}

// TransferIn transfers from the sender's ATA to the escrow, and the fee to
// the beneficiary ATA.
//
// Accounts: 0 token program, 1 mint (w), 2 sender ATA (w), 3 escrow (w).
func (p *CollateralPlugin) TransferIn(c solana.Context, programID *svm.Pubkey, decimals uint8, sender uint64, it *svm.AccountIter, amount uint64, fee tokenlib.Fee) uint64 {
	tokenProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if code := p.checkTokenProgram(c, tokenProgram); code != svm.Success {
		return code
	}
	mint, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, mint, &p.Mint) {
		return svm.IncorrectProgramID
	}
	if !tokenlib.OwnerEq(c, mint, &p.SPLTokenProgram) {
		return svm.InvalidAccountData
	}
	senderATA, code := it.Next()
	if code != svm.Success {
		return code
	}
	senderKey := svm.Key(c, sender)
	expected, code := tokenlib.AssociatedTokenAddress(c, &senderKey, &p.Mint, &p.SPLTokenProgram)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, senderATA, &expected) {
		return svm.IncorrectProgramID
	}
	escrow, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, escrow, &p.Escrow) {
		return svm.IncorrectProgramID
	}
	if code := tokenlib.TransferChecked(c, tokenProgram, senderATA, mint, escrow, sender, amount, decimals, nil); code != svm.Success {
		return code
	}
	if fee.Some {
		return tokenlib.TransferChecked(c, tokenProgram, senderATA, mint, fee.Beneficiary, sender, fee.Amount, decimals, nil)
	}
	return svm.Success
}

// FeeBeneficiary is the beneficiary's ATA for the mint and token program.
func (p *CollateralPlugin) FeeBeneficiary(c solana.Context, beneficiaryOwner *svm.Pubkey) (svm.Pubkey, uint64) {
	return tokenlib.AssociatedTokenAddress(c, beneficiaryOwner, &p.Mint, &p.SPLTokenProgram)
}

// TransferOut creates the recipient's ATA if needed and pays it from the
// escrow.
//
// Accounts: 0 token program, 1 ATA program, 2 mint (w), 3 recipient ATA (w),
// 4 ATA payer PDA (w), 5 escrow (w).
func (p *CollateralPlugin) TransferOut(c solana.Context, programID *svm.Pubkey, decimals uint8, systemProgram, recipient uint64, it *svm.AccountIter, amount uint64) uint64 {
	tokenProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if code := p.checkTokenProgram(c, tokenProgram); code != svm.Success {
		return code
	}
	ataProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, ataProgram, &tokenlib.AssociatedTokenProgramID) {
		return svm.IncorrectProgramID
	}
	if !solana.Executable(c, ataProgram) {
		return svm.InvalidAccountData
	}
	mint, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, mint, &p.Mint) {
		return svm.IncorrectProgramID
	}
	recipientATA, code := it.Next()
	if code != svm.Success {
		return code
	}
	recipientKey := svm.Key(c, recipient)
	expected, code := tokenlib.AssociatedTokenAddress(c, &recipientKey, &p.Mint, &p.SPLTokenProgram)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, recipientATA, &expected) {
		return svm.IncorrectProgramID
	}
	if !solana.Writable(c, recipientATA) {
		return svm.InvalidAccountData
	}
	ataPayer, code := it.Next()
	if code != svm.Success {
		return code
	}
	ataPayerSigner, code := ataPayerPDA.Verify(c, ataPayer, p.ATAPayerBump, programID)
	if code != svm.Success {
		return code
	}
	escrow, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, escrow, &p.Escrow) {
		return svm.IncorrectProgramID
	}
	if code := tokenlib.CreateAssociatedTokenAccountIdempotent(c, ataProgram, ataPayer, recipientATA, recipient, mint, systemProgram, tokenProgram, ataPayerSigner); code != svm.Success {
		return code
	}
	if code := accountutils.VerifyRentExempt(c, ataPayer); code != svm.Success {
		return code
	}
	return tokenlib.TransferChecked(c, tokenProgram, escrow, mint, recipientATA, escrow, amount, decimals, escrowPDA.Signer(p.EscrowBump))
}

// TransferOutAccountMetas returns TransferOut's accounts; the recipient need
// not be writable.
func (p *CollateralPlugin) TransferOutAccountMetas(c solana.Context, programID *svm.Pubkey, recipient *hyperlanecore.H256) ([]accountmeta.SerializableAccountMeta, bool, uint64) {
	ataPayer, code := ataPayerPDA.Address(c, p.ATAPayerBump, programID)
	if code != svm.Success {
		return nil, false, code
	}
	recipientKey := svm.Pubkey(*recipient)
	recipientATA, code := tokenlib.AssociatedTokenAddress(c, &recipientKey, &p.Mint, &p.SPLTokenProgram)
	if code != svm.Success {
		return nil, false, code
	}
	metas := make([]accountmeta.SerializableAccountMeta, 6)
	tokenlib.SetMeta(&metas[0], &p.SPLTokenProgram, false, false)
	tokenlib.SetMeta(&metas[1], &tokenlib.AssociatedTokenProgramID, false, false)
	tokenlib.SetMeta(&metas[2], &p.Mint, false, false)
	tokenlib.SetMeta(&metas[3], &recipientATA, false, true)
	tokenlib.SetMeta(&metas[4], &ataPayer, false, true)
	tokenlib.SetMeta(&metas[5], &p.Escrow, false, true)
	return metas, false, svm.Success
}
