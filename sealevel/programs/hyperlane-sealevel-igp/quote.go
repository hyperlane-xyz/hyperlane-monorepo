package igp

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	quoteverifier "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/quote-verifier"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// The offchain-quote paths: SubmitIgpQuote, the quoted PayForGas and
// QuoteGasPayment flows (transient quote, else the standing cascade), and
// the quote close instructions.

// resolvedQuote is ResolvedQuote.
type resolvedQuote struct {
	tokenExchangeRate, gasPrice U128
	tokenDecimals               uint8
}

type quotedPayment struct {
	payment, gasAmount uint64
	transient          uint64
	hasTransient       bool
}

// standingCascade is try_standing_cascade over (domain, sender),
// (domain, WILDCARD_SENDER), (WILDCARD_DOMAIN, sender). All three PDAs must
// be present and match; every one is consumed and derived even after a
// higher-priority level resolved.
func standingCascade(c solana.Context, it *svm.AccountIter, programID, igpKey Pubkey, domain uint32, sender *Pubkey, minIssuedAt, now int64) (resolvedQuote, bool, uint64) {
	var resolved resolvedQuote
	found := false
	var mint Pubkey // Only lamports (the default mint) today.
	domainLE := u32LE(domain)
	wildcardLE := u32LE(WildcardDomain)
	for level := 0; level < 3; level++ {
		account, code := it.Next()
		if code != svm.Success {
			return resolved, false, code
		}
		levelDomain, levelSender := domainLE, sender
		if level == 1 {
			levelSender = &WildcardSender
		} else if level == 2 {
			levelDomain = wildcardLE
		}
		key, _, code := svm.FindProgramAddress(c, StandingQuotePDASeeds(&igpKey, &mint, levelDomain, levelSender), programID)
		if code != svm.Success {
			return resolved, false, code
		}
		if !svm.KeyIs(c, account, key) {
			return resolved, false, svm.InvalidArgument
		}
		if found {
			continue
		}
		switch accountutils.InitState(c, account, programID) {
		case accountutils.OwnerMismatch:
			return resolved, false, svm.IncorrectProgramID
		case accountutils.Initialized:
			standing, _, code := accountutils.FetchAccount[IgpStandingQuote](c, account)
			if code != svm.Success {
				return resolved, false, code
			}
			if quoteverifier.ValidateQuote(standing.IssuedAt, standing.Expiry, minIssuedAt, now) == 0 {
				resolved = resolvedQuote{standing.TokenExchangeRate, standing.GasPrice, standing.TokenDecimals}
				found = true
			}
		}
	}
	return resolved, found, svm.Success
}

// resolveTransientQuote is try_resolve_transient_quote: account is known to
// hold a transient quote, so every mismatch is a hard error.
func resolveTransientQuote(c solana.Context, account uint64, programID, igpKey, payer Pubkey, domain uint32, sender *Pubkey, minIssuedAt, now int64) (resolvedQuote, uint64) {
	var resolved resolvedQuote
	transient, _, code := accountutils.FetchAccount[IgpTransientQuote](c, account)
	if code != svm.Success {
		return resolved, code
	}
	key, _, code := svm.FindProgramAddress(c, TransientQuotePDASeeds(&igpKey, &transient.ScopedSalt), programID)
	if code != svm.Success {
		return resolved, code
	}
	if !svm.KeyIs(c, account, key) {
		return resolved, svm.InvalidSeeds
	}
	if transient.Payer != payer {
		return resolved, quoteverifier.ErrTransientPayerMismatch
	}
	if transient.FeeTokenMint != (Pubkey{}) {
		return resolved, quoteverifier.ErrTransientContextMismatch
	}
	domainMatches := transient.DestinationDomain == domain || transient.DestinationDomain == WildcardDomain
	senderMatches := transient.Sender == *sender || transient.Sender == WildcardSender
	if !domainMatches || !senderMatches {
		return resolved, quoteverifier.ErrTransientContextMismatch
	}
	// Transient quotes have issued_at == expiry.
	if code := quoteverifier.ValidateQuote(transient.Expiry, transient.Expiry, minIssuedAt, now); code != 0 {
		return resolved, code
	}
	return resolvedQuote{transient.TokenExchangeRate, transient.GasPrice, transient.TokenDecimals}, svm.Success
}

// quotedGas finishes both quoted flows: the optional overhead IGP after the
// quote PDAs, no further accounts, then the quote's fee or the oracle's.
func quotedGas(c solana.Context, it *svm.AccountIter, programID, igpKey Pubkey, igp *Igp, ix *Instruction, q *resolvedQuote, found bool) (payment, gasAmount, code uint64) {
	gasAmount = ix.GasAmount
	if it.HasMore() {
		overhead, _ := it.Next()
		if gasAmount, code = applyOverheadGas(c, overhead, programID, igpKey, ix.DestinationDomain, ix.GasAmount); code != svm.Success {
			return
		}
	}
	if code = accountutils.EnsureNoExtraneousAccounts(it); code != svm.Success {
		return
	}
	if found {
		payment, code = ComputeGasFee(q.tokenExchangeRate, q.gasPrice, gasAmount, q.tokenDecimals)
	} else {
		payment, code = igp.QuoteGasPayment(ix.DestinationDomain, gasAmount)
	}
	return
}

// isTransientQuote is pay_for_gas's peek: an initialized program account
// whose data starts (after AccountData's flag) with IgpTransientQuote's
// discriminator.
func isTransientQuote(c solana.Context, i uint64, programID Pubkey) bool {
	if accountutils.InitState(c, i, programID) != accountutils.Initialized {
		return false
	}
	data := solana.Data(c, i)
	if len(data) <= accountutils.DiscriminatorLength {
		return false
	}
	for j := 0; j < accountutils.DiscriminatorLength; j++ {
		if data[1+j] != IgpTransientQuoteDiscriminator[j] {
			return false
		}
	}
	return true
}

// payForGasQuoted is pay_for_gas's new flow, from account 6 (the
// sender_authority, already taken).
//
// 6. `[signer]` sender_authority (IGP quote authority PDA of quoted_sender).
// 7. `[]` quoted_sender (warp route program ID).
// 8. `[]` Transient quote PDA, or the exact / wildcard-sender /
// wildcard-domain standing quote PDAs.
// .. `[]` Overhead IGP account (optional).
func payForGasQuoted(c solana.Context, it *svm.AccountIter, senderAuthority, payer uint64, programID, igpKey Pubkey, igp *Igp, ix *Instruction) (quotedPayment, uint64) {
	var out quotedPayment
	if !solana.Signer(c, senderAuthority) {
		return out, svm.MissingRequiredSignature
	}
	quotedSenderInfo, code := it.Next()
	if code != svm.Success {
		return out, code
	}
	quotedSender := svm.Key(c, quotedSenderInfo)
	authority, _, code := svm.FindProgramAddress(c, QuoteAuthorityPDASeeds, quotedSender)
	if code != svm.Success {
		return out, code
	}
	if !svm.KeyIs(c, senderAuthority, authority) {
		return out, svm.InvalidSeeds
	}
	if !it.HasMore() {
		return out, svm.NotEnoughAccountKeys
	}
	clock, code := svm.GetClock(c)
	if code != svm.Success {
		return out, code
	}
	if !igp.FeeConfig.Some {
		return out, ErrQuoteConfigNotSet
	}
	minIssuedAt := igp.FeeConfig.Value.MinIssuedAt

	var q resolvedQuote
	var found bool
	if isTransientQuote(c, it.Position(), programID) {
		out.transient, _ = it.Next()
		out.hasTransient = true
		if q, code = resolveTransientQuote(c, out.transient, programID, igpKey, svm.Key(c, payer), ix.DestinationDomain, &quotedSender, minIssuedAt, clock.UnixTimestamp); code != svm.Success {
			return out, code
		}
		found = true
	} else if q, found, code = standingCascade(c, it, programID, igpKey, ix.DestinationDomain, &quotedSender, minIssuedAt, clock.UnixTimestamp); code != svm.Success {
		return out, code
	}
	out.payment, out.gasAmount, code = quotedGas(c, it, programID, igpKey, igp, ix, &q, found)
	return out, code
}

// quoteGasPaymentQuoted is quote_gas_payment's new flow, from account 2 (the
// quoted_sender, already taken; informational, not a signer), then the three
// standing quote PDAs and an optional overhead IGP.
func quoteGasPaymentQuoted(c solana.Context, it *svm.AccountIter, quotedSenderInfo uint64, programID, igpKey Pubkey, igp *Igp, ix *Instruction) (uint64, uint64) {
	quotedSender := svm.Key(c, quotedSenderInfo)
	if !it.HasMore() {
		return 0, svm.NotEnoughAccountKeys
	}
	clock, code := svm.GetClock(c)
	if code != svm.Success {
		return 0, code
	}
	if !igp.FeeConfig.Some {
		return 0, ErrQuoteConfigNotSet
	}
	q, found, code := standingCascade(c, it, programID, igpKey, ix.DestinationDomain, &quotedSender, igp.FeeConfig.Value.MinIssuedAt, clock.UnixTimestamp)
	if code != svm.Success {
		return 0, code
	}
	payment, _, code := quotedGas(c, it, programID, igpKey, igp, ix, &q, found)
	return payment, code
}

// submitIgpQuote is SubmitIgpQuote: a standing quote (expiry > issued_at)
// creates or updates its standing PDA; a transient one creates its
// payer-scoped transient PDA.
//
// Accounts:
// 0. `[executable]` The system program.
// 1. `[signer, writeable]` The payer.
// 2. `[]` The IGP account.
// 3. `[writeable]` The quote PDA (standing or transient).
func submitIgpQuote(c solana.Context, ix *Instruction) uint64 {
	programID := svm.ProgramID(c)
	quote := &ix.Quote
	it := svm.NewAccountIter(c)
	system, code := systemProgramAccount(c, &it)
	if code != svm.Success {
		return code
	}
	payer, code := signerAccount(c, &it)
	if code != svm.Success {
		return code
	}
	igpInfo, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.OwnerIs(c, igpInfo, programID) {
		return svm.IncorrectProgramID
	}
	igp, code := fetchIgp(c, igpInfo)
	if code != svm.Success {
		return code
	}
	if code := verifyIgpKey(c, igpInfo, igp, programID); code != svm.Success {
		return code
	}
	if !igp.FeeConfig.Some {
		return ErrQuoteConfigNotSet
	}
	feeConfig := &igp.FeeConfig.Value
	quotePDA, code := it.Next()
	if code != svm.Success {
		return code
	}

	ctx, code := ParseIgpQuoteContext(quote.Context)
	if code != svm.Success {
		return code
	}
	data, code := ParseIgpQuoteData(quote.Data)
	if code != svm.Success {
		return code
	}
	if ctx.FeeTokenMint != (Pubkey{}) {
		return ErrNonDefaultFeeTokenMint
	}

	igpKey, payerKey := svm.Key(c, igpInfo), svm.Key(c, payer)
	if _, code := quote.VerifySigner(c, &igpKey, feeConfig.DomainID, &payerKey, feeConfig.Signers); code != 0 {
		return code
	}
	clock, code := svm.GetClock(c)
	if code != svm.Success {
		return code
	}
	if code := quote.ValidateSubmission(feeConfig.MinIssuedAt, clock.UnixTimestamp); code != 0 {
		return code
	}
	issuedAt, expiry := quote.IssuedAtTimestamp(), quote.ExpiryTimestamp()

	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}

	if quote.IsTransient() {
		scopedSalt, code := quote.ComputeScopedSalt(c, &payerKey)
		if code != 0 {
			return code
		}
		key, seeds, code := svm.FindProgramAddressSeeds(c, TransientQuotePDASeeds(&igpKey, &scopedSalt), programID)
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, quotePDA, key) {
			return svm.InvalidSeeds
		}
		switch accountutils.InitState(c, quotePDA, programID) {
		case accountutils.Initialized:
			return svm.AccountAlreadyInitialized
		case accountutils.OwnerMismatch:
			return svm.IncorrectProgramID
		}
		transient := &IgpTransientQuote{
			BumpSeed:          seeds.Bump(),
			Payer:             payerKey,
			ScopedSalt:        scopedSalt,
			FeeTokenMint:      ctx.FeeTokenMint,
			DestinationDomain: ctx.DestinationDomain,
			Sender:            ctx.Sender,
			TokenExchangeRate: data.TokenExchangeRate,
			GasPrice:          data.GasPrice,
			TokenDecimals:     data.TokenDecimals,
			Expiry:            expiry,
		}
		if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(transient), programID, system, quotePDA, &seeds); code != svm.Success {
			return code
		}
		return accountutils.Store(c, quotePDA, transient, false)
	}

	// Fully wildcarded standing quotes would be shared across payers and
	// override the cascade; transient quotes are payer-scoped.
	if ctx.DestinationDomain == WildcardDomain && ctx.Sender == WildcardSender {
		return quoteverifier.ErrFullyWildcardedQuote
	}
	key, seeds, code := svm.FindProgramAddressSeeds(c, StandingQuotePDASeeds(&igpKey, &ctx.FeeTokenMint, u32LE(ctx.DestinationDomain), &ctx.Sender), programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, quotePDA, key) {
		return svm.InvalidSeeds
	}
	standing := &IgpStandingQuote{
		BumpSeed:          seeds.Bump(),
		FeeTokenMint:      ctx.FeeTokenMint,
		DestinationDomain: ctx.DestinationDomain,
		Sender:            ctx.Sender,
		TokenExchangeRate: data.TokenExchangeRate,
		GasPrice:          data.GasPrice,
		TokenDecimals:     data.TokenDecimals,
		IssuedAt:          issuedAt,
		Expiry:            expiry,
	}
	switch accountutils.InitState(c, quotePDA, programID) {
	case accountutils.Uninitialized:
		if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(standing), programID, system, quotePDA, &seeds); code != svm.Success {
			return code
		}
	case accountutils.Initialized:
		existing, _, code := accountutils.FetchAccount[IgpStandingQuote](c, quotePDA)
		if code != svm.Success {
			return code
		}
		if issuedAt < existing.IssuedAt {
			return quoteverifier.ErrStaleStandingQuoteUpdate
		}
		// Equal issued_at is a no-op, matching EVM and the fee program.
		if issuedAt == existing.IssuedAt {
			svm.Log(c, "IGP standing quote no-op (equal issued_at)")
			return svm.Success
		}
	default:
		return svm.IncorrectProgramID
	}
	return accountutils.Store(c, quotePDA, standing, false)
}

// closeIgpTransientQuote is CloseIgpTransientQuote: closes an orphaned
// transient quote PDA, refunding its rent to the stored payer.
//
// Accounts:
// 0. `[writeable]` The transient quote PDA.
// 1. `[signer, writeable]` The payer (must match the stored payer).
// 2. `[]` The IGP account (for PDA re-derivation).
func closeIgpTransientQuote(c solana.Context) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	transientInfo, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.OwnerIs(c, transientInfo, programID) {
		return svm.IncorrectProgramID
	}
	transient, _, code := accountutils.FetchAccount[IgpTransientQuote](c, transientInfo)
	if code != svm.Success {
		return code
	}
	payer, code := signerAccount(c, &it)
	if code != svm.Success {
		return code
	}
	igpInfo, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.OwnerIs(c, igpInfo, programID) {
		return svm.IncorrectProgramID
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, payer, transient.Payer) {
		return quoteverifier.ErrTransientPayerMismatch
	}
	igpKey := svm.Key(c, igpInfo)
	key, _, code := svm.FindProgramAddress(c, TransientQuotePDASeeds(&igpKey, &transient.ScopedSalt), programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, transientInfo, key) {
		return svm.InvalidSeeds
	}
	return closeAccount(c, transientInfo, payer)
}

// closeIgpStandingQuote is CloseIgpStandingQuote: closes an expired standing
// quote PDA, refunding its rent to the IGP's beneficiary.
//
// Accounts:
// 0. `[writeable]` The standing quote PDA.
// 1. `[]` The IGP account (for PDA re-derivation and the beneficiary).
// 2. `[writeable]` The beneficiary.
func closeIgpStandingQuote(c solana.Context) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	standingInfo, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.OwnerIs(c, standingInfo, programID) {
		return svm.IncorrectProgramID
	}
	standing, _, code := accountutils.FetchAccount[IgpStandingQuote](c, standingInfo)
	if code != svm.Success {
		return code
	}
	igpInfo, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.OwnerIs(c, igpInfo, programID) {
		return svm.IncorrectProgramID
	}
	igp, code := fetchIgp(c, igpInfo)
	if code != svm.Success {
		return code
	}
	beneficiary, code := it.Next()
	if code != svm.Success {
		return code
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, beneficiary, igp.Beneficiary) {
		return ErrBeneficiaryMismatch
	}
	igpKey := svm.Key(c, igpInfo)
	key, _, code := svm.FindProgramAddress(c, StandingQuotePDASeeds(&igpKey, &standing.FeeTokenMint, u32LE(standing.DestinationDomain), &standing.Sender), programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, standingInfo, key) {
		return svm.InvalidSeeds
	}
	clock, code := svm.GetClock(c)
	if code != svm.Success {
		return code
	}
	if clock.UnixTimestamp <= standing.Expiry {
		return ErrStandingQuoteNotExpired
	}
	return closeAccount(c, standingInfo, beneficiary)
}
