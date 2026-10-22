package fee

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	quoteverifier "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/quote-verifier"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// processQuoteFee returns the fee (u64 LE return data). Cascade: transient
// quote, domain standing quote, wildcard-domain standing quote, on-chain
// curve.
//
// Accounts:
//  0. `[]` Fee account.
//  1. `[signer, writable]` Payer.
//  2. `[writable]` Transient quote PDA (optional; present iff its key is not
//     the expected specific-scope domain standing PDA).
//
// Then standing quote PDAs: Leaf/Routing (dest, 0), (WILDCARD, 0);
// CC (dest, target_router), (dest, DEFAULT_ROUTER), (WILDCARD, target_router).
// Then route PDAs: Routing 1 RouteDomain; CC (dest, target_router) and
// (dest, DEFAULT_ROUTER).
func processQuoteFee(c solana.Context, ix *QuoteFee) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	feeIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.OwnerIs(c, feeIdx, programID) {
		return svm.IncorrectProgramID
	}
	fa, code := fetchFeeAccount(c, feeIdx)
	if code != svm.Success {
		return code
	}
	payerIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, payerIdx) {
		return svm.MissingRequiredSignature
	}
	now, code := unixTimestamp(c)
	if code != svm.Success {
		return code
	}
	feeKey := svm.Key(c, feeIdx)
	isCC := fa.FeeData.Kind == FeeDataCrossCollateralRouting
	standingTarget := zeroH256
	if isCC {
		standingTarget = ix.TargetRouter
	}
	// Slot 2: transient quote PDA or the specific-scope domain standing PDA,
	// disambiguated by key.
	nextIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	nextIsDomainStanding, code := verifyPDA(c, nextIdx, StandingQuoteDiscriminator, StandingQuoteSeeds(&feeKey, ix.DestinationDomain, &standingTarget), &programID)
	if code != svm.Success {
		return code
	}
	hasTransient := false
	transientIdx := uint64(0)
	specificIdx := nextIdx
	if !nextIsDomainStanding {
		ok, code := isInitializedTransientQuote(c, nextIdx, &programID)
		if code != svm.Success {
			return code
		}
		if !ok {
			return ErrInvalidTransientSlot
		}
		hasTransient = true
		transientIdx = nextIdx
		specificIdx, code = it.Next()
		if code != svm.Success {
			return code
		}
	}
	defaultIdx := uint64(0)
	if isCC {
		defaultIdx, code = it.Next()
		if code != svm.Success {
			return code
		}
	}
	wildcardIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if code := verifyOptionalPDAOwner(c, specificIdx, &programID); code != svm.Success {
		return code
	}
	if isCC {
		if code := verifyOptionalPDAOwner(c, defaultIdx, &programID); code != svm.Success {
			return code
		}
	}
	if code := verifyOptionalPDAOwner(c, wildcardIdx, &programID); code != svm.Success {
		return code
	}

	// Resolve the on-chain curve.
	var strategy FeeDataStrategy
	specificActive := false
	switch fa.FeeData.Kind {
	case FeeDataLeaf:
		if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
			return code
		}
		strategy = fa.FeeData.Leaf.Strategy
	case FeeDataRouting:
		found := false
		strategy, found, code = resolveRouting(c, &it, &programID, &feeKey, ix.DestinationDomain)
		if code != svm.Success {
			return code
		}
		if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
			return code
		}
		if !found {
			// Unconfigured domain: zero fee.
			return logQuote(c, "QuoteFee (unconfigured route): ", 0, ix.Amount, setU64ReturnData(c, 0))
		}
	default:
		strategy, specificActive, code = resolveCCRouting(c, &it, &programID, &feeKey, ix.DestinationDomain, &ix.TargetRouter)
		if code != svm.Success {
			return code
		}
		if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
			return code
		}
	}

	// Step 1: transient quote (overrides params, autocloses).
	if hasTransient {
		fee, code := consumeTransientQuote(c, &programID, transientIdx, payerIdx, &feeKey, &strategy, ix, isCC, specificActive, fa.MinIssuedAt, now)
		if code != svm.Success {
			return code
		}
		return logQuote(c, "QuoteFee (transient): ", fee, ix.Amount, setU64ReturnData(c, fee))
	}

	// Steps 2-3: active-scope domain standing quote, then wildcard domain.
	// The specific-scope domain PDA is slot 2 here (a transient quote returned
	// above), already verified with these seeds: (destination,
	// standingTarget).
	activeIdx := specificIdx
	activeTarget := zeroH256
	activeVerified := true
	if isCC {
		if specificActive {
			activeTarget = ix.TargetRouter
		} else {
			activeIdx = defaultIdx
			activeTarget = DefaultRouter
			activeVerified = false
		}
	}
	fee, found, code := resolveStandingQuote(c, &programID, activeIdx, activeVerified, &feeKey, ix.DestinationDomain, &activeTarget, &strategy, ix, fa.MinIssuedAt, now)
	if code != svm.Success {
		return code
	}
	if found {
		return logQuote(c, "QuoteFee (standing): ", fee, ix.Amount, setU64ReturnData(c, fee))
	}
	fee, found, code = resolveStandingQuote(c, &programID, wildcardIdx, false, &feeKey, WildcardDomain, &standingTarget, &strategy, ix, fa.MinIssuedAt, now)
	if code != svm.Success {
		return code
	}
	if found {
		return logQuote(c, "QuoteFee (standing): ", fee, ix.Amount, setU64ReturnData(c, fee))
	}

	// Step 4: on-chain curve.
	fee, code = strategy.ComputeFee(ix.Amount)
	if code != svm.Success {
		return code
	}
	return logQuote(c, "QuoteFee (on-chain): ", fee, ix.Amount, setU64ReturnData(c, fee))
}

// logQuote logs "<prefix>{fee} for amount {amount}" once the return data is
// set, and returns code.
func logQuote(c solana.Context, prefix string, fee, amount, code uint64) uint64 {
	if code != svm.Success {
		return code
	}
	m := svm.NewMsg(prefix)
	m.Dec(fee)
	m.Str(" for amount ")
	m.Dec(amount)
	m.Emit(c)
	return svm.Success
}

// isInitializedTransientQuote: uninitialized is false, another owner is
// IncorrectProgramId, initialized checks the TRNQUOTE discriminator.
func isInitializedTransientQuote(c solana.Context, i uint64, programID *Pubkey) (bool, uint64) {
	switch accountutils.InitState(c, i, *programID) {
	case accountutils.Uninitialized:
		return false, svm.Success
	case accountutils.OwnerMismatch:
		return false, svm.IncorrectProgramID
	}
	data := solana.Data(c, i)
	if len(data) < 9 {
		return false, svm.InvalidAccountData
	}
	for j := 0; j < 8; j++ {
		if data[1+j] != TransientQuoteDiscriminator[j] {
			return false, svm.Success
		}
	}
	return true, svm.Success
}

// resolveStandingQuote is try_resolve_standing_quote: exact recipient, then
// wildcard recipient. Invalid (stale, expired, other curve) entries are
// skipped. keyVerified skips the PDA check when the caller already made it
// with the same seeds.
func resolveStandingQuote(c solana.Context, programID *Pubkey, idx uint64, keyVerified bool, feeKey *Pubkey, domain uint32, target *H256, strategy *FeeDataStrategy, ix *QuoteFee, minIssuedAt, now int64) (uint64, bool, uint64) {
	if !keyVerified {
		ok, code := verifyPDA(c, idx, StandingQuoteDiscriminator, StandingQuoteSeeds(feeKey, domain, target), programID)
		if code != svm.Success {
			return 0, false, code
		}
		if !ok {
			return 0, false, svm.InvalidArgument
		}
	}
	switch accountutils.InitState(c, idx, *programID) {
	case accountutils.Uninitialized:
		return 0, false, svm.Success
	case accountutils.OwnerMismatch:
		return 0, false, svm.IncorrectProgramID
	}
	standing := new(FeeStandingQuotePda)
	v, _, code := accountutils.FetchAccount[FeeStandingQuotePda](c, idx)
	if code != svm.Success {
		return 0, false, code
	}
	*standing = v
	for k := 0; k < 2; k++ {
		key := &ix.Recipient
		if k == 1 {
			key = &WildcardRecipient
		}
		j := standing.find(key)
		if j < 0 {
			continue
		}
		value := &standing.Quotes[j].Value
		if quoteverifier.ValidateQuote(value.IssuedAt, value.Expiry, minIssuedAt, now) != 0 {
			continue
		}
		if value.FeeData.Kind != strategy.Kind {
			continue
		}
		fee, code := value.FeeData.ComputeFee(ix.Amount)
		if code != svm.Success {
			return 0, false, code
		}
		return fee, true, svm.Success
	}
	return 0, false, svm.Success
}

// resolveRouting reads the RouteDomain PDA; found is false when it is
// uninitialized.
func resolveRouting(c solana.Context, it *svm.AccountIter, programID, feeKey *Pubkey, destination uint32) (FeeDataStrategy, bool, uint64) {
	var none FeeDataStrategy
	idx, code := it.Next()
	if code != svm.Success {
		return none, false, code
	}
	ok, code := verifyPDA(c, idx, RouteDomainDiscriminator, RouteDomainSeeds(feeKey, destination), programID)
	if code != svm.Success {
		return none, false, code
	}
	if !ok {
		return none, false, svm.InvalidArgument
	}
	switch accountutils.InitState(c, idx, *programID) {
	case accountutils.Uninitialized:
		return none, false, svm.Success
	case accountutils.OwnerMismatch:
		return none, false, svm.IncorrectProgramID
	}
	route, _, code := accountutils.FetchAccount[RouteDomain](c, idx)
	if code != svm.Success {
		return none, false, code
	}
	return route.FeeData, true, svm.Success
}

// resolveCCRouting consumes both CC route slots, (dest, target_router) then
// (dest, DEFAULT_ROUTER), and picks the first initialized one.
// specific reports whether the target_router route was chosen.
func resolveCCRouting(c solana.Context, it *svm.AccountIter, programID, feeKey *Pubkey, destination uint32, targetRouter *H256) (FeeDataStrategy, bool, uint64) {
	var chosen FeeDataStrategy
	found, specific := false, false
	for k := 0; k < 2; k++ {
		router := targetRouter
		if k == 1 {
			router = &DefaultRouter
		}
		idx, code := it.Next()
		if code != svm.Success {
			return chosen, false, code
		}
		ok, code := verifyPDA(c, idx, CCRouteDiscriminator, CCRouteSeeds(feeKey, destination, router), programID)
		if code != svm.Success {
			return chosen, false, code
		}
		if !ok {
			return chosen, false, svm.InvalidArgument
		}
		switch accountutils.InitState(c, idx, *programID) {
		case accountutils.Initialized:
			if !found {
				route, _, code := accountutils.FetchAccount[CrossCollateralRoute](c, idx)
				if code != svm.Success {
					return chosen, false, code
				}
				chosen = route.FeeData
				found = true
				specific = k == 0
			}
		case accountutils.OwnerMismatch:
			return chosen, false, svm.IncorrectProgramID
		}
	}
	if !found {
		return chosen, false, ErrRouteNotFound
	}
	return chosen, specific, svm.Success
}

// matchesContext is QuoteContext::validate's wildcard field matching.
func matchesContext(ctx *FeeQuoteContext, ix *QuoteFee) bool {
	if ctx.DestinationDomain != WildcardDomain && ctx.DestinationDomain != ix.DestinationDomain {
		return false
	}
	if ctx.Recipient != WildcardRecipient && ctx.Recipient != ix.Recipient {
		return false
	}
	return ctx.Amount == WildcardAmount || ctx.Amount == ix.Amount
}
