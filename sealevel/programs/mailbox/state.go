package mailbox

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core/merkle"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// AccountData<Inbox>: initialized(1) local_domain(4) bump(1) default_ism(32)
// processed_count(8).
const (
	inboxSize       = 1 + 4 + 1 + 32 + 8
	inboxOffDomain  = 1
	inboxOffBump    = 5
	inboxOffISM     = 6
	inboxOffCounter = 38
)

// AccountData<Outbox>: initialized(1) local_domain(4) bump(1) owner
// Option<Pubkey>(1 or 33) tree(1032) max_protocol_fee(8) fee(8)
// beneficiary(32), allocated at the Some-owner size and zero-filled.
const (
	outboxSize      = 1 + 4 + 1 + 33 + merkle.Size + 8 + 8 + 32
	outboxOffDomain = 1
	outboxOffBump   = 5
	outboxOffOwner  = 6
	outboxTailSize  = merkle.Size + 8 + 8 + 32
)

func inboxSeeds() [][]byte {
	return [][]byte{[]byte("hyperlane"), []byte("-"), []byte("inbox")}
}

func outboxSeeds() [][]byte {
	return [][]byte{[]byte("hyperlane"), []byte("-"), []byte("outbox")}
}

// outbox is a decoded view of the Outbox account's data, read in place.
type outbox struct {
	data     []byte
	domain   uint32
	hasOwner bool
	owner    uint64 // offset of the owner key
	tree     uint64 // offset of the merkle tree
	maxFee   uint64
	fee      uint64
}

// verifyPDA is verify_account_and_fetch_inner's address and owner check for
// account i, whose stored bump is bump.
func verifyPDA(c solana.Context, i uint64, seeds [][]byte, bump byte) uint64 {
	key, code := svm.CreateProgramAddress(c, seeds, bump, svm.ProgramID(c))
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, i, key) {
		return svm.InvalidArgument
	}
	if !equal32(solana.Owner(c, i), solana.ProgramID(c)) {
		return svm.IllegalOwner
	}
	return svm.Success
}

// loadOutbox decodes AccountData<Outbox> at index i and verifies the PDA.
// Empty or uninitialized data decodes as the default Outbox, as in Rust.
func loadOutbox(c solana.Context, i uint64) (outbox, uint64) {
	var o outbox
	data := solana.Data(c, i)
	o.data = data
	bump := byte(0)
	if len(data) > 0 && data[0] > 1 {
		return o, svm.BorshIoError
	}
	if len(data) > 0 && data[0] == 1 {
		if len(data) < 7 || data[outboxOffOwner] > 1 {
			return o, svm.BorshIoError
		}
		o.domain = u32le(data, outboxOffDomain)
		bump = data[outboxOffBump]
		o.hasOwner = data[outboxOffOwner] == 1
		o.owner = outboxOffOwner + 1
		o.tree = outboxOffOwner + 1
		if o.hasOwner {
			o.tree += 32
		}
		if uint64(len(data)) < o.tree+outboxTailSize {
			return o, svm.BorshIoError
		}
		o.maxFee = u64le(data, o.tree+merkle.Size)
		o.fee = u64le(data, o.tree+merkle.Size+8)
	}
	return o, verifyPDA(c, i, outboxSeeds(), bump)
}

// ensureOwnerSigner is AccessControl::ensure_owner_signer.
func (o outbox) ensureOwnerSigner(c solana.Context, i uint64) uint64 {
	if !o.hasOwner {
		return svm.InvalidArgument
	}
	if !solana.Signer(c, i) {
		return svm.MissingRequiredSignature
	}
	if !equal32(solana.Key(c, i), o.data[o.owner:o.owner+32]) {
		return svm.InvalidArgument
	}
	return svm.Success
}

// writable is AccountData::store's precondition.
func writable(c solana.Context, i uint64) uint64 {
	if !solana.Writable(c, i) || solana.Executable(c, i) {
		return svm.InvalidAccountData
	}
	return svm.Success
}

// inbox is a decoded view of the Inbox account's data, read in place.
type inbox struct {
	data   []byte
	domain uint32
}

func loadInbox(c solana.Context, i uint64) (inbox, uint64) {
	var in inbox
	data := solana.Data(c, i)
	in.data = data
	bump := byte(0)
	if len(data) > 0 && data[0] > 1 {
		return in, svm.BorshIoError
	}
	if len(data) > 0 && data[0] == 1 {
		if len(data) < inboxSize {
			return in, svm.BorshIoError
		}
		in.domain = u32le(data, inboxOffDomain)
		bump = data[inboxOffBump]
	}
	return in, verifyPDA(c, i, inboxSeeds(), bump)
}
