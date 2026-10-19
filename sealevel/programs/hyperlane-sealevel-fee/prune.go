package fee

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// processPruneExpiredQuotes drops expired or revoked standing quotes for a
// domain and closes the PDA when none remain (owner-only).
//
// Accounts:
// 0. `[executable]` System program.
// 1. `[writable]` Fee account.
// 2. `[signer, writable]` Owner.
// 3. `[writable]` Domain standing quote PDA.
func processPruneExpiredQuotes(c solana.Context, ix *DomainRouter) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	systemIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, systemIdx, svm.SystemProgramID) {
		return svm.IncorrectProgramID
	}
	feeIdx, fa, ownerIdx, code := fetchFeeAccountAndVerifyOwner(c, &it, &programID)
	if code != svm.Success {
		return code
	}
	router := zeroH256
	if fa.FeeData.Kind == FeeDataCrossCollateralRouting {
		if !ix.TargetRouter.Some {
			return ErrNotRoutingFeeData
		}
		router = ix.TargetRouter.Value
	} else if ix.TargetRouter.Some {
		return ErrNotCrossCollateralRoutingFeeData
	}
	pdaIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	feeKey := svm.Key(c, feeIdx)
	expected, code := findPDA(c, StandingQuoteSeeds(&feeKey, ix.Domain, &router), &programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, pdaIdx, expected) {
		return svm.InvalidArgument
	}
	if !svm.OwnerIs(c, pdaIdx, programID) {
		return ErrRouteNotFound
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	standing := new(FeeStandingQuotePda)
	v, _, code := accountutils.FetchAccount[FeeStandingQuotePda](c, pdaIdx)
	if code != svm.Success {
		return code
	}
	*standing = v
	now, code := unixTimestamp(c)
	if code != svm.Success {
		return code
	}
	kept := 0
	for i := range standing.Quotes {
		q := &standing.Quotes[i].Value
		if now <= q.Expiry && q.IssuedAt >= fa.MinIssuedAt {
			standing.Quotes[kept] = standing.Quotes[i]
			kept++
		}
	}
	standing.Quotes = standing.Quotes[:kept]
	if kept == 0 {
		return accountutils.CloseAccount(c, pdaIdx, ownerIdx)
	}
	return accountutils.StoreWithRentExemptRealloc(c, pdaIdx, standing, ownerIdx, systemIdx)
}
