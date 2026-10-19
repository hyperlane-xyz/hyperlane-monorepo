package fee

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// processInitFee creates a fee account.
//
// Accounts:
// 0. `[executable]` System program.
// 1. `[signer]` Payer.
// 2. `[writable]` Fee account PDA.
func processInitFee(c solana.Context, ix *InitFee) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	systemIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, systemIdx, svm.SystemProgramID) {
		return svm.IncorrectProgramID
	}
	payerIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, payerIdx) {
		return svm.MissingRequiredSignature
	}
	feeIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if code := accountutils.VerifyAccountUninitialized(c, feeIdx); code != svm.Success {
		return code
	}
	key, seeds, code := svm.FindProgramAddressSeeds(c, FeeAccountSeeds(&ix.Salt), programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, feeIdx, key) {
		return svm.InvalidArgument
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	if ix.FeeData.Kind == FeeDataLeaf {
		if code := ix.FeeData.Leaf.Strategy.ValidateParams(); code != svm.Success {
			return code
		}
	}
	fa := new(FeeAccount)
	fa.BumpSeed = seeds.Bump()
	fa.Owner = borsh.SomeOf(svm.Key(c, payerIdx))
	fa.Beneficiary = ix.Beneficiary
	fa.DomainID = ix.DomainID
	fa.FeeData = ix.FeeData
	if code := accountutils.CreatePDAAccount(c, payerIdx, accountutils.AccountDataSize(fa), programID, systemIdx, feeIdx, &seeds); code != svm.Success {
		return code
	}
	if code := accountutils.Store(c, feeIdx, fa, false); code != svm.Success {
		return code
	}
	m := svm.NewMsg("Initialized fee account: ")
	m.Pubkey(&key)
	m.Emit(c)
	return svm.Success
}

// processSetBeneficiary (owner-only).
//
// Accounts:
// 0. `[writable]` Fee account.
// 1. `[signer]` Owner.
func processSetBeneficiary(c solana.Context, beneficiary Pubkey) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	feeIdx, fa, _, code := fetchFeeAccountAndVerifyOwner(c, &it, &programID)
	if code != svm.Success {
		return code
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	fa.Beneficiary = beneficiary
	if code := accountutils.Store(c, feeIdx, fa, false); code != svm.Success {
		return code
	}
	m := svm.NewMsg("Set beneficiary: ")
	m.Pubkey(&beneficiary)
	m.Emit(c)
	return svm.Success
}

// processTransferOwnership (owner-only).
//
// Accounts:
// 0. `[writable]` Fee account.
// 1. `[signer]` Owner.
func processTransferOwnership(c solana.Context, newOwner accesscontrol.Owner) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	feeIdx, fa, _, code := fetchFeeAccountAndVerifyOwner(c, &it, &programID)
	if code != svm.Success {
		return code
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	fa.Owner = newOwner
	if code := accountutils.Store(c, feeIdx, fa, false); code != svm.Success {
		return code
	}
	m := svm.NewMsg("Transferred ownership to: ")
	m.OptionPubkey(newOwner.Some, &newOwner.Value)
	m.Emit(c)
	return svm.Success
}

// processUpdateFeeParams sets a Leaf account's curve params (owner-only).
//
// Accounts:
// 0. `[writable]` Fee account.
// 1. `[signer]` Owner.
func processUpdateFeeParams(c solana.Context, params FeeParams) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	feeIdx, fa, _, code := fetchFeeAccountAndVerifyOwner(c, &it, &programID)
	if code != svm.Success {
		return code
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	if fa.FeeData.Kind != FeeDataLeaf {
		return ErrNotLeafFeeData
	}
	fa.FeeData.Leaf.Strategy.Params = params
	if code := fa.FeeData.Leaf.Strategy.ValidateParams(); code != svm.Success {
		return code
	}
	if code := accountutils.Store(c, feeIdx, fa, false); code != svm.Success {
		return code
	}
	svm.Log(c, "Updated fee params")
	return svm.Success
}

// processSetMinIssuedAt raises the standing-quote revocation threshold
// (owner-only, monotonic).
//
// Accounts:
// 0. `[writable]` Fee account.
// 1. `[signer]` Owner.
func processSetMinIssuedAt(c solana.Context, minIssuedAt int64) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	feeIdx, fa, _, code := fetchFeeAccountAndVerifyOwner(c, &it, &programID)
	if code != svm.Success {
		return code
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	if minIssuedAt < fa.MinIssuedAt {
		return ErrMinIssuedAtMustBeMonotonic
	}
	fa.MinIssuedAt = minIssuedAt
	if code := accountutils.Store(c, feeIdx, fa, false); code != svm.Success {
		return code
	}
	m := svm.NewMsg("Set min_issued_at: ")
	m.I64(minIssuedAt)
	m.Emit(c)
	return svm.Success
}

// processSetWildcardQuoteSigners replaces a Routing/CC account's wildcard
// signers (owner-only).
//
// Accounts:
// 0. `[executable]` System program.
// 1. `[writable]` Fee account.
// 2. `[signer, writable]` Owner.
func processSetWildcardQuoteSigners(c solana.Context, signers Signers) uint64 {
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
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	if fa.FeeData.Kind == FeeDataLeaf {
		return ErrWildcardSignersNotApplicable
	}
	fa.FeeData.WildcardSigners = signers
	if code := accountutils.StoreWithRentExemptRealloc(c, feeIdx, fa, ownerIdx, systemIdx); code != svm.Success {
		return code
	}
	svm.Log(c, "Set wildcard quote signers")
	return svm.Success
}

// processSetQuoteSigner adds or removes a quote signer (owner-only). No
// route targets the Leaf fee account; a route targets its route PDA.
//
// Accounts:
// 0. `[executable]` System program.
// 1. `[writable for Leaf, readonly otherwise]` Fee account.
// 2. `[signer, writable]` Owner.
// 3. `[writable]` Route PDA (Routing/CC only).
func processSetQuoteSigner(c solana.Context, ix *SetQuoteSigner) uint64 {
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
	if !ix.Route.Some {
		if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
			return code
		}
		if fa.FeeData.Kind != FeeDataLeaf {
			return ErrNotLeafFeeData
		}
		if !fa.FeeData.Leaf.Signers.Some {
			return ErrOffchainQuotingNotConfigured
		}
		applySignerOp(&fa.FeeData.Leaf.Signers, ix)
		return logSetQuoteSigner(c, ix, accountutils.StoreWithRentExemptRealloc(c, feeIdx, fa, ownerIdx, systemIdx))
	}
	route := &ix.Route.Value
	feeKey := svm.Key(c, feeIdx)
	var seeds [][]byte
	notOwned := svm.IncorrectProgramID
	if route.Kind == RouteKeyDomain {
		if fa.FeeData.Kind != FeeDataRouting {
			return ErrNotRoutingFeeData
		}
	} else {
		if fa.FeeData.Kind != FeeDataCrossCollateralRouting {
			return ErrNotCrossCollateralRoutingFeeData
		}
	}
	routeIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	if route.Kind == RouteKeyDomain {
		seeds = RouteDomainSeeds(&feeKey, route.Domain)
	} else {
		seeds = CCRouteSeeds(&feeKey, route.Domain, &route.TargetRouter)
	}
	expected, code := findPDA(c, seeds, &programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, routeIdx, expected) {
		return svm.InvalidArgument
	}
	if !svm.OwnerIs(c, routeIdx, programID) {
		return notOwned
	}
	if route.Kind == RouteKeyDomain {
		rd, _, code := accountutils.FetchAccount[RouteDomain](c, routeIdx)
		if code != svm.Success {
			return code
		}
		applySignerOp(&rd.Signers, ix)
		return logSetQuoteSigner(c, ix, accountutils.StoreWithRentExemptRealloc(c, routeIdx, &rd, ownerIdx, systemIdx))
	}
	cr, _, code := accountutils.FetchAccount[CrossCollateralRoute](c, routeIdx)
	if code != svm.Success {
		return code
	}
	applySignerOp(&cr.Signers, ix)
	return logSetQuoteSigner(c, ix, accountutils.StoreWithRentExemptRealloc(c, routeIdx, &cr, ownerIdx, systemIdx))
}

// logSetQuoteSigner logs "SetQuoteSigner: {}" (H160 Display) once the store
// succeeded, and returns its code.
func logSetQuoteSigner(c solana.Context, ix *SetQuoteSigner, code uint64) uint64 {
	if code != svm.Success {
		return code
	}
	m := svm.NewMsg("SetQuoteSigner: ")
	m.H160Short(&ix.Signer)
	m.Emit(c)
	return svm.Success
}

// applySignerOp: Add creates the set if absent; Remove is a no-op on None
// and leaves Some(empty) when the last signer goes.
func applySignerOp(signers *OptionSigners, ix *SetQuoteSigner) {
	if ix.Remove {
		if signers.Some {
			signers.Value = removeSigner(signers.Value, &ix.Signer)
		}
		return
	}
	if !signers.Some {
		signers.Some = true
		signers.Value = Signers{}
	}
	signers.Value = insertSigner(signers.Value, ix.Signer)
}
