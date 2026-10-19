// Package igp ports rust/sealevel/programs/hyperlane-sealevel-igp (default
// no-spl-noop build) to goSVM: the interchain gas paymaster, its overhead
// IGPs, gas oracles and offchain-quoted gas payments. Instruction data,
// account layouts, PDA seeds, return data and ProgramError codes match the
// Rust program byte for byte.
//
// Not emitted: Rust's msg! log lines (goSVM has no user logging yet).
package igp

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// PDA seed prefixes (pda_seeds.rs). Per-account seeds append "-" and a key.
var (
	seedPrefix         = []byte("hyperlane_igp")
	seedDash           = []byte("-")
	seedProgramData    = []byte("program_data")
	seedIgp            = []byte("igp")
	seedOverheadIgp    = []byte("overhead_igp")
	seedStandingQuote  = []byte("standing_quote")
	seedTransientQuote = []byte("transient_quote")
	seedGasPayment     = []byte("gas_payment")

	// ProgramDataPDASeeds is igp_program_data_pda_seeds!().
	ProgramDataPDASeeds = [][]byte{seedPrefix, seedDash, seedProgramData}
	// QuoteAuthorityPDASeeds is igp_quote_authority_pda_seeds!(), derived
	// under the calling (warp route) program.
	QuoteAuthorityPDASeeds = [][]byte{[]byte("hyperlane_dispatcher"), seedDash, []byte("igp_quote_authority")}
)

// IgpPDASeeds is igp_pda_seeds!(salt).
func IgpPDASeeds(salt *H256) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedIgp, seedDash, salt[:]}
}

// OverheadIgpPDASeeds is overhead_igp_pda_seeds!(salt).
func OverheadIgpPDASeeds(salt *H256) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedOverheadIgp, seedDash, salt[:]}
}

// GasPaymentPDASeeds is igp_gas_payment_pda_seeds!(unique_gas_payment_pubkey).
func GasPaymentPDASeeds(unique *Pubkey) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedGasPayment, seedDash, unique[:]}
}

// StandingQuotePDASeeds is igp_standing_quote_pda_seeds!(igp, mint, domain_le, sender).
func StandingQuotePDASeeds(igp, mint *Pubkey, domainLE []byte, sender *Pubkey) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedStandingQuote, seedDash, igp[:], seedDash, mint[:], seedDash, domainLE, seedDash, sender[:]}
}

// TransientQuotePDASeeds is igp_transient_quote_pda_seeds!(igp, scoped_salt).
func TransientQuotePDASeeds(igp *Pubkey, scopedSalt *H256) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedTransientQuote, seedDash, igp[:], seedDash, scopedSalt[:]}
}

func u32LE(v uint32) []byte {
	return []byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}
}

// Process is the program entrypoint (processor::process_instruction).
func Process(c solana.Context) uint64 {
	data := solana.Instruction(c)
	if packageversioned.IsGetProgramVersion(data) {
		return packageversioned.ProcessGetProgramVersion(c)
	}
	ix := new(Instruction)
	if !DecodeInstruction(data, ix) {
		return svm.BorshIoError
	}
	switch ix.Kind {
	case IxInit:
		return initialize(c)
	case IxInitIgp:
		return initIgp(c, ix)
	case IxInitOverheadIgp:
		return initOverheadIgp(c, ix)
	case IxPayForGas:
		return payForGas(c, ix)
	case IxQuoteGasPayment:
		return quoteGasPayment(c, ix)
	case IxTransferIgpOwnership:
		return transferIgpOwnership(c, ix.NewOwner)
	case IxTransferOverheadIgpOwnership:
		return transferOverheadIgpOwnership(c, ix.NewOwner)
	case IxSetIgpBeneficiary:
		return setIgpBeneficiary(c, ix.Key)
	case IxClaim:
		return claim(c)
	case IxSetDestinationGasOverheads:
		return setDestinationGasOverheads(c, ix.GasOverheads)
	case IxSetGasOracleConfigs:
		return setGasOracleConfigs(c, ix.GasOracles)
	case IxSetIgpQuoteConfig:
		return setIgpQuoteConfig(c, &ix.FeeConfig)
	case IxSetIgpQuoteSigner:
		return setIgpQuoteSigner(c, ix.SignerOp, ix.Signer)
	case IxSetIgpMinIssuedAt:
		return setIgpMinIssuedAt(c, ix.MinIssuedAt)
	case IxSubmitIgpQuote:
		return submitIgpQuote(c, ix)
	case IxCloseIgpTransientQuote:
		return closeIgpTransientQuote(c)
	case IxCloseIgpStandingQuote:
		return closeIgpStandingQuote(c)
	case IxGetIgpQuoteAccountMetas:
		return getIgpQuoteAccountMetas(c, ix)
	}
	return svm.BorshIoError
}

// systemProgramAccount takes the next account and checks it is the System
// program (IncorrectProgramId otherwise).
func systemProgramAccount(c solana.Context, it *svm.AccountIter) (uint64, uint64) {
	i, code := it.Next()
	if code != svm.Success {
		return 0, code
	}
	if !svm.KeyIs(c, i, svm.SystemProgramID) {
		return 0, svm.IncorrectProgramID
	}
	return i, svm.Success
}

// signerAccount takes the next account and checks it signed.
func signerAccount(c solana.Context, it *svm.AccountIter) (uint64, uint64) {
	i, code := it.Next()
	if code != svm.Success {
		return 0, code
	}
	if !solana.Signer(c, i) {
		return 0, svm.MissingRequiredSignature
	}
	return i, svm.Success
}

// initialize is Init.
//
// Accounts:
// 0. `[executable]` The system program.
// 1. `[signer]` The payer account.
// 2. `[writeable]` The program data PDA account.
func initialize(c solana.Context) uint64 {
	it := svm.NewAccountIter(c)
	system, code := systemProgramAccount(c, &it)
	if code != svm.Success {
		return code
	}
	payer, code := signerAccount(c, &it)
	if code != svm.Success {
		return code
	}
	programData, code := it.Next()
	if code != svm.Success {
		return code
	}
	if code := accountutils.VerifyAccountUninitialized(c, programData); code != svm.Success {
		return code
	}
	programID := svm.ProgramID(c)
	key, seeds, code := svm.FindProgramAddressSeeds(c, ProgramDataPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, programData, key) {
		return svm.InvalidSeeds
	}
	v := ProgramData{BumpSeed: seeds.Bump()}
	if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(&v), programID, system, programData, &seeds); code != svm.Success {
		return code
	}
	return accountutils.Store(c, programData, &v, false)
}

// initVariant is init_igp_variant up to the PDA creation: it returns the
// system program, payer and account indices, the bump and the signer seeds.
//
// Accounts:
// 0. `[executable]` The system program.
// 1. `[signer]` The payer account.
// 2. `[writeable]` The IGP variant account to initialize.
func initVariant(c solana.Context, pdaSeeds [][]byte) (system, payer, account uint64, seeds svm.Seeds, code uint64) {
	it := svm.NewAccountIter(c)
	if system, code = systemProgramAccount(c, &it); code != svm.Success {
		return
	}
	if payer, code = signerAccount(c, &it); code != svm.Success {
		return
	}
	if account, code = it.Next(); code != svm.Success {
		return
	}
	if code = accountutils.VerifyAccountUninitialized(c, account); code != svm.Success {
		return
	}
	var key Pubkey
	if key, seeds, code = svm.FindProgramAddressSeeds(c, pdaSeeds, svm.ProgramID(c)); code != svm.Success {
		return
	}
	if !svm.KeyIs(c, account, key) {
		code = svm.InvalidSeeds
	}
	return
}

// initIgp is InitIgp.
func initIgp(c solana.Context, ix *Instruction) uint64 {
	system, payer, account, seeds, code := initVariant(c, IgpPDASeeds(&ix.Salt))
	if code != svm.Success {
		return code
	}
	v := &Igp{BumpSeed: seeds.Bump(), Salt: ix.Salt, Owner: ix.Owner, Beneficiary: ix.Key}
	if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(v), svm.ProgramID(c), system, account, &seeds); code != svm.Success {
		return code
	}
	return accountutils.Store(c, account, v, false)
}

// initOverheadIgp is InitOverheadIgp.
func initOverheadIgp(c solana.Context, ix *Instruction) uint64 {
	system, payer, account, seeds, code := initVariant(c, OverheadIgpPDASeeds(&ix.Salt))
	if code != svm.Success {
		return code
	}
	v := &OverheadIgp{BumpSeed: seeds.Bump(), Salt: ix.Salt, Owner: ix.Owner, Inner: ix.Key}
	if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(v), svm.ProgramID(c), system, account, &seeds); code != svm.Success {
		return code
	}
	return accountutils.Store(c, account, v, false)
}

// fetchIgp fetches account i as an IgpAccount (BorshIoError if malformed;
// empty or uninitialized data is the zero Igp).
func fetchIgp(c solana.Context, i uint64) (*Igp, uint64) {
	v, _, code := accountutils.FetchAccount[Igp](c, i)
	if code != svm.Success {
		return nil, code
	}
	return &v, svm.Success
}

func fetchOverheadIgp(c solana.Context, i uint64) (*OverheadIgp, uint64) {
	v, _, code := accountutils.FetchAccount[OverheadIgp](c, i)
	if code != svm.Success {
		return nil, code
	}
	return &v, svm.Success
}

// verifyIgpKey checks account i is the IGP PDA for igp's salt and bump.
func verifyIgpKey(c solana.Context, i uint64, igp *Igp, programID Pubkey) uint64 {
	key, code := svm.CreateProgramAddress(c, IgpPDASeeds(&igp.Salt), igp.BumpSeed, programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, i, key) {
		return svm.InvalidSeeds
	}
	return svm.Success
}

// applyOverheadGas is apply_overhead_gas: verifies an overhead IGP account
// for igpKey and returns gasAmount plus its overhead for the domain.
func applyOverheadGas(c solana.Context, i uint64, programID, igpKey Pubkey, domain uint32, gasAmount uint64) (uint64, uint64) {
	if !svm.OwnerIs(c, i, programID) {
		return 0, svm.IncorrectProgramID
	}
	return overheadGas(c, i, programID, igpKey, domain, gasAmount)
}

// overheadGas is apply_overhead_gas after its owner check.
func overheadGas(c solana.Context, i uint64, programID, igpKey Pubkey, domain uint32, gasAmount uint64) (uint64, uint64) {
	overhead, code := fetchOverheadIgp(c, i)
	if code != svm.Success {
		return 0, code
	}
	key, code := svm.CreateProgramAddress(c, OverheadIgpPDASeeds(&overhead.Salt), overhead.BumpSeed, programID)
	if code != svm.Success {
		return 0, code
	}
	if !svm.KeyIs(c, i, key) || overhead.Inner != igpKey {
		return 0, svm.InvalidArgument
	}
	total := overhead.GasOverhead(domain) + gasAmount
	if total < gasAmount {
		return 0, svm.ArithmeticOverflow
	}
	return total, svm.Success
}

// payForGas is PayForGas.
//
// Old flow accounts:
// 0. `[executable]` The system program.
// 1. `[signer]` The payer.
// 2. `[writeable]` The IGP program data.
// 3. `[signer]` Unique gas payment account.
// 4. `[writeable]` Gas payment PDA.
// 5. `[writeable]` The IGP account (owner == program_id).
// 6. `[]` Overhead IGP account (optional, owner == program_id).
//
// New flow (account 6 owner != program_id): 6. `[signer]` sender_authority,
// 7. `[]` quoted_sender, then a transient quote PDA or the three standing
// quote PDAs (exact, wildcard-sender, wildcard-domain), then an optional
// overhead IGP.
func payForGas(c solana.Context, ix *Instruction) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	system, code := systemProgramAccount(c, &it)
	if code != svm.Success {
		return code
	}
	payer, code := signerAccount(c, &it)
	if code != svm.Success {
		return code
	}

	// Account 2: the program data.
	programDataInfo, code := it.Next()
	if code != svm.Success {
		return code
	}
	programData, _, code := accountutils.FetchAccount[ProgramData](c, programDataInfo)
	if code != svm.Success {
		return code
	}
	programDataKey, code := svm.CreateProgramAddress(c, ProgramDataPDASeeds, programData.BumpSeed, programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, programDataInfo, programDataKey) {
		return svm.InvalidSeeds
	}
	if !svm.OwnerIs(c, programDataInfo, programID) {
		return svm.IncorrectProgramID
	}

	// Account 3: the unique gas payment account.
	unique, code := signerAccount(c, &it)
	if code != svm.Success {
		return code
	}
	uniqueKey := svm.Key(c, unique)

	// Account 4: the gas payment PDA.
	gasPaymentInfo, code := it.Next()
	if code != svm.Success {
		return code
	}
	gasPaymentKey, gasPaymentSeeds, code := svm.FindProgramAddressSeeds(c, GasPaymentPDASeeds(&uniqueKey), programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, gasPaymentInfo, gasPaymentKey) {
		return svm.InvalidSeeds
	}
	if code := accountutils.VerifyAccountUninitialized(c, gasPaymentInfo); code != svm.Success {
		return code
	}

	// Account 5: the IGP.
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
	igpKey := svm.Key(c, igpInfo)

	// Account 6: overhead IGP (old flow) or sender_authority (new flow).
	var requiredPayment, gasAmount uint64
	transient := uint64(0)
	hasTransient := false
	if !it.HasMore() {
		gasAmount = ix.GasAmount
		if requiredPayment, code = igp.QuoteGasPayment(ix.DestinationDomain, gasAmount); code != svm.Success {
			return code
		}
	} else if next, _ := it.Next(); svm.OwnerIs(c, next, programID) {
		if gasAmount, code = overheadGas(c, next, programID, igpKey, ix.DestinationDomain, ix.GasAmount); code != svm.Success {
			return code
		}
		if requiredPayment, code = igp.QuoteGasPayment(ix.DestinationDomain, gasAmount); code != svm.Success {
			return code
		}
	} else {
		q, code := payForGasQuoted(c, &it, next, payer, programID, igpKey, igp, ix)
		if code != svm.Success {
			return code
		}
		requiredPayment, gasAmount, transient, hasTransient = q.payment, q.gasAmount, q.transient, q.hasTransient
	}

	// Transfer the required payment to the IGP.
	if code := svm.SystemTransfer(c, system, payer, igpInfo, requiredPayment, nil); code != svm.Success {
		return code
	}

	clock, code := svm.GetClock(c)
	if code != svm.Success {
		return code
	}
	payment := &GasPaymentData{
		SequenceNumber:         programData.PaymentCount,
		Igp:                    igpKey,
		DestinationDomain:      ix.DestinationDomain,
		MessageID:              ix.MessageID,
		GasAmount:              gasAmount,
		Payment:                requiredPayment,
		UniqueGasPaymentPubkey: uniqueKey,
		Slot:                   clock.Slot,
	}
	if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(payment), programID, system, gasPaymentInfo, &gasPaymentSeeds); code != svm.Success {
		return code
	}
	if code := accountutils.Store(c, gasPaymentInfo, payment, false); code != svm.Success {
		return code
	}

	if programData.PaymentCount == ^uint64(0) {
		return svm.ArithmeticOverflow
	}
	programData.PaymentCount++
	if code := accountutils.Store(c, programDataInfo, &programData, false); code != svm.Success {
		return code
	}

	if hasTransient {
		return closeAccount(c, transient, payer)
	}
	return svm.Success
}

// closeAccount is AccountInfoExt::close_account: move all lamports to
// recipient, truncate the data and assign the account to the System program.
// Rust's checks run first so goSVM's own codes never surface. Rust also
// zero-fills the data before truncating it; truncation alone leaves the same
// committed account.
func closeAccount(c solana.Context, i, recipient uint64) uint64 {
	if !solana.Writable(c, i) {
		return svm.InvalidAccountData
	}
	if svm.SameKey(c, i, recipient) {
		return svm.InvalidAccountData
	}
	if solana.Lamports(c, i) > ^uint64(0)-solana.Lamports(c, recipient) {
		return svm.ArithmeticOverflow
	}
	if solana.CloseAccount(c, i, recipient) != 0 {
		// Only reachable for a read-only or executable recipient, which Rust
		// reports after the instruction as a runtime error.
		return svm.InvalidAccountData
	}
	return svm.Success
}

// quoteGasPayment is QuoteGasPayment; the quote is the return data
// SimulationReturnData<u64>.
//
// Old flow accounts:
// 0. `[executable]` The system program.
// 1. `[]` The IGP account (owner == program_id).
// 2. `[]` The overhead IGP account (optional, owner == program_id).
//
// New flow (account 2 owner != program_id): 2. `[]` quoted_sender, then the
// three standing quote PDAs, then an optional overhead IGP.
func quoteGasPayment(c solana.Context, ix *Instruction) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	if _, code := systemProgramAccount(c, &it); code != svm.Success {
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

	var required uint64
	if !it.HasMore() {
		if required, code = igp.QuoteGasPayment(ix.DestinationDomain, ix.GasAmount); code != svm.Success {
			return code
		}
	} else if next, _ := it.Next(); svm.OwnerIs(c, next, programID) {
		gasAmount, code := overheadGas(c, next, programID, svm.Key(c, igpInfo), ix.DestinationDomain, ix.GasAmount)
		if code != svm.Success {
			return code
		}
		if required, code = igp.QuoteGasPayment(ix.DestinationDomain, gasAmount); code != svm.Success {
			return code
		}
	} else {
		if required, code = quoteGasPaymentQuoted(c, &it, next, programID, svm.Key(c, igpInfo), igp, ix); code != svm.Success {
			return code
		}
	}

	var out [9]byte
	for j := 0; j < 8; j++ {
		out[j] = byte(required >> (8 * uint64(j)))
	}
	out[8] = accountmeta.SimulationReturnDataTrailer
	return solana.SetReturnData(c, out[:])
}

// ownedVariant is an IGP account type with an AccessControl owner.
type ownedVariant[T any] interface {
	*T
	accountutils.Sized
	DecodeBorsh(r *borsh.Reader)
	owner() *accesscontrol.Owner
}

func (g *Igp) owner() *accesscontrol.Owner         { return &g.Owner }
func (o *OverheadIgp) owner() *accesscontrol.Owner { return &o.Owner }

// getVariantAndVerifyOwner is get_igp_variant_and_verify_owner.
//
// Accounts:
// 0. `[]` The IGP variant.
// 1. `[signer]` The owner of the IGP variant.
func getVariantAndVerifyOwner[T any, P ownedVariant[T]](c solana.Context, it *svm.AccountIter) (account uint64, v *T, ownerInfo uint64, code uint64) {
	if account, code = it.Next(); code != svm.Success {
		return
	}
	if !svm.OwnerIs(c, account, svm.ProgramID(c)) {
		code = svm.IncorrectProgramID
		return
	}
	value, _, code := accountutils.FetchAccount[T, P](c, account)
	if code != svm.Success {
		return
	}
	v = &value
	if ownerInfo, code = it.Next(); code != svm.Success {
		return
	}
	code = accesscontrol.EnsureOwnerSigner(c, *P(v).owner(), ownerInfo)
	return
}

// transferIgpOwnership is TransferIgpOwnership.
//
// Accounts:
// 0. `[writeable]` The IGP.
// 1. `[signer]` The owner of the IGP account.
func transferIgpOwnership(c solana.Context, newOwner accesscontrol.Owner) uint64 {
	it := svm.NewAccountIter(c)
	account, igp, _, code := getVariantAndVerifyOwner[Igp](c, &it)
	if code != svm.Success {
		return code
	}
	igp.Owner = newOwner
	return accountutils.Store(c, account, igp, false)
}

// transferOverheadIgpOwnership is TransferOverheadIgpOwnership.
func transferOverheadIgpOwnership(c solana.Context, newOwner accesscontrol.Owner) uint64 {
	it := svm.NewAccountIter(c)
	account, overhead, _, code := getVariantAndVerifyOwner[OverheadIgp](c, &it)
	if code != svm.Success {
		return code
	}
	overhead.Owner = newOwner
	return accountutils.Store(c, account, overhead, false)
}

// setIgpBeneficiary is SetIgpBeneficiary.
//
// Accounts:
// 0. `[]` The IGP.
// 1. `[signer]` The owner of the IGP account.
func setIgpBeneficiary(c solana.Context, beneficiary Pubkey) uint64 {
	it := svm.NewAccountIter(c)
	account, igp, _, code := getVariantAndVerifyOwner[Igp](c, &it)
	if code != svm.Success {
		return code
	}
	igp.Beneficiary = beneficiary
	return accountutils.Store(c, account, igp, false)
}

// claim is Claim: sends the IGP's lamports above its rent-exempt minimum to
// the beneficiary.
//
// Accounts:
// 0. `[executable]` The system program.
// 1. `[writeable]` The IGP.
// 2. `[writeable]` The IGP beneficiary.
func claim(c solana.Context) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	if _, code := systemProgramAccount(c, &it); code != svm.Success {
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
	beneficiary, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, beneficiary, igp.Beneficiary) {
		return svm.InvalidArgument
	}
	required, code := svm.MinimumBalance(c, uint64(len(solana.Data(c, igpInfo))))
	if code != svm.Success {
		return code
	}
	if lamports := solana.Lamports(c, igpInfo); lamports > required {
		// Rust's saturating_sub, -= and +=. A zero transfer moves nothing,
		// so read-only accounts only fail when there is something to claim.
		if code := solana.MoveLamports(c, igpInfo, beneficiary, lamports-required); code != 0 {
			// Read-only or executable beneficiary: Rust fails after the
			// instruction (the runtime rejects the lamport change).
			return svm.InvalidAccountData
		}
	}
	return accountutils.VerifyRentExempt(c, igpInfo)
}

// setDestinationGasOverheads is SetDestinationGasOverheads.
//
// Accounts:
// 0. `[executable]` The system program.
// 1. `[writeable]` The OverheadIGP.
// 2. `[signer]` The OverheadIGP owner.
func setDestinationGasOverheads(c solana.Context, configs []GasOverheadConfig) uint64 {
	it := svm.NewAccountIter(c)
	system, code := systemProgramAccount(c, &it)
	if code != svm.Success {
		return code
	}
	account, overhead, owner, code := getVariantAndVerifyOwner[OverheadIgp](c, &it)
	if code != svm.Success {
		return code
	}
	for i := range configs {
		cfg := &configs[i]
		if cfg.GasOverhead.Some {
			overhead.GasOverheads = insertOverhead(overhead.GasOverheads, cfg.DestinationDomain, cfg.GasOverhead.Value)
		} else {
			overhead.GasOverheads = removeOverhead(overhead.GasOverheads, cfg.DestinationDomain)
		}
	}
	return accountutils.StoreWithRentExemptRealloc(c, account, overhead, owner, system)
}

func insertOverhead(pairs []GasOverhead, key uint32, value uint64) []GasOverhead {
	j := 0
	for j < len(pairs) && pairs[j].Key < key {
		j++
	}
	if j < len(pairs) && pairs[j].Key == key {
		pairs[j].Value = value
		return pairs
	}
	pairs = append(pairs, GasOverhead{})
	copy(pairs[j+1:], pairs[j:])
	pairs[j] = GasOverhead{Key: key, Value: value}
	return pairs
}

func removeOverhead(pairs []GasOverhead, key uint32) []GasOverhead {
	for j := range pairs {
		if pairs[j].Key == key {
			copy(pairs[j:], pairs[j+1:])
			return pairs[:len(pairs)-1]
		}
	}
	return pairs
}

func insertOracle(pairs []GasOracleEntry, key uint32, value *GasOracle) []GasOracleEntry {
	j := 0
	for j < len(pairs) && pairs[j].Key < key {
		j++
	}
	if j < len(pairs) && pairs[j].Key == key {
		pairs[j].Value = *value
		return pairs
	}
	pairs = append(pairs, GasOracleEntry{})
	copy(pairs[j+1:], pairs[j:])
	pairs[j] = GasOracleEntry{Key: key, Value: *value}
	return pairs
}

func removeOracle(pairs []GasOracleEntry, key uint32) []GasOracleEntry {
	for j := range pairs {
		if pairs[j].Key == key {
			copy(pairs[j:], pairs[j+1:])
			return pairs[:len(pairs)-1]
		}
	}
	return pairs
}

// setGasOracleConfigs is SetGasOracleConfigs.
//
// Accounts:
// 0. `[executable]` The system program.
// 1. `[writeable]` The IGP.
// 2. `[signer]` The IGP owner.
func setGasOracleConfigs(c solana.Context, configs []GasOracleConfig) uint64 {
	it := svm.NewAccountIter(c)
	system, code := systemProgramAccount(c, &it)
	if code != svm.Success {
		return code
	}
	account, igp, owner, code := getVariantAndVerifyOwner[Igp](c, &it)
	if code != svm.Success {
		return code
	}
	for i := range configs {
		cfg := &configs[i]
		if cfg.GasOracle.Some {
			igp.GasOracles = insertOracle(igp.GasOracles, cfg.Domain, &cfg.GasOracle.Value)
		} else {
			igp.GasOracles = removeOracle(igp.GasOracles, cfg.Domain)
		}
	}
	return accountutils.StoreWithRentExemptRealloc(c, account, igp, owner, system)
}

// ownedIgp is the shared prefix of the quote-config instructions: system
// program, then the IGP and its signing owner, then no more accounts.
func ownedIgp(c solana.Context) (system, account uint64, igp *Igp, owner uint64, code uint64) {
	it := svm.NewAccountIter(c)
	if system, code = systemProgramAccount(c, &it); code != svm.Success {
		return
	}
	if account, igp, owner, code = getVariantAndVerifyOwner[Igp](c, &it); code != svm.Success {
		return
	}
	code = accountutils.EnsureNoExtraneousAccounts(&it)
	return
}

// setIgpQuoteConfig is SetIgpQuoteConfig.
//
// Accounts:
// 0. `[executable]` The system program.
// 1. `[writeable]` The IGP account.
// 2. `[signer]` The IGP owner.
func setIgpQuoteConfig(c solana.Context, config *borsh.Option[IgpFeeConfig]) uint64 {
	system, account, igp, owner, code := ownedIgp(c)
	if code != svm.Success {
		return code
	}
	if igp.FeeConfig.Some && config.Some && config.Value.MinIssuedAt < igp.FeeConfig.Value.MinIssuedAt {
		return svm.InvalidArgument
	}
	igp.FeeConfig = *config
	return accountutils.StoreWithRentExemptRealloc(c, account, igp, owner, system)
}

// setIgpQuoteSigner is SetIgpQuoteSigner.
func setIgpQuoteSigner(c solana.Context, op uint8, signer H160) uint64 {
	system, account, igp, owner, code := ownedIgp(c)
	if code != svm.Success {
		return code
	}
	if !igp.FeeConfig.Some {
		return svm.InvalidArgument
	}
	cfg := &igp.FeeConfig.Value
	j := 0
	for j < len(cfg.Signers) && borsh.Less20(cfg.Signers[j], signer) {
		j++
	}
	present := j < len(cfg.Signers) && cfg.Signers[j] == signer
	if op == SignerAdd {
		if !present {
			cfg.Signers = append(cfg.Signers, H160{})
			copy(cfg.Signers[j+1:], cfg.Signers[j:])
			cfg.Signers[j] = signer
		}
	} else {
		if !present {
			return svm.InvalidArgument
		}
		copy(cfg.Signers[j:], cfg.Signers[j+1:])
		cfg.Signers = cfg.Signers[:len(cfg.Signers)-1]
	}
	return accountutils.StoreWithRentExemptRealloc(c, account, igp, owner, system)
}

// setIgpMinIssuedAt is SetIgpMinIssuedAt (monotonic).
func setIgpMinIssuedAt(c solana.Context, minIssuedAt int64) uint64 {
	system, account, igp, owner, code := ownedIgp(c)
	if code != svm.Success {
		return code
	}
	if !igp.FeeConfig.Some || minIssuedAt < igp.FeeConfig.Value.MinIssuedAt {
		return svm.InvalidArgument
	}
	igp.FeeConfig.Value.MinIssuedAt = minIssuedAt
	return accountutils.StoreWithRentExemptRealloc(c, account, igp, owner, system)
}

// getIgpQuoteAccountMetas is GetIgpQuoteAccountMetas (simulation only): the
// PayForGas account metas, as SimulationReturnData<Vec<SerializableAccountMeta>>.
//
// Accounts:
// 0. `[]` The IGP account. Any further account is ExtraneousAccount.
func getIgpQuoteAccountMetas(c solana.Context, ix *Instruction) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
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
	programDataKey, _, code := svm.FindProgramAddress(c, ProgramDataPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	igpKey := svm.Key(c, igpInfo)

	metas := make([]accountmeta.SerializableAccountMeta, 0, 9)
	metas = append(metas,
		accountmeta.Readonly(svm.SystemProgramID, false),
		accountmeta.Writable(Pubkey{}, true), // payer placeholder
		accountmeta.Writable(programDataKey, false),
		accountmeta.Readonly(Pubkey{}, true),  // unique gas payment placeholder
		accountmeta.Writable(Pubkey{}, false), // gas payment PDA placeholder
		accountmeta.Writable(igpKey, false),
	)
	if igp.FeeConfig.Some {
		authority, _, code := svm.FindProgramAddress(c, QuoteAuthorityPDASeeds, ix.Sender)
		if code != svm.Success {
			return code
		}
		metas = append(metas, accountmeta.Readonly(authority, true), accountmeta.Readonly(ix.Sender, false))
		if ix.ScopedSalt.Some {
			key, _, code := svm.FindProgramAddress(c, TransientQuotePDASeeds(&igpKey, &ix.ScopedSalt.Value), programID)
			if code != svm.Success {
				return code
			}
			metas = append(metas, accountmeta.Writable(key, false))
		} else {
			var mint Pubkey
			domainLE := u32LE(ix.DestinationDomain)
			wildcardLE := u32LE(WildcardDomain)
			for level := 0; level < 3; level++ {
				domain, sender := domainLE, &ix.Sender
				if level == 1 {
					sender = &WildcardSender
				} else if level == 2 {
					domain = wildcardLE
				}
				key, _, code := svm.FindProgramAddress(c, StandingQuotePDASeeds(&igpKey, &mint, domain, sender), programID)
				if code != svm.Success {
					return code
				}
				metas = append(metas, accountmeta.Readonly(key, false))
			}
		}
	}
	return solana.SetReturnData(c, accountmeta.EncodeMetasReturnData(metas))
}
