package fee

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// processSetRemoteFeeRoute creates or updates a route PDA and resets the
// matching standing quote PDA to empty (owner-only).
//
// Accounts:
// 0. `[executable]` System program.
// 1. `[]` Fee account.
// 2. `[signer, writable]` Owner.
// 3. `[writable]` Route PDA (RouteDomain or CrossCollateralRoute).
// 4. `[writable]` Standing quote PDA.
func processSetRemoteFeeRoute(c solana.Context, ix *SetRemoteFeeRoute) uint64 {
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
	if ix.Domain == 0 || ix.Domain == WildcardDomain {
		return ErrInvalidRouteDomain
	}
	if code := ix.FeeData.ValidateParams(); code != svm.Success {
		return code
	}
	feeKey := svm.Key(c, feeIdx)
	standingTarget := zeroH256
	switch {
	case fa.FeeData.Kind == FeeDataRouting && !ix.TargetRouter.Some:
		key, seeds, code := svm.FindProgramAddressSeeds(c, RouteDomainSeeds(&feeKey, ix.Domain), programID)
		if code != svm.Success {
			return code
		}
		route := new(RouteDomain)
		route.BumpSeed = seeds.Bump()
		route.FeeData = ix.FeeData
		route.Signers = ix.Signers
		if code := upsertPDA(c, &it, &programID, &key, route, &seeds, ownerIdx, systemIdx); code != svm.Success {
			return code
		}
	case fa.FeeData.Kind == FeeDataCrossCollateralRouting && ix.TargetRouter.Some:
		if ix.TargetRouter.Value == zeroH256 {
			return ErrZeroTargetRouterNotAllowed
		}
		key, seeds, code := svm.FindProgramAddressSeeds(c, CCRouteSeeds(&feeKey, ix.Domain, &ix.TargetRouter.Value), programID)
		if code != svm.Success {
			return code
		}
		route := new(CrossCollateralRoute)
		route.BumpSeed = seeds.Bump()
		route.FeeData = ix.FeeData
		route.Signers = ix.Signers
		if code := upsertPDA(c, &it, &programID, &key, route, &seeds, ownerIdx, systemIdx); code != svm.Success {
			return code
		}
		standingTarget = ix.TargetRouter.Value
	case ix.TargetRouter.Some:
		return ErrNotCrossCollateralRoutingFeeData
	default:
		return ErrNotRoutingFeeData
	}

	// Reset the standing quote PDA to empty.
	key, seeds, code := svm.FindProgramAddressSeeds(c, StandingQuoteSeeds(&feeKey, ix.Domain, &standingTarget), programID)
	if code != svm.Success {
		return code
	}
	empty := new(FeeStandingQuotePda)
	empty.BumpSeed = seeds.Bump()
	if code := upsertPDA(c, &it, &programID, &key, empty, &seeds, ownerIdx, systemIdx); code != svm.Success {
		return code
	}
	return accountutils.EnsureNoExtraneousAccounts(&it)
}

// upsertPDA is upsert_route_pda: create the PDA if uninitialized, else
// store with a rent-exempt realloc.
func upsertPDA[T accountutils.Sized](c solana.Context, it *svm.AccountIter, programID, expected *Pubkey, v T, seeds *svm.Seeds, ownerIdx, systemIdx uint64) uint64 {
	idx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, idx, *expected) {
		return svm.InvalidArgument
	}
	switch accountutils.InitState(c, idx, *programID) {
	case accountutils.Uninitialized:
		if code := accountutils.CreatePDAAccount(c, ownerIdx, accountutils.AccountDataSize(v), *programID, systemIdx, idx, seeds); code != svm.Success {
			return code
		}
		return accountutils.Store(c, idx, v, false)
	case accountutils.Initialized:
		return accountutils.StoreWithRentExemptRealloc(c, idx, v, ownerIdx, systemIdx)
	}
	return svm.IncorrectProgramID
}

// processRemoveRemoteFeeRoute closes a route PDA and, if it exists, the
// matching standing quote PDA (owner-only).
//
// Accounts:
// 0. `[]` Fee account.
// 1. `[signer, writable]` Owner (rent refund).
// 2. `[writable]` Route PDA.
// 3. `[writable]` Standing quote PDA.
func processRemoveRemoteFeeRoute(c solana.Context, ix *DomainRouter) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	feeIdx, fa, ownerIdx, code := fetchFeeAccountAndVerifyOwner(c, &it, &programID)
	if code != svm.Success {
		return code
	}
	feeKey := svm.Key(c, feeIdx)
	standingTarget := zeroH256
	var seeds [][]byte
	switch {
	case fa.FeeData.Kind == FeeDataRouting && !ix.TargetRouter.Some:
		seeds = RouteDomainSeeds(&feeKey, ix.Domain)
	case fa.FeeData.Kind == FeeDataCrossCollateralRouting && ix.TargetRouter.Some:
		if ix.TargetRouter.Value == zeroH256 {
			return ErrZeroTargetRouterNotAllowed
		}
		seeds = CCRouteSeeds(&feeKey, ix.Domain, &ix.TargetRouter.Value)
		standingTarget = ix.TargetRouter.Value
	case ix.TargetRouter.Some:
		return ErrNotCrossCollateralRoutingFeeData
	default:
		return ErrNotRoutingFeeData
	}
	expected, code := findPDA(c, seeds, &programID)
	if code != svm.Success {
		return code
	}
	routeIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, routeIdx, expected) {
		return svm.InvalidArgument
	}
	if !svm.OwnerIs(c, routeIdx, programID) {
		return ErrRouteNotFound
	}
	if code := accountutils.CloseAccount(c, routeIdx, ownerIdx); code != svm.Success {
		return code
	}

	// Close the standing quote PDA if it exists.
	standingIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	expected, code = findPDA(c, StandingQuoteSeeds(&feeKey, ix.Domain, &standingTarget), &programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, standingIdx, expected) {
		return svm.InvalidArgument
	}
	if svm.OwnerIs(c, standingIdx, programID) && !svm.DataIsEmpty(c, standingIdx) {
		if code := accountutils.CloseAccount(c, standingIdx, ownerIdx); code != svm.Success {
			return code
		}
	}
	return accountutils.EnsureNoExtraneousAccounts(&it)
}
