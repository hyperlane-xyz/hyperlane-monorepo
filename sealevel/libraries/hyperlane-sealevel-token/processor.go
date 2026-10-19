package tokenlib

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	recipient "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/message-recipient-interface"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// ErrCPIMetaLimit is goSVM's invalid-metas code (2006), returned when a CPI
// would need more than the 16 account metas goSVM's Invoke encodes. Rust has
// no such limit: this is a goSVM gap, never a Rust error.
const ErrCPIMetaLimit uint64 = 2006

// maxCPIMetas is goSVM's per-CPI account meta limit.
const maxCPIMetas = 16

// MaxFeeVariableAccounts and MaxIgpVariableAccounts bound the variable
// account runs of transfer_remote.
const (
	MaxFeeVariableAccounts = 15
	MaxIgpVariableAccounts = 15
)

// Fee is transfer_in's Option<(fee_amount, beneficiary)>.
type Fee struct {
	Some        bool
	Amount      uint64
	Beneficiary uint64
}

// Plugin is HyperlaneSealevelTokenPlugin, implemented on *T (the plugin
// data). Hooks take the token's decimals rather than the whole token.
type Plugin[T any] interface {
	PluginData[T]
	// Initialize consumes the plugin's init accounts and fills the receiver.
	Initialize(c solana.Context, programID *svm.Pubkey, it *svm.AccountIter, systemProgram, tokenAccount, payer uint64) uint64
	// TransferIn moves amount in from sender and, when fee.Some, the fee to
	// the beneficiary account.
	TransferIn(c solana.Context, programID *svm.Pubkey, decimals uint8, sender uint64, it *svm.AccountIter, amount uint64, fee Fee) uint64
	// FeeBeneficiary is fee_beneficiary_pubkey.
	FeeBeneficiary(c solana.Context, beneficiaryOwner *svm.Pubkey) (svm.Pubkey, uint64)
	// TransferOut moves amount out to recipient.
	TransferOut(c solana.Context, programID *svm.Pubkey, decimals uint8, systemProgram, recipient uint64, it *svm.AccountIter, amount uint64) uint64
	// TransferOutAccountMetas returns TransferOut's metas and whether the
	// recipient wallet must be writable.
	TransferOutAccountMetas(c solana.Context, programID *svm.Pubkey, recipient *hyperlanecore.H256) ([]accountmeta.SerializableAccountMeta, bool, uint64)
}

func next(it *svm.AccountIter) (uint64, uint64) { return it.Next() }

// addMeta appends a meta, failing with ErrCPIMetaLimit past goSVM's 16.
func addMeta(m *svm.Metas, index uint64, writable, signer bool) bool {
	if len(m.Bytes()) >= maxCPIMetas*9 {
		return false
	}
	m.Add(index, writable, signer)
	return true
}

// Initialize is HyperlaneSealevelToken::initialize.
//
// Accounts: 0 system program, 1 token PDA (w), 2 dispatch authority (w),
// 3 payer and owner (s), then the plugin's.
func Initialize[T any, P Plugin[T]](c solana.Context, init *Init) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)

	systemProgram, code := next(&it)
	if code != svm.Success {
		return code
	}
	if !KeyEq(c, systemProgram, &svm.SystemProgramID) {
		return svm.IncorrectProgramID
	}

	tokenAccount, code := next(&it)
	if code != svm.Success {
		return code
	}
	tokenKey, tokenSeeds, code := svm.FindProgramAddressSeeds(c, TokenPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if !KeyEq(c, tokenAccount, &tokenKey) {
		return svm.IncorrectProgramID
	}
	if !svm.DataIsEmpty(c, tokenAccount) || !OwnerEq(c, tokenAccount, &svm.SystemProgramID) {
		return svm.AccountAlreadyInitialized
	}

	dispatchAuthority, code := next(&it)
	if code != svm.Success {
		return code
	}
	dispatchKey, dispatchSeeds, code := svm.FindProgramAddressSeeds(c, MailboxDispatchAuthorityPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if !KeyEq(c, dispatchAuthority, &dispatchKey) {
		return svm.IncorrectProgramID
	}
	if !svm.DataIsEmpty(c, dispatchAuthority) || !OwnerEq(c, dispatchAuthority, &svm.SystemProgramID) {
		return svm.AccountAlreadyInitialized
	}

	payer, code := next(&it)
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, payer) {
		return svm.MissingRequiredSignature
	}

	processAuthority, _, code := svm.FindProgramAddress(c, MailboxProcessAuthorityPDASeeds(&programID), init.Mailbox)
	if code != svm.Success {
		return code
	}

	tok := new(HyperlaneToken[T, P])
	if code := P(&tok.PluginData).Initialize(c, &programID, &it, systemProgram, tokenAccount, payer); code != svm.Success {
		return code
	}
	if it.HasMore() {
		return ErrExtraneousAccount
	}

	tok.Bump = tokenSeeds.Bump()
	tok.Mailbox = init.Mailbox
	tok.MailboxProcessAuthority = processAuthority
	tok.DispatchAuthorityBump = dispatchSeeds.Bump()
	tok.Owner = borsh.SomeOf(svm.Key(c, payer))
	tok.InterchainSecurityModule = init.InterchainSecurityModule
	tok.InterchainGasPaymaster = init.InterchainGasPaymaster
	tok.Decimals = init.Decimals
	tok.RemoteDecimals = init.RemoteDecimals

	if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(tok), programID, systemProgram, tokenAccount, &tokenSeeds); code != svm.Success {
		return code
	}
	if code := accountutils.CreatePDAAccount(c, payer, 0, programID, systemProgram, dispatchAuthority, &dispatchSeeds); code != svm.Success {
		return code
	}
	return accountutils.Store(c, tokenAccount, tok, false)
}

// TransferRemoteWithMemo is HyperlaneSealevelToken::transfer_remote_with_memo
// (TransferRemote passes an empty memo).
//
// Accounts: 0 system program, 1 spl_noop, 2 token PDA, then
// TransferRemoteTo's.
func TransferRemoteWithMemo[T any, P Plugin[T]](c solana.Context, xfer *TransferRemote, memo []byte) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)

	systemProgram, code := next(&it)
	if code != svm.Success {
		return code
	}
	if !KeyEq(c, systemProgram, &svm.SystemProgramID) {
		return svm.InvalidArgument
	}
	noop, code := next(&it)
	if code != svm.Success {
		return code
	}
	if !KeyEq(c, noop, &accountutils.SPLNoopProgramID) {
		return svm.InvalidArgument
	}
	tokenAccount, code := next(&it)
	if code != svm.Success {
		return code
	}
	tok := new(HyperlaneToken[T, P])
	if code := VerifyAccountAndFetch(c, &programID, tokenAccount, tok); code != svm.Success {
		return code
	}
	router, ok := cc.Router(tok.RemoteRouters, xfer.DestinationDomain)
	if !ok {
		return svm.InvalidArgument
	}
	remote, code := TransferRemoteTo(c, &programID, tok, systemProgram, noop, &it, xfer.DestinationDomain, &xfer.Recipient, &router, xfer.AmountOrID, memo)
	if code != svm.Success {
		return code
	}
	m := svm.NewMsg("Warp route transfer completed to destination: ")
	m.U32(xfer.DestinationDomain)
	m.Str(", recipient: ")
	m.H256Short((*[32]byte)(&xfer.Recipient))
	m.Str(", remote_amount: ")
	m.U256((*[4]uint64)(&remote))
	m.Emit(c)
	return svm.Success
}

// igpPayment holds the deferred PayForGas CPI.
type igpPayment struct {
	program            uint64
	metas              *svm.Metas
	quoted             bool
	quoteAuthorityBump uint8
}

// TransferRemoteTo is HyperlaneSealevelToken::transfer_remote_to: validate the
// mailbox accounts, quote and collect any fee, transfer in, dispatch, and pay
// the IGP. Returns the remote amount.
//
// Accounts from it: mailbox, outbox (w), dispatch authority, sender (s),
// unique message (s), dispatched message PDA (w); if fee_config: fee program,
// fee account, variable quote accounts, fee beneficiary; if IGP: IGP program,
// IGP program data (w), gas payment PDA (w), variable quote accounts,
// configured IGP, [inner IGP]; then the plugin's transfer_in accounts.
func TransferRemoteTo[T any, P Plugin[T]](c solana.Context, programID *svm.Pubkey, tok *HyperlaneToken[T, P], systemProgram, noop uint64, it *svm.AccountIter, destination uint32, recipient, router *hyperlanecore.H256, amountOrID borsh.U256, memo []byte) (borsh.U256, uint64) {
	var zero borsh.U256
	mailbox, code := next(it)
	if code != svm.Success {
		return zero, code
	}
	if !KeyEq(c, mailbox, &tok.Mailbox) {
		return zero, svm.IncorrectProgramID
	}
	outbox, code := next(it)
	if code != svm.Success {
		return zero, code
	}
	dispatchAuthority, code := next(it)
	if code != svm.Success {
		return zero, code
	}
	dispatchKey, code := DispatchAuthorityPDA.Address(c, tok.DispatchAuthorityBump, programID)
	if code != svm.Success {
		return zero, code
	}
	if !KeyEq(c, dispatchAuthority, &dispatchKey) {
		return zero, svm.InvalidArgument
	}
	sender, code := next(it)
	if code != svm.Success {
		return zero, code
	}
	if !solana.Signer(c, sender) {
		return zero, svm.MissingRequiredSignature
	}
	uniqueMessage, code := next(it)
	if code != svm.Success {
		return zero, code
	}
	dispatchedMessage, code := next(it)
	if code != svm.Success {
		return zero, code
	}

	if amountOrID[1] != 0 || amountOrID[2] != 0 || amountOrID[3] != 0 {
		return zero, ErrIntegerOverflow
	}
	localAmount := amountOrID[0]

	var fee Fee
	if tok.FeeConfig.Some {
		fee, code = ParseFeeSectionAndQuote(c, tok, sender, it, destination, recipient, localAmount, router)
		if code != svm.Success {
			return zero, code
		}
	}

	var igp *igpPayment
	if tok.InterchainGasPaymaster.Some {
		igp, code = parseIGPAccounts(c, programID, &tok.InterchainGasPaymaster.Value, systemProgram, sender, uniqueMessage, it)
		if code != svm.Success {
			return zero, code
		}
	}

	remoteAmount, code := ConvertAndTransferIn(c, programID, tok, sender, it, amountOrID, fee)
	if code != svm.Success {
		return zero, code
	}
	if it.HasMore() {
		return zero, ErrExtraneousAccount
	}

	message := hyperlanecore.TokenMessage{Recipient: *recipient, AmountOrID: remoteAmount, Metadata: memo}
	data := cc.OutboxDispatchData(*programID, destination, *router, message.Encode())
	metas := new(svm.Metas)
	metas.Add(outbox, true, false)
	metas.Add(dispatchAuthority, false, true)
	metas.Add(systemProgram, false, false)
	metas.Add(noop, false, false)
	metas.Add(sender, true, true)
	metas.Add(uniqueMessage, false, true)
	metas.Add(dispatchedMessage, true, false)
	if code := InvokeSigned(c, mailbox, metas, data, DispatchAuthorityPDA.Signer(tok.DispatchAuthorityBump)); code != svm.Success {
		return zero, code
	}

	var messageID hyperlanecore.H256
	var setter svm.Pubkey
	n := solana.GetReturnData(c, messageID[:], setter[:])
	if n == 0 || setter != tok.Mailbox {
		return zero, svm.InvalidArgument
	}

	if igp != nil {
		if n != 32 {
			return zero, svm.InvalidArgument
		}
		gas, ok := cc.DestinationGasFor(tok.DestinationGas, destination)
		if !ok {
			return zero, svm.InvalidArgument
		}
		pay := cc.PayForGasData(messageID, destination, gas)
		var signer []byte
		if igp.quoted {
			signer = IgpQuoteAuthorityPDA.Signer(igp.quoteAuthorityBump)
		}
		if code := InvokeSigned(c, igp.program, igp.metas, pay, signer); code != svm.Success {
			return zero, code
		}
	}
	return remoteAmount, svm.Success
}

// parseIGPAccounts consumes the IGP section and builds the PayForGas metas:
// system, sender (w,s), program data (w), unique message (s), payment PDA
// (w), the paying IGP (w), then for the quoted flow the quote authority (s),
// quoted sender and quote PDAs, and for an overhead IGP the configured IGP.
func parseIGPAccounts(c solana.Context, programID *svm.Pubkey, cfg *cc.IGPConfig, systemProgram, sender, uniqueMessage uint64, it *svm.AccountIter) (*igpPayment, uint64) {
	igpProgram, code := next(it)
	if code != svm.Success {
		return nil, code
	}
	if !KeyEq(c, igpProgram, &cfg.Program) {
		return nil, svm.InvalidArgument
	}
	programData, code := next(it)
	if code != svm.Success {
		return nil, code
	}
	paymentPDA, code := next(it)
	if code != svm.Success {
		return nil, code
	}

	// Variable accounts before the configured IGP (TERMINAL).
	pre := make([]uint64, 0, MaxIgpVariableAccounts)
	var configured uint64
	for {
		i, code := next(it)
		if code != svm.Success {
			return nil, code
		}
		if KeyEq(c, i, &cfg.Type.Key) {
			configured = i
			break
		}
		if len(pre) >= MaxIgpVariableAccounts {
			return nil, ErrExtraneousAccount
		}
		pre = append(pre, i)
	}

	overhead := cfg.Type.Kind == cc.IGPTypeOverheadIgp
	paying := configured
	if overhead {
		inner, code := next(it)
		if code != svm.Success {
			return nil, code
		}
		paying = inner
	}

	quoted, code := IgpQuoted(solana.Data(c, paying))
	if code != svm.Success {
		return nil, code
	}

	p := new(igpPayment)
	p.program = igpProgram
	p.metas = new(svm.Metas)
	m := p.metas
	m.Add(systemProgram, false, false)
	m.Add(sender, true, true)
	m.Add(programData, true, false)
	m.Add(uniqueMessage, false, true)
	m.Add(paymentPDA, true, false)
	m.Add(paying, true, false)

	if quoted {
		authorityKey, authorityBump, code := IgpQuoteAuthorityPDA.Find(c, programID)
		if code != svm.Success {
			return nil, code
		}
		if len(pre) < 1 {
			return nil, ErrIgpNewFlowRequired
		}
		if !KeyEq(c, pre[0], &authorityKey) {
			return nil, svm.InvalidArgument
		}
		if len(pre) < 2 {
			return nil, ErrIgpNewFlowRequired
		}
		if !KeyEq(c, pre[1], programID) {
			return nil, svm.InvalidArgument
		}
		for j := range pre {
			ok := true
			switch j {
			case 0:
				ok = addMeta(m, pre[0], false, true)
			case 1:
				ok = addMeta(m, pre[1], false, false)
			default:
				ok = addMeta(m, pre[j], solana.Writable(c, pre[j]), solana.Signer(c, pre[j]))
			}
			if !ok {
				return nil, ErrCPIMetaLimit
			}
		}
		p.quoted = true
		p.quoteAuthorityBump = authorityBump
	} else if len(pre) != 0 {
		return nil, svm.InvalidArgument
	}
	if overhead && !addMeta(m, configured, false, false) {
		return nil, ErrCPIMetaLimit
	}
	return p, svm.Success
}

// ParseFeeSectionAndQuote is parse_fee_section_and_quote: consume the fee
// program, fee account and variable accounts up to the beneficiary, CPI
// QuoteFee and read its u64 return data. Requires tok.FeeConfig.Some.
func ParseFeeSectionAndQuote[T any, P Plugin[T]](c solana.Context, tok *HyperlaneToken[T, P], sender uint64, it *svm.AccountIter, destination uint32, recipient *hyperlanecore.H256, amount uint64, targetRouter *hyperlanecore.H256) (Fee, uint64) {
	var fee Fee
	if !tok.FeeConfig.Some {
		return fee, svm.InvalidArgument
	}
	cfg := &tok.FeeConfig.Value

	feeProgram, code := next(it)
	if code != svm.Success {
		return fee, code
	}
	if !KeyEq(c, feeProgram, &cfg.FeeProgram) {
		return fee, svm.InvalidArgument
	}
	if !solana.Executable(c, feeProgram) {
		return fee, svm.InvalidAccountData
	}
	feeAccount, code := next(it)
	if code != svm.Success {
		return fee, code
	}
	if !KeyEq(c, feeAccount, &cfg.FeeAccount) {
		return fee, svm.InvalidArgument
	}
	if !OwnerEq(c, feeAccount, &cfg.FeeProgram) {
		return fee, ErrFeeAccountOwnerMismatch
	}
	var prefix FeeAccountPrefix
	if code := ParseFeeAccountPrefix(solana.Data(c, feeAccount), &prefix); code != svm.Success {
		return fee, code
	}
	expected, code := P(&tok.PluginData).FeeBeneficiary(c, &prefix.Beneficiary)
	if code != svm.Success {
		return fee, code
	}

	metas := new(svm.Metas)
	metas.Add(feeAccount, false, false)
	metas.Add(sender, true, true)
	variable := 0
	overLimit := false
	var beneficiary uint64
	for {
		i, code := next(it)
		if code != svm.Success {
			return fee, code
		}
		if KeyEq(c, i, &expected) {
			beneficiary = i
			break
		}
		variable++
		if variable > MaxFeeVariableAccounts {
			return fee, ErrFeeBeneficiaryNotFound
		}
		if !addMeta(metas, i, solana.Writable(c, i), solana.Signer(c, i)) {
			overLimit = true
		}
	}
	if overLimit {
		return fee, ErrCPIMetaLimit
	}

	data := QuoteFeeData(destination, recipient, amount, targetRouter)
	if code := svm.Invoke(c, feeProgram, metas, data, nil); code != svm.Success {
		return fee, code
	}
	var out [8]byte
	var setter svm.Pubkey
	n := solana.GetReturnData(c, out[:], setter[:])
	if n == 0 || setter != cfg.FeeProgram || n != 8 {
		return fee, ErrInvalidFeeReturnData
	}
	amountOut := uint64(0)
	for j := 0; j < 8; j++ {
		amountOut |= uint64(out[j]) << (8 * uint64(j))
	}
	fee.Some = true
	fee.Amount = amountOut
	fee.Beneficiary = beneficiary
	return fee, svm.Success
}

// ConvertAndTransferIn is convert_and_transfer_in: convert to remote decimals,
// then run the plugin's transfer_in.
func ConvertAndTransferIn[T any, P Plugin[T]](c solana.Context, programID *svm.Pubkey, tok *HyperlaneToken[T, P], sender uint64, it *svm.AccountIter, amountOrID borsh.U256, fee Fee) (borsh.U256, uint64) {
	if amountOrID[1] != 0 || amountOrID[2] != 0 || amountOrID[3] != 0 {
		return borsh.U256{}, ErrIntegerOverflow
	}
	local := amountOrID[0]
	remote, code := tok.LocalAmountToRemoteAmount(local)
	if code != svm.Success {
		return remote, code
	}
	if code := P(&tok.PluginData).TransferIn(c, programID, tok.Decimals, sender, it, local, fee); code != svm.Success {
		return remote, code
	}
	return remote, svm.Success
}

// TransferFromRemote is transfer_from_remote (Handle).
//
// Accounts: 0 mailbox process authority (s), 1 system program, 2 token PDA,
// 3 recipient wallet, then the plugin's.
func TransferFromRemote[T any, P Plugin[T]](c solana.Context, h *recipient.HandleInstruction) uint64 {
	message, ok := hyperlanecore.DecodeTokenMessage(h.Message)
	if !ok {
		return ErrMessageDecodeError
	}
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)

	processAuthority, code := next(&it)
	if code != svm.Success {
		return code
	}
	systemProgram, code := next(&it)
	if code != svm.Success {
		return code
	}
	if !KeyEq(c, systemProgram, &svm.SystemProgramID) {
		return svm.InvalidArgument
	}
	tokenAccount, code := next(&it)
	if code != svm.Success {
		return code
	}
	tok := new(HyperlaneToken[T, P])
	if code := VerifyAccountAndFetch(c, &programID, tokenAccount, tok); code != svm.Success {
		return code
	}
	recipient, code := next(&it)
	if code != svm.Success {
		return code
	}
	if !KeyEq(c, recipient, &message.Recipient) {
		return svm.InvalidArgument
	}
	if code := cc.EnsureValidRouterMessage(c, &tok.MailboxProcessAuthority, processAuthority, tok.RemoteRouters, h.Origin, &h.Sender); code != svm.Success {
		return code
	}
	local, code := tok.RemoteAmountToLocalAmount(message.AmountOrID)
	if code != svm.Success {
		return code
	}
	if code := P(&tok.PluginData).TransferOut(c, &programID, tok.Decimals, systemProgram, recipient, &it, local); code != svm.Success {
		return code
	}
	if it.HasMore() {
		return ErrExtraneousAccount
	}
	m := svm.NewMsg("Warp route transfer completed from origin: ")
	m.U32(h.Origin)
	m.Str(", recipient: ")
	m.Key(solana.Key(c, recipient))
	m.Str(", remote_amount: ")
	m.U256((*[4]uint64)(&message.AmountOrID))
	m.Emit(c)
	return svm.Success
}

// TransferFromRemoteAccountMetas is transfer_from_remote_account_metas
// (HandleAccountMetas).
//
// Accounts: 0 token PDA.
func TransferFromRemoteAccountMetas[T any, P Plugin[T]](c solana.Context, h *recipient.HandleInstruction) uint64 {
	message, ok := hyperlanecore.DecodeTokenMessage(h.Message)
	if !ok {
		return ErrMessageDecodeError
	}
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	tokenAccount, code := next(&it)
	if code != svm.Success {
		return code
	}
	tok := new(HyperlaneToken[T, P])
	if code := VerifyAccountAndFetch(c, &programID, tokenAccount, tok); code != svm.Success {
		return code
	}
	pluginMetas, writableRecipient, code := P(&tok.PluginData).TransferOutAccountMetas(c, &programID, &message.Recipient)
	if code != svm.Success {
		return code
	}
	// SimulationReturnData<Vec<SerializableAccountMeta>>, written in place:
	// system program, token PDA, recipient, then the plugin's metas.
	w := borsh.NewWriter(4 + 34*(3+len(pluginMetas)) + 1)
	w.Len32(3 + len(pluginMetas))
	writeMeta(&w, &svm.SystemProgramID, false, false)
	tokenKey := svm.Key(c, tokenAccount)
	writeMeta(&w, &tokenKey, false, false)
	writeMeta(&w, &message.Recipient, false, writableRecipient)
	for i := range pluginMetas {
		m := &pluginMetas[i]
		writeMeta(&w, &m.Pubkey, m.IsSigner, m.IsWritable)
	}
	accountmeta.EndSimulationReturnData(&w)
	return solana.SetReturnData(c, w.Bytes())
}

func writeMeta(w *borsh.Writer, key *[32]byte, signer, writable bool) {
	w.Raw(key[:])
	w.Bool(signer)
	w.Bool(writable)
}

// SetMeta fills a plugin account meta in place (avoids copying the struct).
func SetMeta(m *accountmeta.SerializableAccountMeta, key *svm.Pubkey, signer, writable bool) {
	m.Pubkey = *key
	m.IsSigner = signer
	m.IsWritable = writable
}

// loadForOwnerUpdate takes [system program (when withSystem)], token PDA and
// owner, verifying the token and the system program like the Rust setters.
func loadForOwnerUpdate[T any, P Plugin[T]](c solana.Context, programID *svm.Pubkey, it *svm.AccountIter, tok *HyperlaneToken[T, P], withSystem bool) (systemProgram, tokenAccount, owner uint64, code uint64) {
	if withSystem {
		systemProgram, code = next(it)
		if code != svm.Success {
			return
		}
		if !KeyEq(c, systemProgram, &svm.SystemProgramID) {
			code = svm.InvalidArgument
			return
		}
	}
	tokenAccount, code = next(it)
	if code != svm.Success {
		return
	}
	if code = VerifyAccountAndFetch(c, programID, tokenAccount, tok); code != svm.Success {
		return
	}
	owner, code = next(it)
	return
}

// EnrollRemoteRouters is enroll_remote_router / enroll_remote_routers.
//
// Accounts: 0 system program, 1 token PDA (w), 2 owner (s).
func EnrollRemoteRouters[T any, P Plugin[T]](c solana.Context, configs []cc.RemoteRouterConfig) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	tok := new(HyperlaneToken[T, P])
	systemProgram, tokenAccount, owner, code := loadForOwnerUpdate(c, &programID, &it, tok, true)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, tok.Owner, owner); code != svm.Success {
		return code
	}
	tok.RemoteRouters = cc.EnrollRemoteRouters(c, tok.RemoteRouters, configs)
	return accountutils.StoreWithRentExemptRealloc(c, tokenAccount, tok, owner, systemProgram)
}

// SetDestinationGasConfigs is set_destination_gas_configs.
//
// Accounts: 0 system program, 1 token PDA (w), 2 owner (s).
func SetDestinationGasConfigs[T any, P Plugin[T]](c solana.Context, configs []cc.GasRouterConfig) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	tok := new(HyperlaneToken[T, P])
	systemProgram, tokenAccount, owner, code := loadForOwnerUpdate(c, &programID, &it, tok, true)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, tok.Owner, owner); code != svm.Success {
		return code
	}
	tok.DestinationGas = cc.SetDestinationGasConfigs(c, tok.DestinationGas, configs)
	return accountutils.StoreWithRentExemptRealloc(c, tokenAccount, tok, owner, systemProgram)
}

// TransferOwnership is transfer_ownership.
//
// Accounts: 0 token PDA (w), 1 owner (s).
func TransferOwnership[T any, P Plugin[T]](c solana.Context, newOwner borsh.Option[svm.Pubkey]) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	tok := new(HyperlaneToken[T, P])
	_, tokenAccount, owner, code := loadForOwnerUpdate(c, &programID, &it, tok, false)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.TransferOwnership(c, &tok.Owner, owner, newOwner); code != svm.Success {
		return code
	}
	return accountutils.Store(c, tokenAccount, tok, false)
}

// SetInterchainSecurityModule is set_interchain_security_module.
//
// Accounts: 0 token PDA (w), 1 owner (s).
func SetInterchainSecurityModule[T any, P Plugin[T]](c solana.Context, ism borsh.Option[svm.Pubkey]) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	tok := new(HyperlaneToken[T, P])
	_, tokenAccount, owner, code := loadForOwnerUpdate(c, &programID, &it, tok, false)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, tok.Owner, owner); code != svm.Success {
		return code
	}
	tok.InterchainSecurityModule = ism
	return accountutils.Store(c, tokenAccount, tok, false)
}

// SetInterchainGasPaymaster is set_interchain_gas_paymaster.
//
// Accounts: 0 token PDA (w), 1 owner (s).
func SetInterchainGasPaymaster[T any, P Plugin[T]](c solana.Context, igp *borsh.Option[cc.IGPConfig]) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	tok := new(HyperlaneToken[T, P])
	_, tokenAccount, owner, code := loadForOwnerUpdate(c, &programID, &it, tok, false)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, tok.Owner, owner); code != svm.Success {
		return code
	}
	tok.InterchainGasPaymaster = *igp
	return accountutils.Store(c, tokenAccount, tok, false)
}

// InterchainSecurityModule returns borsh(Option<Pubkey>) of the ISM.
//
// Accounts: 0 token PDA.
func InterchainSecurityModule[T any, P Plugin[T]](c solana.Context) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	tokenAccount, code := next(&it)
	if code != svm.Success {
		return code
	}
	tok := new(HyperlaneToken[T, P])
	if code := VerifyAccountAndFetch(c, &programID, tokenAccount, tok); code != svm.Success {
		return code
	}
	return solana.SetReturnData(c, cc.ISMReturnData(tok.InterchainSecurityModule))
}

// InterchainSecurityModuleAccountMetas returns [token PDA] as the ISM getter's
// accounts. No accounts.
func InterchainSecurityModuleAccountMetas(c solana.Context) uint64 {
	programID := svm.ProgramID(c)
	key, _, code := TokenPDA.Find(c, &programID)
	if code != svm.Success {
		return code
	}
	metas := make([]accountmeta.SerializableAccountMeta, 1)
	metas[0] = accountmeta.Readonly(key, false)
	return solana.SetReturnData(c, accountmeta.EncodeMetasReturnData(metas))
}

// SetFeeConfig is set_fee_config.
//
// Accounts: 0 system program, 1 token PDA (w), 2 owner (s); when Some:
// 3 fee program, 4 fee account, 5 mailbox outbox.
func SetFeeConfig[T any, P Plugin[T]](c solana.Context, feeConfig *borsh.Option[FeeConfig]) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	tok := new(HyperlaneToken[T, P])
	systemProgram, tokenAccount, owner, code := loadForOwnerUpdate(c, &programID, &it, tok, true)
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, tok.Owner, owner); code != svm.Success {
		return code
	}
	if feeConfig.Some {
		cfg := &feeConfig.Value
		feeProgram, code := next(&it)
		if code != svm.Success {
			return code
		}
		if !KeyEq(c, feeProgram, &cfg.FeeProgram) || !solana.Executable(c, feeProgram) {
			return svm.InvalidArgument
		}
		feeAccount, code := next(&it)
		if code != svm.Success {
			return code
		}
		if !KeyEq(c, feeAccount, &cfg.FeeAccount) || !OwnerEq(c, feeAccount, &cfg.FeeProgram) {
			return svm.InvalidArgument
		}
		var prefix FeeAccountPrefix
		if code := ParseFeeAccountPrefix(solana.Data(c, feeAccount), &prefix); code != svm.Success {
			return code
		}
		outbox, code := next(&it)
		if code != svm.Success {
			return code
		}
		localDomain, code := VerifyOutboxAndFetchLocalDomain(c, &tok.Mailbox, outbox)
		if code != svm.Success {
			return code
		}
		if prefix.DomainID != localDomain {
			return ErrInvalidFeeAccountDomain
		}
	}
	if code := accountutils.EnsureNoExtraneousAccounts(&it); code != svm.Success {
		return code
	}
	m := svm.NewMsg("Set fee config: OptionalDiscriminatedData(")
	writeFeeConfigDebug(&m, &tok.FeeConfig)
	m.Str(") -> ")
	writeFeeConfigDebug(&m, feeConfig)
	tok.FeeConfig = *feeConfig
	if code := accountutils.StoreWithRentExemptRealloc(c, tokenAccount, tok, owner, systemProgram); code != svm.Success {
		return code
	}
	m.Emit(c)
	return svm.Success
}

// writeFeeConfigDebug appends {:?} of an Option<FeeConfig>.
func writeFeeConfigDebug(m *svm.Msg, o *borsh.Option[FeeConfig]) {
	if !o.Some {
		m.Str("None")
		return
	}
	m.Str("Some(FeeConfig { fee_program: ")
	m.Pubkey(&o.Value.FeeProgram)
	m.Str(", fee_account: ")
	m.Pubkey(&o.Value.FeeAccount)
	m.Str(" })")
}
