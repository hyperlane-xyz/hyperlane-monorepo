// Package mailbox ports rust/sealevel/programs/mailbox (default no-spl-noop
// build) to goSVM. Instruction data, account layouts, PDA seeds, return data
// and ProgramError codes match the Rust program byte for byte; the SVM
// fixtures from tools/mailbox-fixtures run unchanged against both ELFs
// (run-svm-fixtures.sh).
//
// Accounts are read and written in place rather than Borsh-decoded and
// re-encoded. Rust's msg! log lines are emitted with the same text.
package mailbox

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core/merkle"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	recipient "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/message-recipient-interface"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Instruction discriminants: the Borsh enum index of mailbox::Instruction.
const (
	ixInit                      = 0
	ixInboxProcess              = 1
	ixInboxSetDefaultIsm        = 2
	ixInboxGetRecipientIsm      = 3
	ixOutboxDispatch            = 4
	ixOutboxGetCount            = 5
	ixOutboxGetLatestCheckpoint = 6
	ixOutboxGetRoot             = 7
	ixGetOwner                  = 8
	ixTransferOwnership         = 9
	ixClaimProtocolFees         = 10
	ixSetProtocolFeeConfig      = 11
)

// Mailbox custom errors (mailbox::error::Error).
const (
	errDecode                  uint64 = 2
	errUnsupportedVersion      uint64 = 3
	errDestinationNotLocal     uint64 = 4
	errMessageAlreadyProcessed uint64 = 5
	errExtraneousAccount       uint64 = 6
)

// VERSION in mailbox::instruction.
const messageVersion = 3

// package_versioned's GetProgramVersion discriminator and version.
const (
	getProgramVersion = "\x96\xe6\xb0\xa2\xec\x60\xb7\xab"
	packageVersion    = "1.0.0"
)

func Process(c solana.Context) uint64 {
	ix := solana.Instruction(c)
	if string(ix) == getProgramVersion {
		return getVersion(c)
	}
	if len(ix) == 0 {
		return svm.InvalidInstructionData
	}
	args := ix[1:]
	switch ix[0] {
	case ixInit:
		if len(args) != 84 {
			return svm.InvalidInstructionData
		}
		return svm.LogError(c, initialize(c, args))
	case ixInboxProcess:
		if len(args) < 4 {
			return svm.InvalidInstructionData
		}
		metadataLen := uint64(u32le(args, 0))
		if metadataLen > uint64(len(args))-4 || uint64(len(args))-4-metadataLen < 4 {
			return svm.InvalidInstructionData
		}
		messageOff := 8 + metadataLen
		if uint64(len(args)) != messageOff+uint64(u32le(args, 4+metadataLen)) {
			return svm.InvalidInstructionData
		}
		return svm.LogError(c, process(c, args, args[messageOff:]))
	case ixInboxSetDefaultIsm:
		if len(args) != 32 {
			return svm.InvalidInstructionData
		}
		return svm.LogError(c, setDefaultISM(c, args))
	case ixInboxGetRecipientIsm:
		if len(args) != 32 {
			return svm.InvalidInstructionData
		}
		return svm.LogError(c, getRecipientISM(c, args))
	case ixOutboxDispatch:
		if len(args) < 72 || uint64(len(args)) != 72+uint64(u32le(args, 68)) {
			return svm.InvalidInstructionData
		}
		return svm.LogError(c, dispatch(c, args))
	case ixOutboxGetCount, ixOutboxGetLatestCheckpoint, ixOutboxGetRoot, ixGetOwner:
		if len(args) != 0 {
			return svm.InvalidInstructionData
		}
		return svm.LogError(c, query(c, ix[0]))
	case ixTransferOwnership:
		if !(len(args) == 1 && args[0] == 0) && !(len(args) == 33 && args[0] == 1) {
			return svm.InvalidInstructionData
		}
		return svm.LogError(c, transferOwnership(c, args))
	case ixClaimProtocolFees:
		if len(args) != 0 {
			return svm.InvalidInstructionData
		}
		return svm.LogError(c, claimProtocolFees(c))
	case ixSetProtocolFeeConfig:
		if len(args) != 40 {
			return svm.InvalidInstructionData
		}
		return svm.LogError(c, setProtocolFee(c, args))
	}
	return svm.InvalidInstructionData
}

// need is next_account_info for account index i.
func need(c solana.Context, i uint64) uint64 {
	if solana.Count(c) <= i {
		return svm.NotEnoughAccountKeys
	}
	return svm.Success
}

// simulationReturn sets payload followed by SimulationReturnData's 0xff.
func simulationReturn(c solana.Context, payload []byte) uint64 {
	out := make([]byte, len(payload)+1)
	copy(out, payload)
	out[len(payload)] = 0xff
	return solana.SetReturnData(c, out)
}

func getVersion(c solana.Context) uint64 {
	var b [10]byte
	putU32le(b[:], 0, uint32(len(packageVersion)))
	copy(b[4:9], packageVersion)
	b[9] = 0xff
	return solana.SetReturnData(c, b[:])
}

// initialize is Init. Accounts: system program, payer/owner (signer), inbox,
// outbox. Args: local_domain u32, default_ism, max_protocol_fee u64,
// protocol_fee {fee u64, beneficiary}.
func initialize(c solana.Context, args []byte) uint64 {
	if code := need(c, 1); code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, 0, svm.SystemProgramID) {
		return svm.InvalidArgument
	}
	if !solana.Signer(c, 1) {
		return svm.MissingRequiredSignature
	}
	if code := need(c, 2); code != svm.Success {
		return code
	}
	program := svm.ProgramID(c)
	key, seeds, code := svm.FindProgramAddressSeeds(c, inboxSeeds(), program)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, 2, key) {
		return svm.InvalidArgument
	}
	if code = accountutils.VerifyAccountUninitialized(c, 2); code != svm.Success {
		return code
	}
	if u64le(args, 44) > u64le(args, 36) {
		svm.Log(c, "Invalid initialization config: Protocol fee is greater than max protocol fee")
		return svm.InvalidArgument
	}
	if code = accountutils.CreatePDAAccount(c, 1, inboxSize, program, 0, 2, &seeds); code != svm.Success {
		return code
	}
	if code = writable(c, 2); code != svm.Success {
		return code
	}
	data := solana.Data(c, 2)
	data[0] = 1
	copy(data[inboxOffDomain:inboxOffDomain+4], args[0:4])
	data[inboxOffBump] = seeds.Bump()
	copy(data[inboxOffISM:inboxOffISM+32], args[4:36])
	putU64le(data, inboxOffCounter, 0)

	if code = need(c, 3); code != svm.Success {
		return code
	}
	key, seeds, code = svm.FindProgramAddressSeeds(c, outboxSeeds(), program)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, 3, key) {
		return svm.InvalidArgument
	}
	if code = accountutils.VerifyAccountUninitialized(c, 3); code != svm.Success {
		return code
	}
	if code = accountutils.CreatePDAAccount(c, 1, outboxSize, program, 0, 3, &seeds); code != svm.Success {
		return code
	}
	if code = writable(c, 3); code != svm.Success {
		return code
	}
	data = solana.Data(c, 3)
	data[0] = 1
	copy(data[outboxOffDomain:outboxOffDomain+4], args[0:4])
	data[outboxOffBump] = seeds.Bump()
	data[outboxOffOwner] = 1
	copy(data[outboxOffOwner+1:outboxOffOwner+33], solana.Key(c, 1))
	tree := uint64(outboxOffOwner + 33)
	merkle.Init(data[tree : tree+merkle.Size])
	copy(data[tree+merkle.Size:tree+merkle.Size+48], args[36:84])
	return svm.Success
}

// Dispatched message account: initialized(1) "DISPATCH"(8) nonce u32le(4)
// slot u64le(8) unique message key(32) encoded message.
const dispatchedHeader = 1 + 8 + 4 + 8 + 32

// dispatch is OutboxDispatch. Accounts: outbox, sender signer, system
// program, spl-noop, payer (signer), unique message account (signer),
// dispatched message PDA. Args: sender, destination u32, recipient, body
// Vec<u8>.
func dispatch(c solana.Context, args []byte) uint64 {
	if code := need(c, 0); code != svm.Success {
		return code
	}
	o, code := loadOutbox(c, 0)
	if code != svm.Success {
		return code
	}
	if code = need(c, 1); code != svm.Success {
		return code
	}
	if !solana.Signer(c, 1) {
		return svm.MissingRequiredSignature
	}
	if !equal32(solana.Key(c, 1), args[0:32]) {
		seeds := [][]byte{[]byte("hyperlane_dispatcher"), []byte("-"), []byte("dispatch_authority")}
		key, _, code := svm.FindProgramAddress(c, seeds, pubkey(args[0:32]))
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, 1, key) {
			return svm.MissingRequiredSignature
		}
	}
	if code = need(c, 2); code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, 2, svm.SystemProgramID) {
		return svm.InvalidArgument
	}
	if code = need(c, 3); code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, 3, accountutils.SPLNoopProgramID) {
		return svm.InvalidArgument
	}
	if code = need(c, 4); code != svm.Success {
		return code
	}
	if !solana.Signer(c, 4) {
		return svm.MissingRequiredSignature
	}
	if code = need(c, 5); code != svm.Success {
		return code
	}
	if !solana.Signer(c, 5) {
		return svm.MissingRequiredSignature
	}
	if code = need(c, 6); code != svm.Success {
		return code
	}
	program := svm.ProgramID(c)
	unique := solana.Key(c, 5)
	key, seeds, code := svm.FindProgramAddressSeeds(c, [][]byte{[]byte("hyperlane"), []byte("-"), []byte("dispatched_message"), []byte("-"), unique}, program)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, 6, key) {
		return svm.InvalidArgument
	}
	if code = accountutils.VerifyAccountUninitialized(c, 6); code != svm.Success {
		return code
	}
	if solana.Count(c) > 7 {
		return errExtraneousAccount
	}
	count := merkle.Count(o.data[o.tree : o.tree+merkle.Size])
	if count > 0xffffffff {
		panic("Too many messages in outbox tree")
	}
	if code = svm.SystemTransfer(c, 2, 4, 0, o.fee, nil); code != svm.Success {
		return code
	}
	m := svm.NewMsg("Protocol fee of ")
	m.Dec(o.fee)
	m.Str(" paid from ")
	m.Key(solana.Key(c, 4))
	m.Str(" to ")
	m.Key(solana.Key(c, 0))
	m.Emit(c)

	body := args[72:]
	encodedLen := uint64(hyperlanecore.MessagePrefixLen + len(body))
	if code = accountutils.CreatePDAAccount(c, 4, dispatchedHeader+encodedLen, program, 2, 6, &seeds); code != svm.Success {
		return code
	}
	if code = writable(c, 6); code != svm.Success {
		return code
	}
	var clock [40]byte
	if code = solana.Clock(c, clock[:]); code != svm.Success {
		return code
	}
	stored := solana.Data(c, 6)
	stored[0] = 1
	copy(stored[1:9], "DISPATCH")
	putU32le(stored, 9, uint32(count))
	copy(stored[13:21], clock[0:8])
	copy(stored[21:53], solana.Key(c, 5))
	message := hyperlanecore.HyperlaneMessage{Version: messageVersion, Nonce: uint32(count), Origin: o.domain,
		Sender: pubkey(args[0:32]), Destination: u32le(args, 32), Recipient: pubkey(args[36:68]), Body: body}
	message.EncodeInto(stored[dispatchedHeader:])

	var id [32]byte
	if code = hyperlanecore.MessageID(c, stored, dispatchedHeader, encodedLen, id[:]); code != svm.Success {
		return code
	}
	m = svm.NewMsg("Dispatched message to ")
	m.U32(u32le(args, 32))
	m.Str(", ID ")
	m.H256(&id)
	m.Emit(c)
	if code = writable(c, 0); code != svm.Success {
		return code
	}
	tree := solana.Data(c, 0)
	if merkle.Ingest(c, tree[o.tree:o.tree+merkle.Size], id[:]) != 0 {
		panic("merkle tree is full")
	}
	return solana.SetReturnData(c, id[:])
}

// query handles OutboxGetCount, OutboxGetLatestCheckpoint, OutboxGetRoot and
// GetOwner. Accounts: outbox (GetOwner ignores extra accounts).
func query(c solana.Context, kind byte) uint64 {
	if code := need(c, 0); code != svm.Success {
		return code
	}
	o, code := loadOutbox(c, 0)
	if code != svm.Success {
		return code
	}
	if kind == ixGetOwner {
		if !o.hasOwner {
			var none [1]byte
			return simulationReturn(c, none[:])
		}
		var some [33]byte
		some[0] = 1
		copy(some[1:], o.data[o.owner:o.owner+32])
		return simulationReturn(c, some[:])
	}
	if solana.Count(c) > 1 {
		return errExtraneousAccount
	}
	tree := o.data[o.tree : o.tree+merkle.Size]
	count := merkle.Count(tree)
	if count > 0xffffffff {
		panic("Too many messages in outbox tree")
	}
	if kind == ixOutboxGetCount {
		var b [4]byte
		putU32le(b[:], 0, uint32(count))
		return simulationReturn(c, b[:])
	}
	if kind == ixOutboxGetRoot {
		var root [32]byte
		if code = merkle.Root(c, tree, root[:]); code != svm.Success {
			return code
		}
		return simulationReturn(c, root[:])
	}
	// Vec<u8> of root(32) || count u32le.
	var b [40]byte
	putU32le(b[:], 0, 36)
	if code = merkle.Root(c, tree, b[4:36]); code != svm.Success {
		return code
	}
	putU32le(b[:], 36, uint32(count))
	return simulationReturn(c, b[:])
}

// setDefaultISM is InboxSetDefaultIsm. Accounts: inbox, outbox, owner.
func setDefaultISM(c solana.Context, newISM []byte) uint64 {
	if code := need(c, 0); code != svm.Success {
		return code
	}
	in, code := loadInbox(c, 0)
	if code != svm.Success {
		return code
	}
	if code = need(c, 1); code != svm.Success {
		return code
	}
	o, code := loadOutbox(c, 1)
	if code != svm.Success {
		return code
	}
	if code = need(c, 2); code != svm.Success {
		return code
	}
	if code = o.ensureOwnerSigner(c, 2); code != svm.Success {
		return code
	}
	if solana.Count(c) > 3 {
		return errExtraneousAccount
	}
	if code = writable(c, 0); code != svm.Success {
		return code
	}
	in.data[0] = 1
	copy(in.data[inboxOffISM:inboxOffISM+32], newISM)
	return svm.Success
}

// transferOwnership is TransferOwnership. Accounts: outbox, current owner.
func transferOwnership(c solana.Context, args []byte) uint64 {
	if code := need(c, 0); code != svm.Success {
		return code
	}
	o, code := loadOutbox(c, 0)
	if code != svm.Success {
		return code
	}
	if code = need(c, 1); code != svm.Success {
		return code
	}
	if code = o.ensureOwnerSigner(c, 1); code != svm.Success {
		return code
	}
	// AccessControl::transfer_ownership's log.
	m := svm.NewMsg("Ownership transferred to ")
	if args[0] == 1 {
		m.Str("Some(")
		m.Key(args[1:33])
		m.Str(")")
	} else {
		m.OptionPubkey(false, nil)
	}
	m.Emit(c)
	if code = writable(c, 0); code != svm.Success {
		return code
	}
	// Re-serialize in place. A changed Option tag moves the tree and the fee
	// fields by 32 bytes; trailing bytes are zeroed as AccountData::store does.
	data := o.data
	off := uint64(outboxOffOwner + 1)
	if args[0] == 1 {
		off += 32
	}
	if uint64(len(data)) < off+outboxTailSize {
		return svm.BorshIoError
	}
	if off != o.tree {
		copy(data[off:off+outboxTailSize], data[o.tree:o.tree+outboxTailSize])
	}
	data[outboxOffOwner] = args[0]
	if args[0] == 1 {
		copy(data[outboxOffOwner+1:outboxOffOwner+33], args[1:33])
	}
	for j := off + outboxTailSize; j < uint64(len(data)); j++ {
		data[j] = 0
	}
	return svm.Success
}

// setProtocolFee is SetProtocolFeeConfig. Accounts: outbox, owner.
func setProtocolFee(c solana.Context, args []byte) uint64 {
	if code := need(c, 0); code != svm.Success {
		return code
	}
	o, code := loadOutbox(c, 0)
	if code != svm.Success {
		return code
	}
	if code = need(c, 1); code != svm.Success {
		return code
	}
	if code = o.ensureOwnerSigner(c, 1); code != svm.Success {
		return code
	}
	if u64le(args, 0) > o.maxFee {
		svm.Log(c, "Invalid protocol fee config: Fee is greater than max protocol fee")
		return svm.InvalidArgument
	}
	if code = writable(c, 0); code != svm.Success {
		return code
	}
	off := o.tree + merkle.Size + 8
	copy(o.data[off:off+40], args[0:40])
	return svm.Success
}

// claimProtocolFees is ClaimProtocolFees: move the outbox's lamports above its
// rent-exempt minimum to the protocol fee beneficiary. Accounts: outbox,
// beneficiary.
func claimProtocolFees(c solana.Context) uint64 {
	if code := need(c, 0); code != svm.Success {
		return code
	}
	o, code := loadOutbox(c, 0)
	if code != svm.Success {
		return code
	}
	if code = need(c, 1); code != svm.Success {
		return code
	}
	if o.tree == 0 {
		// Uninitialized data decodes as the default Outbox, whose
		// beneficiary is the zero key.
		var zero [32]byte
		if !equal32(solana.Key(c, 1), zero[:]) {
			return svm.InvalidArgument
		}
	} else if beneficiary := o.tree + merkle.Size + 16; !equal32(solana.Key(c, 1), o.data[beneficiary:beneficiary+32]) {
		return svm.InvalidArgument
	}
	required, code := svm.MinimumBalance(c, uint64(len(o.data)))
	if code != svm.Success {
		return code
	}
	if lamports := solana.Lamports(c, 0); lamports > required {
		// Rust's saturating_sub, -= and +=. A zero claim moves nothing, so
		// read-only accounts only fail when there is something to claim.
		if code := solana.MoveLamports(c, 0, 1, lamports-required); code != 0 {
			// Read-only or executable beneficiary: Rust fails after the
			// instruction (the runtime rejects the lamport change).
			return svm.InvalidAccountData
		}
	}
	return accountutils.VerifyRentExempt(c, 0)
}

// getRecipientISM is InboxGetRecipientIsm. Accounts: inbox, recipient
// program, then the accounts its InterchainSecurityModule instruction needs.
func getRecipientISM(c solana.Context, recipientKey []byte) uint64 {
	if code := need(c, 0); code != svm.Success {
		return code
	}
	in, code := loadInbox(c, 0)
	if code != svm.Success {
		return code
	}
	if code = need(c, 1); code != svm.Success {
		return code
	}
	if !equal32(solana.Key(c, 1), recipientKey) || !solana.Executable(c, 1) {
		return svm.InvalidArgument
	}
	var found [32]byte
	if code = recipientISM(c, 1, 2, solana.Count(c), recipientKey, in.data[inboxOffISM:inboxOffISM+32], found[:]); code != svm.Success {
		return code
	}
	return simulationReturn(c, found[:])
}

// recipientISM is get_recipient_ism: it invokes the recipient program at
// index program with accounts [from, to) and writes the ISM it returns, or
// defaultISM, to found.
func recipientISM(c solana.Context, program, from, to uint64, recipientKey, defaultISM, found []byte) uint64 {
	var metas svm.Metas
	for i := from; i < to; i++ {
		metas.Add(i, solana.Writable(c, i), solana.Signer(c, i))
	}
	if code := svm.Invoke(c, program, &metas, recipient.InterchainSecurityModuleDiscriminator[:], nil); code != svm.Success {
		return code
	}
	copy(found[:32], defaultISM)
	var returned [33]byte
	var setter [32]byte
	n := solana.GetReturnData(c, returned[:], setter[:])
	if n > 0 {
		if !equal32(setter[:], recipientKey) {
			return svm.InvalidAccountData
		}
		if n == 33 && returned[0] == 1 {
			copy(found[:32], returned[1:33])
		} else if !(n == 1 && returned[0] == 0) {
			return svm.BorshIoError
		}
	}
	return svm.Success
}

// AccountData<ProcessedMessage>: initialized(1) "PROCESSD"(8) sequence
// u64le(8) message ID(32) slot u64le(8).
const processedSize = 1 + 8 + 8 + 32 + 8

// process is InboxProcess. Accounts: payer (signer), system program, inbox,
// the recipient's process authority, the processed message PDA, the
// recipient's InterchainSecurityModule accounts, spl-noop, the ISM, its
// Verify accounts, the recipient program, then the recipient's Handle
// accounts. args is metadata Vec<u8> then message Vec<u8>; message is the
// message bytes.
func process(c solana.Context, args, message []byte) uint64 {
	if len(message) < hyperlanecore.MessagePrefixLen {
		return errDecode
	}
	var id [32]byte
	if code := hyperlanecore.MessageID(c, message, 0, uint64(len(message)), id[:]); code != svm.Success {
		return code
	}
	if message[0] != messageVersion {
		return errUnsupportedVersion
	}
	recipientKey := message[45:77]
	if code := need(c, 0); code != svm.Success {
		return code
	}
	if !solana.Signer(c, 0) {
		return svm.MissingRequiredSignature
	}
	if code := need(c, 1); code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, 1, svm.SystemProgramID) {
		return svm.InvalidArgument
	}
	if code := need(c, 2); code != svm.Success {
		return code
	}
	in, code := loadInbox(c, 2)
	if code != svm.Success {
		return code
	}
	if in.domain != u32be(message, 41) {
		return errDestinationNotLocal
	}
	program := svm.ProgramID(c)
	if code = need(c, 3); code != svm.Success {
		return code
	}
	key, authority, code := svm.FindProgramAddressSeeds(c, [][]byte{[]byte("hyperlane"), []byte("-"), []byte("process_authority"), []byte("-"), recipientKey}, program)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, 3, key) {
		return svm.InvalidArgument
	}
	if code = need(c, 4); code != svm.Success {
		return code
	}
	key, processed, code := svm.FindProgramAddressSeeds(c, [][]byte{[]byte("hyperlane"), []byte("-"), []byte("processed_message"), []byte("-"), id[:]}, program)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, 4, key) {
		return svm.InvalidArgument
	}
	if accountutils.VerifyAccountUninitialized(c, 4) != svm.Success {
		return errMessageAlreadyProcessed
	}
	count := solana.Count(c)
	next := uint64(5)
	for ; next < count && !svm.KeyIs(c, next, accountutils.SPLNoopProgramID); next++ {
	}
	if next >= count {
		return svm.InvalidArgument
	}
	ismIndex := next + 1
	if code = need(c, ismIndex); code != svm.Success {
		return code
	}
	// Rust finds the recipient program after the ISM's accounts; goSVM
	// invokes by account index, so locate it before the first CPI.
	recipientIndex := ismIndex + 1
	for ; recipientIndex < count && !equal32(solana.Key(c, recipientIndex), recipientKey); recipientIndex++ {
	}
	if recipientIndex >= count {
		return svm.InvalidArgument
	}
	// Rust holds a RefMut of the inbox data across all three CPIs, so the
	// checked invoke fails with AccountBorrowFailed before any CPI that is
	// passed the inbox (a reentrant InboxProcess).
	if passesAccount(c, 5, next, 2) {
		return svm.AccountBorrowFailed
	}
	var found [32]byte
	if code = recipientISM(c, recipientIndex, 5, next, recipientKey, in.data[inboxOffISM:inboxOffISM+32], found[:]); code != svm.Success {
		return code
	}
	if !equal32(solana.Key(c, ismIndex), found[:]) {
		return svm.InvalidArgument
	}
	if !solana.Executable(c, recipientIndex) {
		return svm.InvalidAccountData
	}

	// The per-ISM process authority signs Verify when the ISM lists it.
	ismAuthorityKey, ismAuthority, code := svm.FindProgramAddressSeeds(c, [][]byte{[]byte("process_authority"), found[:]}, program)
	if code != svm.Success {
		return code
	}
	var metas svm.Metas
	for i := ismIndex + 1; i < recipientIndex; i++ {
		metas.Add(i, solana.Writable(c, i), solana.Signer(c, i) || svm.KeyIs(c, i, ismAuthorityKey))
	}
	if passesAccount(c, ismIndex+1, recipientIndex, 2) {
		return svm.AccountBorrowFailed
	}
	// Verify's data is its discriminator then the same metadata and message
	// Vec<u8>s InboxProcess carries.
	verify := make([]byte, 8+len(args))
	copy(verify, ism.VerifyDiscriminator[:])
	copy(verify[8:], args)
	if code = svm.Invoke(c, ismIndex, &metas, verify, &ismAuthority); code != svm.Success {
		return code
	}

	if code = accountutils.CreatePDAAccount(c, 0, processedSize, program, 1, 4, &processed); code != svm.Success {
		return code
	}
	if code = writable(c, 4); code != svm.Success {
		return code
	}
	var clock [40]byte
	if code = solana.Clock(c, clock[:]); code != svm.Success {
		return code
	}
	inboxData := solana.Data(c, 2)
	stored := solana.Data(c, 4)
	stored[0] = 1
	copy(stored[1:9], "PROCESSD")
	copy(stored[9:17], inboxData[inboxOffCounter:inboxOffCounter+8])
	copy(stored[17:49], id[:])
	copy(stored[49:57], clock[0:8])
	putU64le(inboxData, inboxOffCounter, u64le(inboxData, inboxOffCounter)+1)

	body := message[hyperlanecore.MessagePrefixLen:]
	handle := make([]byte, 8+4+32+4+len(body))
	copy(handle, recipient.HandleDiscriminator[:])
	putU32le(handle, 8, u32be(message, 5))
	copy(handle[12:44], message[9:41])
	putU32le(handle, 44, uint32(len(body)))
	copy(handle[48:], body)
	if passesAccount(c, recipientIndex+1, count, 2) {
		return svm.AccountBorrowFailed
	}
	metas = svm.Metas{}
	metas.Add(3, false, true)
	for i := recipientIndex + 1; i < count; i++ {
		metas.Add(i, solana.Writable(c, i), solana.Signer(c, i))
	}
	if code = svm.Invoke(c, recipientIndex, &metas, handle, &authority); code != svm.Success {
		return code
	}
	m := svm.NewMsg("Hyperlane inbox processed message ")
	m.H256(&id)
	m.Emit(c)
	return svm.Success
}

// passesAccount reports whether any account in [from, to) has account
// held's key.
func passesAccount(c solana.Context, from, to, held uint64) bool {
	key := solana.Key(c, held)
	for i := from; i < to; i++ {
		if equal32(solana.Key(c, i), key) {
			return true
		}
	}
	return false
}
