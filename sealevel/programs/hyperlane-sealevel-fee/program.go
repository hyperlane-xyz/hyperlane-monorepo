// Package fee ports rust/sealevel/programs/hyperlane-sealevel-fee: on-chain
// fee computation for warp routes with offchain-signed quotes.
//
// Rust's msg! logs are not emitted (goSVM has no sol_log yet).
package fee

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Process is the program entrypoint.
func Process(c solana.Context) uint64 {
	data := solana.Instruction(c)
	if packageversioned.IsGetProgramVersion(data) {
		return packageversioned.ProcessGetProgramVersion(c)
	}
	// Instruction::try_from_slice: unknown variants, bad payloads and
	// trailing bytes are all InvalidInstructionData.
	r := borsh.NewReader(data)
	switch r.EnumTag() {
	case IxInitFee:
		ix := new(InitFee)
		ix.DecodeBorsh(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processInitFee(c, ix)
	case IxQuoteFee:
		ix := new(QuoteFee)
		ix.DecodeBorsh(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processQuoteFee(c, ix)
	case IxSetRemoteFeeRoute:
		ix := new(SetRemoteFeeRoute)
		ix.DecodeBorsh(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processSetRemoteFeeRoute(c, ix)
	case IxRemoveRemoteFeeRoute:
		ix := new(DomainRouter)
		ix.DecodeBorsh(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processRemoveRemoteFeeRoute(c, ix)
	case IxUpdateFeeParams:
		var p FeeParams
		p.DecodeBorsh(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processUpdateFeeParams(c, p)
	case IxSetBeneficiary:
		beneficiary := r.Bytes32()
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processSetBeneficiary(c, beneficiary)
	case IxTransferOwnership:
		var owner accesscontrol.Owner
		if r.OptionTag() {
			owner.Value = r.Bytes32()
			owner.Some = true
		}
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processTransferOwnership(c, owner)
	case IxSetQuoteSigner:
		ix := new(SetQuoteSigner)
		ix.DecodeBorsh(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processSetQuoteSigner(c, ix)
	case IxSetMinIssuedAt:
		minIssuedAt := r.I64()
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processSetMinIssuedAt(c, minIssuedAt)
	case IxSetWildcardQuoteSigners:
		signers := readSigners(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processSetWildcardQuoteSigners(c, signers)
	case IxSubmitQuote:
		return decodeAndSubmitQuote(c, &r)
	case IxCloseTransientQuote:
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processCloseTransientQuote(c)
	case IxPruneExpiredQuotes:
		ix := new(DomainRouter)
		ix.DecodeBorsh(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processPruneExpiredQuotes(c, ix)
	case IxGetQuoteAccountMetas:
		ix := new(GetAccountMetas)
		ix.DecodeBorsh(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processGetQuoteAccountMetas(c, ix)
	case IxGetSubmitQuoteAccountMetas:
		ix := new(GetAccountMetas)
		ix.DecodeBorsh(&r)
		if !r.Done() {
			return svm.InvalidInstructionData
		}
		return processGetSubmitQuoteAccountMetas(c, ix)
	}
	return svm.InvalidInstructionData
}

// --- shared helpers (processor/common.rs) ---

// fetchFeeAccountAndVerifyOwner takes the fee account (owned by this
// program) and its owner (signer).
func fetchFeeAccountAndVerifyOwner(c solana.Context, it *svm.AccountIter, programID *Pubkey) (uint64, *FeeAccount, uint64, uint64) {
	feeIdx, code := it.Next()
	if code != svm.Success {
		return 0, nil, 0, code
	}
	if !svm.OwnerIs(c, feeIdx, *programID) {
		return 0, nil, 0, svm.IncorrectProgramID
	}
	fa, code := fetchFeeAccount(c, feeIdx)
	if code != svm.Success {
		return 0, nil, 0, code
	}
	ownerIdx, code := it.Next()
	if code != svm.Success {
		return 0, nil, 0, code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, fa.Owner, ownerIdx); code != svm.Success {
		return 0, nil, 0, code
	}
	return feeIdx, fa, ownerIdx, svm.Success
}

// fetchFeeAccount is FeeAccountData::fetch(..).into_inner(); empty or
// uninitialized data gives FeeAccount::default() (the zero value).
func fetchFeeAccount(c solana.Context, i uint64) (*FeeAccount, uint64) {
	fa := new(FeeAccount)
	v, _, code := accountutils.FetchAccount[FeeAccount](c, i)
	if code != svm.Success {
		return nil, code
	}
	*fa = v
	return fa, svm.Success
}

// verifyOptionalPDAOwner accepts uninitialized or program-owned accounts.
func verifyOptionalPDAOwner(c solana.Context, i uint64, programID *Pubkey) uint64 {
	if accountutils.InitState(c, i, *programID) == accountutils.OwnerMismatch {
		return svm.IncorrectProgramID
	}
	return svm.Success
}

// unixTimestamp is Clock::get()?.unix_timestamp.
func unixTimestamp(c solana.Context) (int64, uint64) {
	var buf [40]byte
	if solana.Clock(c, buf[:]) != 0 {
		return 0, svm.UnsupportedSysvar
	}
	return int64(le64(buf[32:40])), svm.Success
}

// setU64ReturnData is set_return_data(&v.to_le_bytes()).
func setU64ReturnData(c solana.Context, v uint64) uint64 {
	var b [8]byte
	for i := 0; i < 8; i++ {
		b[i] = byte(v >> (8 * uint64(i)))
	}
	if code := solana.SetReturnData(c, b[:]); code != 0 {
		return code
	}
	return svm.Success
}

// findPDA is Pubkey::find_program_address, keeping only the address.
func findPDA(c solana.Context, seeds [][]byte, programID *Pubkey) (Pubkey, uint64) {
	key, _, code := svm.FindProgramAddress(c, seeds, *programID)
	return key, code
}
