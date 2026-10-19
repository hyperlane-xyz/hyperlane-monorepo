package fee

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// simulationFeeAccount takes and decodes the single fee account the
// simulation instructions accept.
func simulationFeeAccount(c solana.Context, programID *Pubkey) (Pubkey, uint8, uint64) {
	it := svm.NewAccountIter(c)
	feeIdx, code := it.Next()
	if code != svm.Success {
		return Pubkey{}, 0, code
	}
	if !svm.OwnerIs(c, feeIdx, *programID) {
		return Pubkey{}, 0, svm.IncorrectProgramID
	}
	fa, code := fetchFeeAccount(c, feeIdx)
	if code != svm.Success {
		return Pubkey{}, 0, code
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return Pubkey{}, 0, code
	}
	return svm.Key(c, feeIdx), fa.FeeData.Kind, svm.Success
}

func appendPDA(c solana.Context, metas []accountmeta.SerializableAccountMeta, seeds [][]byte, programID *Pubkey, writable bool) ([]accountmeta.SerializableAccountMeta, uint64) {
	key, code := findPDA(c, seeds, programID)
	if code != svm.Success {
		return metas, code
	}
	return append(metas, accountmeta.SerializableAccountMeta{Pubkey: key, IsWritable: writable}), svm.Success
}

// processGetQuoteAccountMetas returns QuoteFee's account metas
// (simulation only).
//
// Accounts:
// 0. `[]` Fee account.
func processGetQuoteAccountMetas(c solana.Context, ix *GetAccountMetas) uint64 {
	programID := svm.ProgramID(c)
	feeKey, kind, code := simulationFeeAccount(c, &programID)
	if code != svm.Success {
		return code
	}
	metas := make([]accountmeta.SerializableAccountMeta, 0, 8)
	metas = append(metas, accountmeta.Readonly(feeKey, false))
	// Payer placeholder; the SDK substitutes the real payer.
	metas = append(metas, accountmeta.Writable(Pubkey{}, true))
	if ix.ScopedSalt.Some {
		if metas, code = appendPDA(c, metas, TransientQuoteSeeds(&feeKey, &ix.ScopedSalt.Value), &programID, true); code != svm.Success {
			return code
		}
	}
	isCC := kind == FeeDataCrossCollateralRouting
	standingTarget := zeroH256
	if isCC {
		standingTarget = ix.TargetRouter
	}
	if metas, code = appendPDA(c, metas, StandingQuoteSeeds(&feeKey, ix.DestinationDomain, &standingTarget), &programID, false); code != svm.Success {
		return code
	}
	if isCC {
		if metas, code = appendPDA(c, metas, StandingQuoteSeeds(&feeKey, ix.DestinationDomain, &DefaultRouter), &programID, false); code != svm.Success {
			return code
		}
	}
	if metas, code = appendPDA(c, metas, StandingQuoteSeeds(&feeKey, WildcardDomain, &standingTarget), &programID, false); code != svm.Success {
		return code
	}
	switch kind {
	case FeeDataRouting:
		if metas, code = appendPDA(c, metas, RouteDomainSeeds(&feeKey, ix.DestinationDomain), &programID, false); code != svm.Success {
			return code
		}
	case FeeDataCrossCollateralRouting:
		if metas, code = appendPDA(c, metas, CCRouteSeeds(&feeKey, ix.DestinationDomain, &ix.TargetRouter), &programID, false); code != svm.Success {
			return code
		}
		if metas, code = appendPDA(c, metas, CCRouteSeeds(&feeKey, ix.DestinationDomain, &DefaultRouter), &programID, false); code != svm.Success {
			return code
		}
	}
	if code := solana.SetReturnData(c, accountmeta.EncodeMetasReturnData(metas)); code != 0 {
		return code
	}
	return svm.Success
}

// processGetSubmitQuoteAccountMetas returns SubmitQuote's account metas
// (simulation only).
//
// Accounts:
// 0. `[]` Fee account.
func processGetSubmitQuoteAccountMetas(c solana.Context, ix *GetAccountMetas) uint64 {
	programID := svm.ProgramID(c)
	feeKey, kind, code := simulationFeeAccount(c, &programID)
	if code != svm.Success {
		return code
	}
	metas := make([]accountmeta.SerializableAccountMeta, 0, 5)
	metas = append(metas, accountmeta.Readonly(svm.SystemProgramID, false))
	metas = append(metas, accountmeta.Writable(Pubkey{}, true))
	metas = append(metas, accountmeta.Readonly(feeKey, false))
	if ix.DestinationDomain != WildcardDomain {
		switch kind {
		case FeeDataRouting:
			if metas, code = appendPDA(c, metas, RouteDomainSeeds(&feeKey, ix.DestinationDomain), &programID, false); code != svm.Success {
				return code
			}
		case FeeDataCrossCollateralRouting:
			if metas, code = appendPDA(c, metas, CCRouteSeeds(&feeKey, ix.DestinationDomain, &ix.TargetRouter), &programID, false); code != svm.Success {
				return code
			}
		}
	}
	if ix.ScopedSalt.Some {
		if metas, code = appendPDA(c, metas, TransientQuoteSeeds(&feeKey, &ix.ScopedSalt.Value), &programID, true); code != svm.Success {
			return code
		}
	} else {
		standingTarget := zeroH256
		if kind == FeeDataCrossCollateralRouting {
			standingTarget = ix.TargetRouter
		}
		if metas, code = appendPDA(c, metas, StandingQuoteSeeds(&feeKey, ix.DestinationDomain, &standingTarget), &programID, true); code != svm.Success {
			return code
		}
	}
	if code := solana.SetReturnData(c, accountmeta.EncodeMetasReturnData(metas)); code != 0 {
		return code
	}
	return svm.Success
}
