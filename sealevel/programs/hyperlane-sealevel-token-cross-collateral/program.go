// Package tokencrosscollateral ports
// rust/sealevel/programs/hyperlane-sealevel-token-cross-collateral: a
// collateral warp route that can also send to and receive from several
// enrolled routers per domain, including same-chain CC programs via CPI
// (HandleLocal).
package tokencrosscollateral

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token/collateral"
	recipient "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/message-recipient-interface"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Token is the program's HyperlaneToken<CollateralPlugin>.
type Token = collateral.Token

type plugin = collateral.CollateralPlugin

// Process is process_instruction: GetProgramVersion, then the CC
// instructions, then the message recipient interface, then the token
// instructions.
func Process(c solana.Context) uint64 {
	data := solana.Instruction(c)
	if packageversioned.IsGetProgramVersion(data) {
		return packageversioned.ProcessGetProgramVersion(c)
	}

	ccix := new(Instruction)
	if DecodeInstruction(data, ccix) == svm.Success {
		switch ccix.Kind {
		case KindSetCrossCollateralRouters:
			return setCrossCollateralRouters(c, ccix.Updates)
		case KindTransferRemoteTo:
			return transferRemoteTo(c, &ccix.Transfer)
		case KindHandleLocal:
			return handleLocal(c, &ccix.Handle)
		case KindHandleLocalAccountMetas:
			return handleLocalAccountMetas(c, &ccix.Handle)
		}
	}

	if rix, code := recipient.Decode(data); code == svm.Success {
		switch rix.Kind {
		case recipient.KindInterchainSecurityModule:
			return tokenlib.InterchainSecurityModule[plugin](c)
		case recipient.KindInterchainSecurityModuleAccountMetas:
			return tokenlib.InterchainSecurityModuleAccountMetas(c)
		case recipient.KindHandle:
			return transferFromRemote(c, &rix.Handle)
		case recipient.KindHandleAccountMetas:
			return transferFromRemoteAccountMetas(c, &rix.Handle)
		}
	}

	ix := new(tokenlib.Instruction)
	if code := tokenlib.DecodeInstruction(data, ix); code != svm.Success {
		return code
	}
	// Like Rust, log any handler error (msg!("{}", err)) before returning it.
	return svm.LogError(c, processToken(c, ix))
}

func processToken(c solana.Context, ix *tokenlib.Instruction) uint64 {
	switch ix.Kind {
	case tokenlib.KindInit:
		return initialize(c, &ix.Init)
	case tokenlib.KindTransferRemote:
		return tokenlib.TransferRemoteWithMemo[plugin](c, &ix.Transfer, nil)
	case tokenlib.KindTransferRemoteWithMemo:
		return tokenlib.TransferRemoteWithMemo[plugin](c, &ix.Transfer, ix.Memo)
	case tokenlib.KindEnrollRemoteRouter:
		configs := make([]cc.RemoteRouterConfig, 1)
		configs[0] = ix.RouterConfig
		return tokenlib.EnrollRemoteRouters[plugin](c, configs)
	case tokenlib.KindEnrollRemoteRouters:
		return tokenlib.EnrollRemoteRouters[plugin](c, ix.RouterConfigs)
	case tokenlib.KindSetDestinationGasConfigs:
		return tokenlib.SetDestinationGasConfigs[plugin](c, ix.GasConfigs)
	case tokenlib.KindTransferOwnership:
		return tokenlib.TransferOwnership[plugin](c, ix.Pubkey)
	case tokenlib.KindSetInterchainSecurityModule:
		return tokenlib.SetInterchainSecurityModule[plugin](c, ix.Pubkey)
	case tokenlib.KindSetInterchainGasPaymaster:
		return tokenlib.SetInterchainGasPaymaster[plugin](c, &ix.IGP)
	case tokenlib.KindSetFeeConfig:
		return tokenlib.SetFeeConfig[plugin](c, &ix.FeeConfig)
	}
	return svm.InvalidInstructionData
}

// expectUninitializedPDA is the Rust init sequence for one PDA: canonical
// key (InvalidArgument), then empty and system-owned
// (AccountAlreadyInitialized).
func expectUninitializedPDA(c solana.Context, i uint64, key *svm.Pubkey) uint64 {
	if !tokenlib.KeyEq(c, i, key) {
		return svm.InvalidArgument
	}
	if !svm.DataIsEmpty(c, i) || !tokenlib.OwnerEq(c, i, &svm.SystemProgramID) {
		return svm.AccountAlreadyInitialized
	}
	return svm.Success
}

// initialize is the CC Init: the base token init, CollateralPlugin
// initialize, then the CC state and CC dispatch authority PDAs.
//
// Accounts: 0 system program, 1 token PDA (w), 2 dispatch authority (w),
// 3 payer and owner (s), 4-8 the collateral plugin's (SPL token program,
// mint, Rent sysvar, escrow (w), ATA payer (w)), 9 CC state PDA (w), 10 CC
// dispatch authority (w), 11 mailbox outbox.
func initialize(c solana.Context, init *tokenlib.Init) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)

	systemProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, systemProgram, &svm.SystemProgramID) {
		return svm.IncorrectProgramID
	}

	tokenAccount, code := it.Next()
	if code != svm.Success {
		return code
	}
	tokenKey, tokenSeeds, code := svm.FindProgramAddressSeeds(c, tokenlib.TokenPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if code := expectUninitializedPDA(c, tokenAccount, &tokenKey); code != svm.Success {
		return code
	}

	dispatchAuthority, code := it.Next()
	if code != svm.Success {
		return code
	}
	dispatchKey, dispatchSeeds, code := svm.FindProgramAddressSeeds(c, tokenlib.MailboxDispatchAuthorityPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if code := expectUninitializedPDA(c, dispatchAuthority, &dispatchKey); code != svm.Success {
		return code
	}

	payer, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, payer) {
		return svm.MissingRequiredSignature
	}

	processAuthority, _, code := svm.FindProgramAddress(c, tokenlib.MailboxProcessAuthorityPDASeeds(&programID), init.Mailbox)
	if code != svm.Success {
		return code
	}

	tok := new(Token)
	if code := tok.PluginData.Initialize(c, &programID, &it, systemProgram, tokenAccount, payer); code != svm.Success {
		return code
	}

	stateAccount, code := it.Next()
	if code != svm.Success {
		return code
	}
	stateKey, stateSeeds, code := svm.FindProgramAddressSeeds(c, CrossCollateralPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if code := expectUninitializedPDA(c, stateAccount, &stateKey); code != svm.Success {
		return code
	}

	ccDispatchAuthority, code := it.Next()
	if code != svm.Success {
		return code
	}
	ccDispatchKey, ccDispatchSeeds, code := svm.FindProgramAddressSeeds(c, CrossCollateralDispatchAuthorityPDASeeds, programID)
	if code != svm.Success {
		return code
	}
	if code := expectUninitializedPDA(c, ccDispatchAuthority, &ccDispatchKey); code != svm.Success {
		return code
	}

	outbox, code := it.Next()
	if code != svm.Success {
		return code
	}
	localDomain, code := tokenlib.VerifyOutboxAndFetchLocalDomain(c, &init.Mailbox, outbox)
	if code != svm.Success {
		return code
	}

	if it.HasMore() {
		return tokenlib.ErrExtraneousAccount
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
	if code := accountutils.Store(c, tokenAccount, tok, false); code != svm.Success {
		return code
	}

	state := new(CrossCollateralState)
	state.Bump = stateSeeds.Bump()
	state.DispatchAuthorityBump = ccDispatchSeeds.Bump()
	state.LocalDomain = localDomain
	if code := accountutils.CreatePDAAccount(c, payer, accountutils.AccountDataSize(state), programID, systemProgram, stateAccount, &stateSeeds); code != svm.Success {
		return code
	}
	if code := accountutils.Store(c, stateAccount, state, false); code != svm.Success {
		return code
	}
	return accountutils.CreatePDAAccount(c, payer, 0, programID, systemProgram, ccDispatchAuthority, &ccDispatchSeeds)
}

// setCrossCollateralRouters applies CC router updates. Owner only.
//
// Accounts: 0 system program, 1 CC state PDA (w), 2 token PDA, 3 owner (s).
func setCrossCollateralRouters(c solana.Context, updates []CrossCollateralRouterUpdate) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)

	systemProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, systemProgram, &svm.SystemProgramID) {
		return svm.IncorrectProgramID
	}
	stateAccount, code := it.Next()
	if code != svm.Success {
		return code
	}
	state := new(CrossCollateralState)
	if code := VerifyStateAndFetch(c, &programID, stateAccount, state); code != svm.Success {
		return code
	}
	tokenAccount, code := it.Next()
	if code != svm.Success {
		return code
	}
	tok := new(Token)
	if code := tokenlib.VerifyAccountAndFetch(c, &programID, tokenAccount, tok); code != svm.Success {
		return code
	}
	owner, code := it.Next()
	if code != svm.Success {
		return code
	}
	if code := accesscontrol.EnsureOwnerSigner(c, tok.Owner, owner); code != svm.Success {
		return code
	}
	if it.HasMore() {
		return tokenlib.ErrExtraneousAccount
	}

	for i := range updates {
		u := &updates[i]
		var m svm.Msg
		switch {
		case u.Kind == UpdateAdd:
			state.AddRouter(u.Domain, &u.Router.Value)
			m = svm.NewMsg("Enrolled CC router ")
			m.H256((*[32]byte)(&u.Router.Value))
			m.Str(" for domain ")
		case u.Router.Some:
			state.RemoveRouter(u.Domain, &u.Router.Value)
			m = svm.NewMsg("Removed CC router ")
			m.H256((*[32]byte)(&u.Router.Value))
			m.Str(" from domain ")
		default:
			state.RemoveDomain(u.Domain)
			m = svm.NewMsg("Removed all CC routers for domain ")
		}
		m.U32(u.Domain)
		m.Emit(c)
	}
	return accountutils.StoreWithRentExemptRealloc(c, stateAccount, state, owner, systemProgram)
}

// transferRemoteTo sends to a specific authorized router: a same-chain CPI
// into the target's HandleLocal when the destination is the local domain,
// otherwise a mailbox dispatch.
//
// Accounts: 0 system program, 1 token PDA, 2 CC state PDA, then
// transferRemoteToRemote's or transferRemoteToLocal's.
func transferRemoteTo(c solana.Context, xfer *TransferRemoteTo) uint64 {
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)

	systemProgram, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, systemProgram, &svm.SystemProgramID) {
		return svm.IncorrectProgramID
	}
	tokenAccount, code := it.Next()
	if code != svm.Success {
		return code
	}
	tok := new(Token)
	if code := tokenlib.VerifyAccountAndFetch(c, &programID, tokenAccount, tok); code != svm.Success {
		return code
	}
	stateAccount, code := it.Next()
	if code != svm.Success {
		return code
	}
	state := new(CrossCollateralState)
	if code := VerifyStateAndFetch(c, &programID, stateAccount, state); code != svm.Success {
		return code
	}
	if !state.IsAuthorizedRouter(xfer.DestinationDomain, &xfer.TargetRouter, tok.RemoteRouters) {
		return ErrUnauthorizedRouter
	}
	if state.LocalDomain == xfer.DestinationDomain {
		return transferRemoteToLocal(c, &programID, tok, state, &it, xfer)
	}
	return transferRemoteToRemote(c, &programID, tok, systemProgram, &it, xfer)
}

// transferRemoteToRemote escrows and dispatches through the mailbox.
//
// Accounts from it: 3 SPL Noop, then tokenlib.TransferRemoteTo's (mailbox,
// outbox, dispatch authority, sender (s), unique message (s), dispatched
// message PDA (w), [fee section], [IGP section], plugin transfer_in).
func transferRemoteToRemote(c solana.Context, programID *svm.Pubkey, tok *Token, systemProgram uint64, it *svm.AccountIter, xfer *TransferRemoteTo) uint64 {
	noop, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, noop, &accountutils.SPLNoopProgramID) {
		return svm.InvalidArgument
	}
	remote, code := tokenlib.TransferRemoteTo(c, programID, tok, systemProgram, noop, it, xfer.DestinationDomain, &xfer.Recipient, &xfer.TargetRouter, xfer.AmountOrID, nil)
	if code != svm.Success {
		return code
	}
	m := svm.NewMsg("CC transfer_remote_to completed to destination: ")
	m.U32(xfer.DestinationDomain)
	m.Str(", target_router: ")
	m.H256((*[32]byte)(&xfer.TargetRouter))
	m.Str(", remote_amount: ")
	m.U256((*[4]uint64)(&remote))
	m.Emit(c)
	return svm.Success
}

// transferRemoteToLocal escrows and CPIs the target program's HandleLocal,
// signed by this program's CC dispatch authority.
//
// Accounts from it: 3 sender (s), 4 CC dispatch authority, 5 target program
// (x), [fee section], plugin transfer_in, then the target's HandleLocal
// accounts, passed through.
func transferRemoteToLocal(c solana.Context, programID *svm.Pubkey, tok *Token, state *CrossCollateralState, it *svm.AccountIter, xfer *TransferRemoteTo) uint64 {
	sender, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !solana.Signer(c, sender) {
		return svm.MissingRequiredSignature
	}

	ccDispatchAuthority, code := it.Next()
	if code != svm.Success {
		return code
	}
	expected, code := ccDispatchAuthorityPDA.Address(c, state.DispatchAuthorityBump, programID)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, ccDispatchAuthority, &expected) {
		return ErrInvalidDispatchAuthority
	}

	target, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, target, &xfer.TargetRouter) {
		return svm.InvalidArgument
	}
	if !solana.Executable(c, target) {
		return svm.InvalidAccountData
	}

	if xfer.AmountOrID[1] != 0 || xfer.AmountOrID[2] != 0 || xfer.AmountOrID[3] != 0 {
		return tokenlib.ErrIntegerOverflow
	}
	var fee tokenlib.Fee
	if tok.FeeConfig.Some {
		fee, code = tokenlib.ParseFeeSectionAndQuote(c, tok, sender, it, xfer.DestinationDomain, &xfer.Recipient, xfer.AmountOrID[0], &xfer.TargetRouter)
		if code != svm.Success {
			return code
		}
	}
	remoteAmount, code := tokenlib.ConvertAndTransferIn(c, programID, tok, sender, it, xfer.AmountOrID, fee)
	if code != svm.Success {
		return code
	}

	message := hyperlanecore.TokenMessage{Recipient: xfer.Recipient, AmountOrID: remoteAmount}
	ix := new(Instruction)
	ix.Kind = KindHandleLocal
	ix.Handle.SenderProgramID = *programID
	ix.Handle.Message = message.Encode()
	data := EncodeInstruction(ix)

	// The CC dispatch authority (signer), then every remaining account with
	// its writability. Rust has no meta limit; goSVM's Invoke rejects more
	// than 16 metas (2006).
	remaining := solana.Count(c) - it.Position()
	metas := make([]byte, 0, 9*(1+remaining))
	metas = appendMeta(metas, ccDispatchAuthority, false, true)
	for it.HasMore() {
		i, _ := it.Next()
		metas = appendMeta(metas, i, solana.Writable(c, i), false)
	}
	if code := solana.Invoke(c, target, metas, data, ccDispatchAuthorityPDA.Signer(state.DispatchAuthorityBump)); code != svm.Success {
		return code
	}
	m := svm.NewMsg("CC same-chain transfer completed to target: ")
	m.Pubkey((*[32]byte)(&xfer.TargetRouter))
	m.Str(", recipient: ")
	m.H256((*[32]byte)(&xfer.Recipient))
	m.Str(", remote_amount: ")
	m.U256((*[4]uint64)(&remoteAmount))
	m.Emit(c)
	return svm.Success
}

// appendMeta appends one goSVM CPI meta (index u64 LE, flags writable=1,
// signer=2).
func appendMeta(metas []byte, index uint64, writable, signer bool) []byte {
	for j := 0; j < 8; j++ {
		metas = append(metas, byte(index>>(8*uint64(j))))
	}
	flags := byte(0)
	if writable {
		flags |= 1
	}
	if signer {
		flags |= 2
	}
	return append(metas, flags)
}

// transferOut is the shared tail of Handle and HandleLocal: recipient wallet,
// decimals conversion, the plugin's transfer_out and the extraneous check.
// It logs prefix followed by ", recipient: <wallet>, remote_amount: <n>".
func transferOut(c solana.Context, programID *svm.Pubkey, tok *Token, systemProgram uint64, it *svm.AccountIter, message *hyperlanecore.TokenMessage, m *svm.Msg) uint64 {
	recipientWallet, code := it.Next()
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, recipientWallet, &message.Recipient) {
		return svm.InvalidArgument
	}
	local, code := tok.RemoteAmountToLocalAmount(message.AmountOrID)
	if code != svm.Success {
		return code
	}
	if code := tok.PluginData.TransferOut(c, programID, tok.Decimals, systemProgram, recipientWallet, it, local); code != svm.Success {
		return code
	}
	if it.HasMore() {
		return tokenlib.ErrExtraneousAccount
	}
	m.Str(", recipient: ")
	m.Key(solana.Key(c, recipientWallet))
	m.Str(", remote_amount: ")
	m.U256((*[4]uint64)(&message.AmountOrID))
	m.Emit(c)
	return svm.Success
}

// loadTokenAndState takes the system program (IncorrectProgramId), token PDA
// and CC state PDA.
func loadTokenAndState(c solana.Context, programID *svm.Pubkey, it *svm.AccountIter, tok *Token, state *CrossCollateralState) (uint64, uint64) {
	systemProgram, code := it.Next()
	if code != svm.Success {
		return 0, code
	}
	if !tokenlib.KeyEq(c, systemProgram, &svm.SystemProgramID) {
		return 0, svm.IncorrectProgramID
	}
	tokenAccount, code := it.Next()
	if code != svm.Success {
		return 0, code
	}
	if code := tokenlib.VerifyAccountAndFetch(c, programID, tokenAccount, tok); code != svm.Success {
		return 0, code
	}
	stateAccount, code := it.Next()
	if code != svm.Success {
		return 0, code
	}
	if code := VerifyStateAndFetch(c, programID, stateAccount, state); code != svm.Success {
		return 0, code
	}
	return systemProgram, svm.Success
}

// transferFromRemote is transfer_from_remote_cc (Handle): the base handle
// with CC-or-base router authorization, rejecting the local domain.
//
// Accounts: 0 mailbox process authority (s), 1 system program, 2 token PDA,
// 3 CC state PDA, 4 recipient wallet, then the plugin's transfer_out.
func transferFromRemote(c solana.Context, h *recipient.HandleInstruction) uint64 {
	message, ok := hyperlanecore.DecodeTokenMessage(h.Message)
	if !ok {
		return tokenlib.ErrMessageDecodeError
	}
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)

	processAuthority, code := it.Next()
	if code != svm.Success {
		return code
	}
	tok := new(Token)
	state := new(CrossCollateralState)
	systemProgram, code := loadTokenAndState(c, &programID, &it, tok, state)
	if code != svm.Success {
		return code
	}
	if code := cc.EnsureMailboxProcessAuthoritySigner(c, &tok.MailboxProcessAuthority, processAuthority); code != svm.Success {
		return code
	}
	if h.Origin == state.LocalDomain {
		return ErrSameDomainViaMailbox
	}
	if !state.IsAuthorizedRouter(h.Origin, &h.Sender, tok.RemoteRouters) {
		return ErrUnauthorizedRouter
	}
	m := svm.NewMsg("CC warp route transfer completed from origin: ")
	m.U32(h.Origin)
	return transferOut(c, &programID, tok, systemProgram, &it, &message, &m)
}

// transferFromRemoteAccountMetas is transfer_from_remote_account_metas_cc
// (HandleAccountMetas): the base metas with the CC state PDA before the
// recipient.
//
// Accounts: 0 token PDA.
func transferFromRemoteAccountMetas(c solana.Context, h *recipient.HandleInstruction) uint64 {
	return handleMetas(c, h.Message, nil)
}

// handleMetas returns [sender CC dispatch authority (s), when sender is
// set], system program, token PDA, CC state PDA, recipient, then the
// plugin's transfer_out metas, as SimulationReturnData.
func handleMetas(c solana.Context, body []byte, sender *svm.Pubkey) uint64 {
	message, ok := hyperlanecore.DecodeTokenMessage(body)
	if !ok {
		return tokenlib.ErrMessageDecodeError
	}
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)
	tokenAccount, code := it.Next()
	if code != svm.Success {
		return code
	}
	tok := new(Token)
	if code := tokenlib.VerifyAccountAndFetch(c, &programID, tokenAccount, tok); code != svm.Success {
		return code
	}
	pluginMetas, writableRecipient, code := tok.PluginData.TransferOutAccountMetas(c, &programID, &message.Recipient)
	if code != svm.Success {
		return code
	}
	stateKey, _, code := ccStatePDA.Find(c, &programID)
	if code != svm.Success {
		return code
	}
	metas := make([]accountmeta.SerializableAccountMeta, 0, 5+len(pluginMetas))
	if sender != nil {
		senderAuthority, _, code := ccDispatchAuthorityPDA.Find(c, sender)
		if code != svm.Success {
			return code
		}
		metas = append(metas, accountmeta.Readonly(senderAuthority, true))
	}
	metas = append(metas, accountmeta.Readonly(svm.SystemProgramID, false))
	metas = append(metas, accountmeta.Readonly(svm.Key(c, tokenAccount), false))
	metas = append(metas, accountmeta.Readonly(stateKey, false))
	metas = append(metas, accountmeta.SerializableAccountMeta{Pubkey: message.Recipient, IsWritable: writableRecipient})
	metas = append(metas, pluginMetas...)
	return solana.SetReturnData(c, accountmeta.EncodeMetasReturnData(metas))
}

// handleLocal is HandleLocal: a same-chain receive CPI'd by an enrolled CC
// program and signed by its CC dispatch authority.
//
// Accounts: 0 sender's CC dispatch authority (s), 1 system program, 2 token
// PDA, 3 CC state PDA, 4 recipient wallet, then the plugin's transfer_out.
func handleLocal(c solana.Context, h *HandleLocal) uint64 {
	message, ok := hyperlanecore.DecodeTokenMessage(h.Message)
	if !ok {
		return tokenlib.ErrMessageDecodeError
	}
	programID := svm.ProgramID(c)
	it := svm.NewAccountIter(c)

	signer, code := it.Next()
	if code != svm.Success {
		return code
	}
	expected, _, code := ccDispatchAuthorityPDA.Find(c, &h.SenderProgramID)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, signer, &expected) {
		return ErrInvalidDispatchAuthority
	}
	if !solana.Signer(c, signer) {
		return svm.MissingRequiredSignature
	}

	tok := new(Token)
	state := new(CrossCollateralState)
	systemProgram, code := loadTokenAndState(c, &programID, &it, tok, state)
	if code != svm.Success {
		return code
	}
	// The sender router is the PDA-verified sender program, never a
	// caller-supplied value.
	sender := hyperlanecore.H256(h.SenderProgramID)
	if !state.IsEnrolledRouter(state.LocalDomain, &sender) {
		return ErrUnauthorizedRouter
	}
	m := svm.NewMsg("CC handle_local completed from sender: ")
	m.Pubkey((*[32]byte)(&h.SenderProgramID))
	m.Str(", origin: ")
	m.U32(state.LocalDomain)
	return transferOut(c, &programID, tok, systemProgram, &it, &message, &m)
}

// handleLocalAccountMetas is HandleLocalAccountMetas.
//
// Accounts: 0 token PDA.
func handleLocalAccountMetas(c solana.Context, h *HandleLocal) uint64 {
	return handleMetas(c, h.Message, &h.SenderProgramID)
}
