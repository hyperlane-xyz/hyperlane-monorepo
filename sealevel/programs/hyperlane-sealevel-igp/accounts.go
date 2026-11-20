package igp

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

type (
	Pubkey = svm.Pubkey
	H256   = hyperlanecore.H256
	H160   = hyperlanecore.H160
	U128   = borsh.U128
)

// Account discriminators (DiscriminatorData::DISCRIMINATOR).
var (
	ProgramDataDiscriminator       = accountutils.Discriminator{'P', 'R', 'G', 'M', 'D', 'A', 'T', 'A'}
	OverheadIgpDiscriminator       = accountutils.Discriminator{'O', 'V', 'R', 'H', 'D', 'I', 'G', 'P'}
	IgpDiscriminator               = accountutils.Discriminator{'I', 'G', 'P', '_', '_', '_', '_', '_'}
	GasPaymentDiscriminator        = accountutils.Discriminator{'G', 'A', 'S', 'P', 'A', 'Y', 'M', 'T'}
	IgpFeeConfigDiscriminator      = accountutils.Discriminator{'I', 'G', 'P', 'F', 'E', 'E', 'V', '1'}
	IgpStandingQuoteDiscriminator  = accountutils.Discriminator{'I', 'G', 'P', 'S', 'T', 'Q', 'T', 'E'}
	IgpTransientQuoteDiscriminator = accountutils.Discriminator{'I', 'G', 'P', 'T', 'Q', 'O', 'T', 'E'}
)

// SolDecimals is SOL_DECIMALS.
const SolDecimals = 9

// TokenExchangeRateScale is TOKEN_EXCHANGE_RATE_SCALE (10^19).
const TokenExchangeRateScale uint64 = 10_000_000_000_000_000_000

// WildcardDomain is WILDCARD_DOMAIN (u32::MAX).
const WildcardDomain uint32 = 0xffff_ffff

// WildcardSender is WILDCARD_SENDER ([0xff; 32]).
var WildcardSender = Pubkey{
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
}

// IGP_QUOTE_CONTEXT_SIZE and IGP_QUOTE_DATA_SIZE.
const (
	IgpQuoteContextSize = 32 + 4 + 32
	IgpQuoteDataSize    = 16 + 16 + 1
)

func writeOwner(w *borsh.Writer, o *accesscontrol.Owner) {
	w.OptionTag(o.Some)
	if o.Some {
		w.Bytes32(o.Value)
	}
}

func readOwner(r *borsh.Reader) accesscontrol.Owner {
	var o accesscontrol.Owner
	if r.OptionTag() {
		o.Value = r.Bytes32()
		o.Some = r.Ok()
	}
	return o
}

func ownerSize(o *accesscontrol.Owner) int {
	if o.Some {
		return 33
	}
	return 1
}

// RemoteGasData is accounts::RemoteGasData.
type RemoteGasData struct {
	TokenExchangeRate U128
	GasPrice          U128
	TokenDecimals     uint8
}

func (d *RemoteGasData) EncodeBorsh(w *borsh.Writer) {
	w.U128(d.TokenExchangeRate)
	w.U128(d.GasPrice)
	w.U8(d.TokenDecimals)
}

func (d *RemoteGasData) DecodeBorsh(r *borsh.Reader) {
	d.TokenExchangeRate = r.U128()
	d.GasPrice = r.U128()
	d.TokenDecimals = r.U8()
}

// GasOracle is accounts::GasOracle. Its only variant (index 0) is
// RemoteGasData, so the value is the variant's payload.
type GasOracle struct {
	RemoteGasData RemoteGasData
}

// GasOracleRemoteGasData is GasOracle::RemoteGasData's variant index.
const GasOracleRemoteGasData uint8 = 0

func (o *GasOracle) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(GasOracleRemoteGasData)
	o.RemoteGasData.EncodeBorsh(w)
}

func (o *GasOracle) DecodeBorsh(r *borsh.Reader) {
	if r.EnumTag() != GasOracleRemoteGasData {
		r.Fail()
		return
	}
	o.RemoteGasData.DecodeBorsh(r)
}

// gasOracleEntrySize is GAS_ORACLE_ENTRY_SIZE: u32 key + variant tag + 33.
const gasOracleEntrySize = 4 + 1 + 16 + 16 + 1

// ProgramData is accounts::ProgramData, stored as
// AccountData<DiscriminatorPrefixed<ProgramData>>.
type ProgramData struct {
	BumpSeed     uint8
	PaymentCount uint64
}

func (d *ProgramData) EncodeBorsh(w *borsh.Writer) {
	accountutils.WriteDiscriminator(w, ProgramDataDiscriminator)
	w.U8(d.BumpSeed)
	w.U64(d.PaymentCount)
}

func (d *ProgramData) DecodeBorsh(r *borsh.Reader) {
	accountutils.ReadDiscriminator(r, ProgramDataDiscriminator)
	d.BumpSeed = r.U8()
	d.PaymentCount = r.U64()
}

// Size is DiscriminatorPrefixed<ProgramData>::size.
func (d *ProgramData) Size() int { return accountutils.DiscriminatorLength + 1 + 8 }

// GasOverhead is one gas_overheads entry.
type GasOverhead = borsh.Pair[uint32, uint64]

// OverheadIgp is accounts::OverheadIgp, stored as
// AccountData<DiscriminatorPrefixed<OverheadIgp>>. GasOverheads is the
// HashMap as key-sorted pairs.
type OverheadIgp struct {
	BumpSeed     uint8
	Salt         H256
	Owner        accesscontrol.Owner
	Inner        Pubkey
	GasOverheads []GasOverhead
}

func (o *OverheadIgp) EncodeBorsh(w *borsh.Writer) {
	accountutils.WriteDiscriminator(w, OverheadIgpDiscriminator)
	w.U8(o.BumpSeed)
	w.Bytes32(o.Salt)
	writeOwner(w, &o.Owner)
	w.Bytes32(o.Inner)
	borsh.WriteMap(w, o.GasOverheads, borsh.WriteU32, borsh.WriteU64)
}

func (o *OverheadIgp) DecodeBorsh(r *borsh.Reader) {
	accountutils.ReadDiscriminator(r, OverheadIgpDiscriminator)
	o.BumpSeed = r.U8()
	o.Salt = r.Bytes32()
	o.Owner = readOwner(r)
	o.Inner = r.Bytes32()
	o.GasOverheads = borsh.ReadMap(r, borsh.ReadU32, borsh.ReadU64, borsh.LessU32)
}

func (o *OverheadIgp) Size() int {
	return accountutils.DiscriminatorLength + 1 + 32 + ownerSize(&o.Owner) + 32 + 4 + len(o.GasOverheads)*(4+8)
}

// GasOverhead returns the overhead for a domain, 0 when unset.
func (o *OverheadIgp) GasOverhead(domain uint32) uint64 {
	for i := range o.GasOverheads {
		if o.GasOverheads[i].Key == domain {
			return o.GasOverheads[i].Value
		}
	}
	return 0
}

// IgpFeeConfig is accounts::IgpFeeConfig. Signers is the BTreeSet, sorted.
type IgpFeeConfig struct {
	Signers     []H160
	DomainID    uint32
	MinIssuedAt int64
}

func (f *IgpFeeConfig) EncodeBorsh(w *borsh.Writer) {
	borsh.WriteSet(w, f.Signers, borsh.WriteBytes20)
	w.U32(f.DomainID)
	w.I64(f.MinIssuedAt)
}

func (f *IgpFeeConfig) DecodeBorsh(r *borsh.Reader) {
	f.Signers = borsh.ReadSet(r, borsh.ReadBytes20, borsh.Less20)
	f.DomainID = r.U32()
	f.MinIssuedAt = r.I64()
}

func (f *IgpFeeConfig) Size() int { return 4 + len(f.Signers)*20 + 4 + 8 }

// GasOracleEntry is one gas_oracles entry.
type GasOracleEntry = borsh.Pair[uint32, GasOracle]

// Igp is accounts::Igp, stored as AccountData<DiscriminatorPrefixed<Igp>>.
// GasOracles is the HashMap as key-sorted pairs; FeeConfig is the trailing
// OptionalDiscriminatedData<IgpFeeConfig>.
type Igp struct {
	BumpSeed    uint8
	Salt        H256
	Owner       accesscontrol.Owner
	Beneficiary Pubkey
	GasOracles  []GasOracleEntry
	FeeConfig   borsh.Option[IgpFeeConfig]
}

func writeGasOracle(w *borsh.Writer, o GasOracle) { o.EncodeBorsh(w) }

func readGasOracle(r *borsh.Reader) GasOracle {
	var o GasOracle
	o.DecodeBorsh(r)
	return o
}

func (g *Igp) EncodeBorsh(w *borsh.Writer) {
	accountutils.WriteDiscriminator(w, IgpDiscriminator)
	w.U8(g.BumpSeed)
	w.Bytes32(g.Salt)
	writeOwner(w, &g.Owner)
	w.Bytes32(g.Beneficiary)
	borsh.WriteMap(w, g.GasOracles, borsh.WriteU32, writeGasOracle)
	accountutils.WriteOptionalDiscriminated(w, IgpFeeConfigDiscriminator, &g.FeeConfig)
}

func (g *Igp) DecodeBorsh(r *borsh.Reader) {
	accountutils.ReadDiscriminator(r, IgpDiscriminator)
	g.BumpSeed = r.U8()
	g.Salt = r.Bytes32()
	g.Owner = readOwner(r)
	g.Beneficiary = r.Bytes32()
	g.GasOracles = borsh.ReadMap(r, borsh.ReadU32, readGasOracle, borsh.LessU32)
	g.FeeConfig = accountutils.ReadOptionalDiscriminated[IgpFeeConfig](r, IgpFeeConfigDiscriminator)
}

func (g *Igp) Size() int {
	n := accountutils.DiscriminatorLength + 1 + 32 + ownerSize(&g.Owner) + 32 + 4 + len(g.GasOracles)*(gasOracleEntrySize)
	if g.FeeConfig.Some {
		n += accountutils.DiscriminatorLength + g.FeeConfig.Value.Size()
	}
	return n
}

// gasOracle returns the oracle for a domain.
func (g *Igp) gasOracle(domain uint32) (*RemoteGasData, bool) {
	for i := range g.GasOracles {
		if g.GasOracles[i].Key == domain {
			return &g.GasOracles[i].Value.RemoteGasData, true
		}
	}
	return nil, false
}

// QuoteGasPayment is Igp::quote_gas_payment.
func (g *Igp) QuoteGasPayment(domain uint32, gasAmount uint64) (uint64, uint64) {
	oracle, ok := g.gasOracle(domain)
	if !ok {
		return 0, ErrNoGasOracleSetForDestinationDomain
	}
	return ComputeGasFee(oracle.TokenExchangeRate, oracle.GasPrice, gasAmount, oracle.TokenDecimals)
}

// GasPaymentData is accounts::GasPaymentData, stored as
// AccountData<DiscriminatorPrefixed<GasPaymentData>>.
type GasPaymentData struct {
	SequenceNumber         uint64
	Igp                    Pubkey
	DestinationDomain      uint32
	MessageID              H256
	GasAmount              uint64
	Payment                uint64
	UniqueGasPaymentPubkey Pubkey
	Slot                   uint64
}

func (p *GasPaymentData) EncodeBorsh(w *borsh.Writer) {
	accountutils.WriteDiscriminator(w, GasPaymentDiscriminator)
	w.U64(p.SequenceNumber)
	w.Bytes32(p.Igp)
	w.U32(p.DestinationDomain)
	w.Bytes32(p.MessageID)
	w.U64(p.GasAmount)
	w.U64(p.Payment)
	w.Bytes32(p.UniqueGasPaymentPubkey)
	w.U64(p.Slot)
}

func (p *GasPaymentData) DecodeBorsh(r *borsh.Reader) {
	accountutils.ReadDiscriminator(r, GasPaymentDiscriminator)
	p.SequenceNumber = r.U64()
	p.Igp = r.Bytes32()
	p.DestinationDomain = r.U32()
	p.MessageID = r.Bytes32()
	p.GasAmount = r.U64()
	p.Payment = r.U64()
	p.UniqueGasPaymentPubkey = r.Bytes32()
	p.Slot = r.U64()
}

func (p *GasPaymentData) Size() int {
	return accountutils.DiscriminatorLength + 8 + 32 + 4 + 32 + 8 + 8 + 32 + 8
}

// IgpStandingQuote is accounts::IgpStandingQuote, stored as
// AccountData<DiscriminatorPrefixed<IgpStandingQuote>>.
type IgpStandingQuote struct {
	BumpSeed          uint8
	FeeTokenMint      Pubkey
	DestinationDomain uint32
	Sender            Pubkey
	TokenExchangeRate U128
	GasPrice          U128
	TokenDecimals     uint8
	IssuedAt          int64
	Expiry            int64
}

func (q *IgpStandingQuote) EncodeBorsh(w *borsh.Writer) {
	accountutils.WriteDiscriminator(w, IgpStandingQuoteDiscriminator)
	w.U8(q.BumpSeed)
	w.Bytes32(q.FeeTokenMint)
	w.U32(q.DestinationDomain)
	w.Bytes32(q.Sender)
	w.U128(q.TokenExchangeRate)
	w.U128(q.GasPrice)
	w.U8(q.TokenDecimals)
	w.I64(q.IssuedAt)
	w.I64(q.Expiry)
}

func (q *IgpStandingQuote) DecodeBorsh(r *borsh.Reader) {
	accountutils.ReadDiscriminator(r, IgpStandingQuoteDiscriminator)
	q.BumpSeed = r.U8()
	q.FeeTokenMint = r.Bytes32()
	q.DestinationDomain = r.U32()
	q.Sender = r.Bytes32()
	q.TokenExchangeRate = r.U128()
	q.GasPrice = r.U128()
	q.TokenDecimals = r.U8()
	q.IssuedAt = r.I64()
	q.Expiry = r.I64()
}

func (q *IgpStandingQuote) Size() int {
	return accountutils.DiscriminatorLength + 1 + 32 + 4 + 32 + 16 + 16 + 1 + 8 + 8
}

// IgpTransientQuote is accounts::IgpTransientQuote, stored as
// AccountData<DiscriminatorPrefixed<IgpTransientQuote>>.
type IgpTransientQuote struct {
	BumpSeed          uint8
	Payer             Pubkey
	ScopedSalt        H256
	FeeTokenMint      Pubkey
	DestinationDomain uint32
	Sender            Pubkey
	TokenExchangeRate U128
	GasPrice          U128
	TokenDecimals     uint8
	Expiry            int64
}

func (q *IgpTransientQuote) EncodeBorsh(w *borsh.Writer) {
	accountutils.WriteDiscriminator(w, IgpTransientQuoteDiscriminator)
	w.U8(q.BumpSeed)
	w.Bytes32(q.Payer)
	w.Bytes32(q.ScopedSalt)
	w.Bytes32(q.FeeTokenMint)
	w.U32(q.DestinationDomain)
	w.Bytes32(q.Sender)
	w.U128(q.TokenExchangeRate)
	w.U128(q.GasPrice)
	w.U8(q.TokenDecimals)
	w.I64(q.Expiry)
}

func (q *IgpTransientQuote) DecodeBorsh(r *borsh.Reader) {
	accountutils.ReadDiscriminator(r, IgpTransientQuoteDiscriminator)
	q.BumpSeed = r.U8()
	q.Payer = r.Bytes32()
	q.ScopedSalt = r.Bytes32()
	q.FeeTokenMint = r.Bytes32()
	q.DestinationDomain = r.U32()
	q.Sender = r.Bytes32()
	q.TokenExchangeRate = r.U128()
	q.GasPrice = r.U128()
	q.TokenDecimals = r.U8()
	q.Expiry = r.I64()
}

func (q *IgpTransientQuote) Size() int {
	return accountutils.DiscriminatorLength + 1 + 32 + 32 + 32 + 4 + 32 + 16 + 16 + 1 + 8
}

// IgpQuoteContext is accounts::IgpQuoteContext, parsed from signed quote
// context bytes: [0:32] fee_token_mint | [32:36] domain (u32 LE) | [36:68] sender.
type IgpQuoteContext struct {
	FeeTokenMint      Pubkey
	DestinationDomain uint32
	Sender            Pubkey
}

// ParseIgpQuoteContext is IgpQuoteContext::try_from.
func ParseIgpQuoteContext(b []byte) (IgpQuoteContext, uint64) {
	var ctx IgpQuoteContext
	if len(b) != IgpQuoteContextSize {
		return ctx, ErrInvalidIgpQuoteContext
	}
	copy(ctx.FeeTokenMint[:], b[0:32])
	ctx.DestinationDomain = uint32(b[32]) | uint32(b[33])<<8 | uint32(b[34])<<16 | uint32(b[35])<<24
	copy(ctx.Sender[:], b[36:68])
	return ctx, svm.Success
}

// IgpQuoteData is accounts::IgpQuoteData, parsed from signed quote data bytes:
// [0:16] token_exchange_rate (u128 LE) | [16:32] gas_price | [32] decimals.
type IgpQuoteData struct {
	TokenExchangeRate U128
	GasPrice          U128
	TokenDecimals     uint8
}

// ParseIgpQuoteData is IgpQuoteData::try_from.
func ParseIgpQuoteData(b []byte) (IgpQuoteData, uint64) {
	var d IgpQuoteData
	if len(b) != IgpQuoteDataSize {
		return d, ErrInvalidIgpQuoteData
	}
	r := borsh.NewReader(b)
	d.TokenExchangeRate = r.U128()
	d.GasPrice = r.U128()
	d.TokenDecimals = r.U8()
	return d, svm.Success
}
