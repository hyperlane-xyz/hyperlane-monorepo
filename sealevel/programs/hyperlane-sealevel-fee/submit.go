package fee

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	quoteverifier "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/quote-verifier"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// decodeAndSubmitQuote decodes Instruction::SubmitQuote(SvmSignedQuote).
func decodeAndSubmitQuote(c solana.Context, r *borsh.Reader) uint64 {
	q := new(quoteverifier.SvmSignedQuote)
	q.DecodeBorsh(r)
	if !r.Done() {
		return svm.InvalidInstructionData
	}
	return processSubmitQuote(c, q)
}

// processSubmitQuote verifies a signed offchain quote and stores it in a
// transient (expiry == issued_at) or standing quote PDA.
//
// Accounts:
// 0. `[executable]` System program.
// 1. `[signer, writable]` Payer.
// 2. `[]` Fee account.
// 3..N. `[]` Route PDA (Routing/CC exact domain only).
// N+1. `[writable]` Transient or standing quote PDA.
func processSubmitQuote(c solana.Context, q *quoteverifier.SvmSignedQuote) uint64 {
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
	if !svm.OwnerIs(c, feeIdx, programID) {
		return svm.IncorrectProgramID
	}
	fa, code := fetchFeeAccount(c, feeIdx)
	if code != svm.Success {
		return code
	}
	now, code := unixTimestamp(c)
	if code != svm.Success {
		return code
	}
	if code := q.ValidateSubmission(fa.MinIssuedAt, now); code != 0 {
		return code
	}
	issuedAt := q.IssuedAtTimestamp()
	expiry := q.ExpiryTimestamp()
	feeKey := svm.Key(c, feeIdx)
	payerKey := svm.Key(c, payerIdx)

	// Resolve the authorized signers.
	var signers OptionSigners
	switch fa.FeeData.Kind {
	case FeeDataLeaf:
		signers = fa.FeeData.Leaf.Signers
	case FeeDataRouting:
		ctx, code := ParseQuoteContext(q.Context, false)
		if code != svm.Success {
			return code
		}
		if ctx.DestinationDomain == WildcardDomain {
			signers = OptionSigners{Some: true, Value: fa.FeeData.WildcardSigners}
		} else {
			signers, code = routeSigners(c, &it, &programID, &feeKey, RouteDomainSeeds(&feeKey, ctx.DestinationDomain), false)
			if code != svm.Success {
				return code
			}
		}
	default:
		ctx, code := ParseQuoteContext(q.Context, true)
		if code != svm.Success {
			return code
		}
		if ctx.TargetRouter == zeroH256 {
			return ErrZeroTargetRouterNotAllowed
		}
		if ctx.DestinationDomain == WildcardDomain {
			signers = OptionSigners{Some: true, Value: fa.FeeData.WildcardSigners}
		} else {
			signers, code = routeSigners(c, &it, &programID, &feeKey, CCRouteSeeds(&feeKey, ctx.DestinationDomain, &ctx.TargetRouter), true)
			if code != svm.Success {
				return code
			}
		}
	}
	if !signers.Some {
		return ErrOffchainQuotingNotConfigured
	}
	if _, code := q.VerifySigner(c, &feeKey, fa.DomainID, &payerKey, signers.Value); code != 0 {
		return code
	}

	if q.IsTransient() {
		transientIdx, code := it.Next()
		if code != svm.Success {
			return code
		}
		salt, code := q.ComputeScopedSalt(c, &payerKey)
		if code != 0 {
			return code
		}
		key, seeds, code := svm.FindProgramAddressSeeds(c, TransientQuoteSeeds(&feeKey, &salt), programID)
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, transientIdx, key) {
			return svm.InvalidArgument
		}
		if code := accountutils.VerifyAccountUninitialized(c, transientIdx); code != svm.Success {
			return code
		}
		if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
			return code
		}
		tq := new(TransientQuote)
		tq.BumpSeed = seeds.Bump()
		tq.Payer = payerKey
		tq.ScopedSalt = salt
		tq.Context = q.Context
		tq.Data = q.Data
		tq.Expiry = expiry
		if code := accountutils.CreatePDAAccount(c, payerIdx, accountutils.AccountDataSize(tq), programID, systemIdx, transientIdx, &seeds); code != svm.Success {
			return code
		}
		if code := accountutils.Store(c, transientIdx, tq, false); code != svm.Success {
			return code
		}
		svm.Log(c, "Submitted transient quote")
		return svm.Success
	}

	// Standing quote.
	isCC := fa.FeeData.Kind == FeeDataCrossCollateralRouting
	ctx, code := ParseQuoteContext(q.Context, isCC)
	if code != svm.Success {
		return ErrInvalidStandingQuoteContext
	}
	if ctx.Amount != WildcardAmount {
		return ErrStandingQuoteAmountNotWildcard
	}
	if isCC && ctx.TargetRouter == zeroH256 {
		return ErrZeroTargetRouterNotAllowed
	}
	if ctx.DestinationDomain == WildcardDomain && ctx.Recipient == WildcardRecipient {
		return quoteverifier.ErrFullyWildcardedQuote
	}
	quoted, ok := DecodeStrategyBytes(q.Data)
	if !ok {
		return ErrInvalidStandingQuoteData
	}
	domainIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	standingSeeds := StandingQuoteSeeds(&feeKey, ctx.DestinationDomain, &ctx.TargetRouter)
	bump, ok, code := accountutils.VerifyPDAWithStoredBump(c, domainIdx, StandingQuoteDiscriminator, standingSeeds, programID)
	if code != svm.Success {
		return code
	}
	if !ok {
		return svm.InvalidArgument
	}
	seeds, code := svm.NewSeeds(standingSeeds, bump)
	if code != svm.Success {
		return code
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	standing := new(FeeStandingQuotePda)
	isNew := false
	switch accountutils.InitState(c, domainIdx, programID) {
	case accountutils.Uninitialized:
		isNew = true
		standing.BumpSeed = seeds.Bump()
	case accountutils.Initialized:
		v, _, code := accountutils.FetchAccount[FeeStandingQuotePda](c, domainIdx)
		if code != svm.Success {
			return code
		}
		*standing = v
	default:
		return svm.IncorrectProgramID
	}
	if j := standing.find(&ctx.Recipient); j >= 0 {
		existing := standing.Quotes[j].Value.IssuedAt
		if issuedAt < existing {
			return quoteverifier.ErrStaleQuote
		}
		if issuedAt == existing {
			svm.Log(c, "Standing quote no-op (equal issued_at)")
			return svm.Success
		}
	}
	standing.insert(ctx.Recipient, FeeStandingQuoteValue{IssuedAt: issuedAt, Expiry: expiry, FeeData: quoted})
	if isNew {
		if code := accountutils.CreatePDAAccount(c, payerIdx, accountutils.AccountDataSize(standing), programID, systemIdx, domainIdx, &seeds); code != svm.Success {
			return code
		}
		code = accountutils.Store(c, domainIdx, standing, false)
	} else {
		code = accountutils.StoreWithRentExemptRealloc(c, domainIdx, standing, payerIdx, systemIdx)
	}
	if code != svm.Success {
		return code
	}
	m := svm.NewMsg("Submitted standing quote for domain ")
	m.U32(ctx.DestinationDomain)
	m.Str(" recipient ")
	m.H256Short(&ctx.Recipient)
	m.Emit(c)
	return svm.Success
}

// routeSigners takes the exact-domain route PDA and returns its signers.
// A route PDA not owned by this program is IncorrectProgramId for Routing
// and RouteNotFound for CC, as in Rust.
func routeSigners(c solana.Context, it *svm.AccountIter, programID, feeKey *Pubkey, seeds [][]byte, cc bool) (OptionSigners, uint64) {
	idx, code := it.Next()
	if code != svm.Success {
		return OptionSigners{}, code
	}
	disc := RouteDomainDiscriminator
	if cc {
		disc = CCRouteDiscriminator
	}
	ok, code := verifyPDA(c, idx, disc, seeds, programID)
	if code != svm.Success {
		return OptionSigners{}, code
	}
	if !ok {
		return OptionSigners{}, svm.InvalidArgument
	}
	if !svm.OwnerIs(c, idx, *programID) {
		if cc {
			return OptionSigners{}, ErrRouteNotFound
		}
		return OptionSigners{}, svm.IncorrectProgramID
	}
	if cc {
		route, _, code := accountutils.FetchAccount[CrossCollateralRoute](c, idx)
		return route.Signers, code
	}
	route, _, code := accountutils.FetchAccount[RouteDomain](c, idx)
	return route.Signers, code
}

// processCloseTransientQuote closes an orphaned transient quote PDA,
// refunding its original payer.
//
// Accounts:
// 0. `[]` Fee account.
// 1. `[writable]` Transient quote PDA.
// 2. `[signer, writable]` Original payer.
func processCloseTransientQuote(c solana.Context) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	feeIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.OwnerIs(c, feeIdx, programID) {
		return svm.IncorrectProgramID
	}
	transientIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.OwnerIs(c, transientIdx, programID) {
		return svm.IncorrectProgramID
	}
	tq, _, code := accountutils.FetchAccount[TransientQuote](c, transientIdx)
	if code != svm.Success {
		return code
	}
	feeKey := svm.Key(c, feeIdx)
	ok, code := verifyPDA(c, transientIdx, TransientQuoteDiscriminator, TransientQuoteSeeds(&feeKey, &tq.ScopedSalt), &programID)
	if code != svm.Success {
		return code
	}
	if !ok {
		return ErrTransientPdaMismatch
	}
	payerIdx, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, payerIdx) {
		return svm.MissingRequiredSignature
	}
	if !svm.KeyIs(c, payerIdx, tq.Payer) {
		return quoteverifier.ErrTransientPayerMismatch
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	if code := accountutils.CloseAccount(c, transientIdx, payerIdx); code != svm.Success {
		return code
	}
	svm.Log(c, "Closed transient quote PDA")
	return svm.Success
}

// consumeTransientQuote is try_consume_transient_quote: validate the
// transient PDA against the payer, its derivation, expiry and the QuoteFee
// context, compute the fee with the quoted params, then autoclose it.
func consumeTransientQuote(c solana.Context, programID *Pubkey, transientIdx, payerIdx uint64, feeKey *Pubkey, strategy *FeeDataStrategy, ix *QuoteFee, isCC, specificActive bool, minIssuedAt, now int64) (uint64, uint64) {
	tq := new(TransientQuote)
	v, _, code := accountutils.FetchAccount[TransientQuote](c, transientIdx)
	if code != svm.Success {
		return 0, code
	}
	*tq = v
	if !svm.KeyIs(c, payerIdx, tq.Payer) {
		return 0, quoteverifier.ErrTransientPayerMismatch
	}
	expected, code := svm.CreateProgramAddress(c, TransientQuoteSeeds(feeKey, &tq.ScopedSalt), tq.BumpSeed, *programID)
	if code != svm.Success || !svm.KeyIs(c, transientIdx, expected) {
		return 0, ErrTransientPdaMismatch
	}
	// Transient quotes have issued_at == expiry.
	if code := quoteverifier.ValidateQuote(tq.Expiry, tq.Expiry, minIssuedAt, now); code != 0 {
		return 0, code
	}
	ctx, code := ParseQuoteContext(tq.Context, isCC)
	if code != svm.Success {
		return 0, quoteverifier.ErrTransientContextMismatch
	}
	if isCC {
		scope := &ix.TargetRouter
		if !specificActive {
			scope = &DefaultRouter
		}
		if ctx.TargetRouter != *scope {
			return 0, quoteverifier.ErrTransientContextMismatch
		}
	}
	if !matchesContext(&ctx, ix) {
		return 0, quoteverifier.ErrTransientContextMismatch
	}
	quoted, ok := DecodeStrategyBytes(tq.Data)
	if !ok {
		return 0, ErrInvalidTransientData
	}
	if quoted.Kind != strategy.Kind {
		return 0, ErrCurveVariantMismatch
	}
	fee, code := quoted.ComputeFee(ix.Amount)
	if code != svm.Success {
		return 0, code
	}
	if !solana.Writable(c, transientIdx) {
		return 0, svm.InvalidAccountData
	}
	if code := accountutils.CloseAccount(c, transientIdx, payerIdx); code != svm.Success {
		return 0, code
	}
	return fee, svm.Success
}
