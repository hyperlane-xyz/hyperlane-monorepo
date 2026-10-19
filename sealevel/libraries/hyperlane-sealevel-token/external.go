package tokenlib

// Mailbox, IGP and fee program layouts the token processor reads or encodes.
// Each mirrors the Rust crate named in its comment; the token library only
// needs these few fields, so it does not import those programs' ports.

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Mailbox PDA seeds (hyperlane-sealevel-mailbox pda_seeds).
var (
	MailboxOutboxPDASeeds            = [][]byte{[]byte("hyperlane"), []byte("-"), []byte("outbox")}
	MailboxDispatchAuthorityPDASeeds = [][]byte{[]byte("hyperlane_dispatcher"), []byte("-"), []byte("dispatch_authority")}
)

// MailboxProcessAuthorityPDASeeds is mailbox_process_authority_pda_seeds!(recipient).
func MailboxProcessAuthorityPDASeeds(recipient *svm.Pubkey) [][]byte {
	return [][]byte{[]byte("hyperlane"), []byte("-"), []byte("process_authority"), []byte("-"), recipient[:]}
}

// IgpQuoteAuthorityPDASeeds is igp_quote_authority_pda_seeds!().
var IgpQuoteAuthorityPDASeeds = [][]byte{[]byte("hyperlane_dispatcher"), []byte("-"), []byte("igp_quote_authority")}

// outboxTreeSize is the Outbox merkle tree: 32 branch hashes and a u64 count.
const outboxTreeSize = 32*32 + 8

// VerifyOutboxAndFetchLocalDomain is mailbox Outbox::verify_account_and_fetch_inner,
// returning local_domain: the outbox must decode (BorshIoError), be the
// canonical outbox PDA of mailbox (InvalidArgument) and be owned by it
// (IllegalOwner).
func VerifyOutboxAndFetchLocalDomain(c solana.Context, mailbox *svm.Pubkey, i uint64) (uint32, uint64) {
	var localDomain uint32
	var bump uint8
	data := solana.Data(c, i)
	if len(data) > 0 {
		r := borsh.NewReader(data)
		initialized := r.Bool()
		if !r.Ok() {
			return 0, svm.BorshIoError
		}
		if initialized {
			localDomain = r.U32()
			bump = r.U8()
			borsh.ReadOption(&r, borsh.ReadBytes32)
			r.Fixed(outboxTreeSize)
			r.U64()     // max_protocol_fee
			r.U64()     // protocol_fee.fee
			r.Bytes32() // protocol_fee.beneficiary
			if !r.Ok() {
				return 0, svm.BorshIoError
			}
		}
	}
	expected, code := svm.CreateProgramAddress(c, MailboxOutboxPDASeeds, bump, *mailbox)
	if code != svm.Success {
		return 0, code
	}
	if !svm.KeyIs(c, i, expected) {
		return 0, svm.InvalidArgument
	}
	if !svm.OwnerIs(c, i, *mailbox) {
		return 0, svm.IllegalOwner
	}
	return localDomain, svm.Success
}

// IGP account discriminators (hyperlane-sealevel-igp accounts).
var (
	igpDiscriminator          = [8]byte{'I', 'G', 'P', '_', '_', '_', '_', '_'}
	igpFeeConfigDiscriminator = [8]byte{'I', 'G', 'P', 'F', 'E', 'E', 'V', '1'}
)

// gasOracleEntrySize is one (u32, GasOracle::RemoteGasData) map entry.
const gasOracleEntrySize = 4 + 1 + 16 + 16 + 1

func equal8(b []byte, d *[8]byte) bool {
	for i := 0; i < 8; i++ {
		if b[i] != d[i] {
			return false
		}
	}
	return true
}

// IgpQuoted is igp_quote_mode: false is Legacy, true is Quoted. Malformed
// data is InvalidAccountData.
func IgpQuoted(data []byte) (bool, uint64) {
	r := borsh.NewReader(data)
	r.Bool()
	disc := r.Fixed(8)
	if !r.Ok() || !equal8(disc, &igpDiscriminator) {
		return false, svm.InvalidAccountData
	}
	r.U8()      // bump
	r.Bytes32() // salt
	borsh.ReadOption(&r, borsh.ReadBytes32)
	r.Bytes32() // beneficiary
	n := uint64(r.U32())
	if !r.Ok() {
		return false, svm.InvalidAccountData
	}
	skip := n * gasOracleEntrySize
	if uint64(r.Remaining()) < skip {
		return false, svm.InvalidAccountData
	}
	r.Fixed(int(skip))
	if r.Remaining() < 8 || !equal8(r.Rest(), &igpFeeConfigDiscriminator) {
		return false, svm.Success
	}
	r.Fixed(8)
	// IgpFeeConfig: BTreeSet<H160> signers, u32 domain_id, i64 min_issued_at.
	signers := uint64(r.U32())
	if !r.Ok() || uint64(r.Remaining()) < signers*20 {
		return false, svm.InvalidAccountData
	}
	r.Fixed(int(signers * 20))
	r.U32()
	r.U64()
	if !r.Ok() {
		return false, svm.InvalidAccountData
	}
	return true, svm.Success
}

// feeAccountDiscriminator is hyperlane-sealevel-fee's FEE_ACCOUNT_DISCRIMINATOR.
var feeAccountDiscriminator = [8]byte{'F', 'E', 'E', '_', 'A', 'C', 'C', 'T'}

// FeeAccountPrefix is hyperlane-sealevel-fee accounts::FeeAccountPrefix.
type FeeAccountPrefix struct {
	Beneficiary svm.Pubkey
	DomainID    uint32
}

// ParseFeeAccountPrefix is FeeAccountPrefix::parse_from.
func ParseFeeAccountPrefix(data []byte, out *FeeAccountPrefix) uint64 {
	if len(data) < 9 {
		return svm.InvalidAccountData
	}
	if data[0] != 1 {
		return svm.UninitializedAccount
	}
	if !equal8(data[1:9], &feeAccountDiscriminator) {
		return svm.InvalidAccountData
	}
	r := borsh.NewReader(data[9:])
	r.U8() // bump
	borsh.ReadOption(&r, borsh.ReadBytes32)
	out.Beneficiary = r.Bytes32()
	out.DomainID = r.U32()
	if !r.Ok() {
		return svm.InvalidAccountData
	}
	return svm.Success
}

// feeQuoteFee is the fee program's Instruction::QuoteFee enum index.
const feeQuoteFee uint8 = 1

// QuoteFeeData is borsh(fee Instruction::QuoteFee(..)).
func QuoteFeeData(destination uint32, recipient *hyperlanecore.H256, amount uint64, targetRouter *hyperlanecore.H256) []byte {
	w := borsh.NewWriter(1 + 4 + 32 + 8 + 32)
	w.EnumTag(feeQuoteFee)
	w.U32(destination)
	w.Bytes32(*recipient)
	w.U64(amount)
	w.Bytes32(*targetRouter)
	return w.Bytes()
}
