package fee

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

type (
	H160   = hyperlanecore.H160
	H256   = hyperlanecore.H256
	Pubkey = svm.Pubkey
)

// Account discriminators.
var (
	FeeAccountDiscriminator     = accountutils.Discriminator{'F', 'E', 'E', '_', 'A', 'C', 'C', 'T'}
	RouteDomainDiscriminator    = accountutils.Discriminator{'R', 'O', 'U', 'T', 'E', 'D', 'O', 'M'}
	CCRouteDiscriminator        = accountutils.Discriminator{'C', 'C', '_', 'R', 'O', 'U', 'T', 'E'}
	TransientQuoteDiscriminator = accountutils.Discriminator{'T', 'R', 'N', 'Q', 'U', 'O', 'T', 'E'}
	StandingQuoteDiscriminator  = accountutils.Discriminator{'S', 'T', 'D', 'Q', 'U', 'O', 'T', 'E'}
)

// Wildcards.
const (
	WildcardDomain uint32 = 0xffffffff
	WildcardAmount uint64 = 0xffffffffffffffff
)

// WildcardRecipient matches any recipient ([0xFF; 32]).
var WildcardRecipient = H256{
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
}

// DefaultRouter is keccak256("RoutingFee.DEFAULT_ROUTER"), the CC fallback
// target router.
var DefaultRouter = H256{
	0x6e, 0x08, 0x6c, 0xd6, 0x47, 0xd6, 0xeb, 0x8b, 0x51, 0x68, 0x56, 0x66, 0x6e, 0x2c, 0x14, 0x65,
	0xfb, 0x8a, 0x6a, 0x58, 0xd3, 0xa7, 0x59, 0x38, 0x36, 0x2a, 0xcc, 0x67, 0x4e, 0xac, 0xaf, 0x47,
}

var zeroH256 H256

// --- signer sets ---

// Signers is a BTreeSet<H160>: sorted, unique.
type Signers = []H160

// OptionSigners is Option<BTreeSet<H160>>.
type OptionSigners struct {
	Some  bool
	Value Signers
}

func writeSigners(w *borsh.Writer, s Signers) { borsh.WriteSet(w, s, borsh.WriteBytes20) }

func readSigners(r *borsh.Reader) Signers {
	s := borsh.ReadSet(r, borsh.ReadBytes20, borsh.Less20)
	if s == nil {
		return Signers{}
	}
	return s
}

func writeOptionSigners(w *borsh.Writer, o *OptionSigners) {
	w.OptionTag(o.Some)
	if o.Some {
		writeSigners(w, o.Value)
	}
}

func readOptionSigners(r *borsh.Reader) OptionSigners {
	var o OptionSigners
	if r.OptionTag() {
		o.Value = readSigners(r)
		o.Some = r.Ok()
	}
	return o
}

func signersSize(s Signers) int { return accountutils.BorshLenPrefix + len(s)*accountutils.H160Size }

func optionSignersSize(o *OptionSigners) int {
	if !o.Some {
		return 1
	}
	return 1 + signersSize(o.Value)
}

// containsSigner is BTreeSet::contains.
func containsSigner(s Signers, x *H160) bool {
	for i := range s {
		if s[i] == *x {
			return true
		}
	}
	return false
}

// insertSigner is BTreeSet::insert.
func insertSigner(s Signers, x H160) Signers {
	j := 0
	for j < len(s) && borsh.Less20(s[j], x) {
		j++
	}
	if j < len(s) && s[j] == x {
		return s
	}
	s = append(s, x)
	for k := len(s) - 1; k > j; k-- {
		s[k] = s[k-1]
	}
	s[j] = x
	return s
}

// removeSigner is BTreeSet::remove.
func removeSigner(s Signers, x *H160) Signers {
	for i := range s {
		if s[i] == *x {
			copy(s[i:], s[i+1:])
			return s[:len(s)-1]
		}
	}
	return s
}

// --- FeeData ---

// FeeData variants.
const (
	FeeDataLeaf                   uint8 = 0
	FeeDataRouting                uint8 = 1
	FeeDataCrossCollateralRouting uint8 = 2
)

// LeafFeeConfig is the Leaf variant's payload.
type LeafFeeConfig struct {
	Strategy FeeDataStrategy
	Signers  OptionSigners
}

// FeeData is the fee resolution mode. Leaf uses Leaf; Routing and
// CrossCollateralRouting use WildcardSigners. The zero value is
// Leaf(LeafFeeConfig::default()), Rust's Default.
type FeeData struct {
	Kind            uint8
	Leaf            LeafFeeConfig
	WildcardSigners Signers
}

func (f *FeeData) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(f.Kind)
	if f.Kind == FeeDataLeaf {
		f.Leaf.Strategy.EncodeBorsh(w)
		writeOptionSigners(w, &f.Leaf.Signers)
		return
	}
	writeSigners(w, f.WildcardSigners)
}

func (f *FeeData) DecodeBorsh(r *borsh.Reader) {
	f.Kind = r.EnumTag()
	switch f.Kind {
	case FeeDataLeaf:
		f.Leaf.Strategy.DecodeBorsh(r)
		f.Leaf.Signers = readOptionSigners(r)
	case FeeDataRouting, FeeDataCrossCollateralRouting:
		f.WildcardSigners = readSigners(r)
	default:
		r.Fail()
	}
}

func (f *FeeData) Size() int {
	if f.Kind == FeeDataLeaf {
		return 1 + FeeDataStrategySize + optionSignersSize(&f.Leaf.Signers)
	}
	return 1 + signersSize(f.WildcardSigners)
}

// --- FeeAccount ---

// FeeAccount is DiscriminatorPrefixed<FeeAccount>: its codec includes the
// FEE_ACCT discriminator.
type FeeAccount struct {
	BumpSeed    uint8
	Owner       accesscontrol.Owner
	Beneficiary Pubkey
	DomainID    uint32
	MinIssuedAt int64
	FeeData     FeeData
}

func (a *FeeAccount) EncodeBorsh(w *borsh.Writer) {
	accountutils.WriteDiscriminator(w, FeeAccountDiscriminator)
	w.U8(a.BumpSeed)
	w.OptionTag(a.Owner.Some)
	if a.Owner.Some {
		w.Bytes32(a.Owner.Value)
	}
	w.Bytes32(a.Beneficiary)
	w.U32(a.DomainID)
	w.I64(a.MinIssuedAt)
	a.FeeData.EncodeBorsh(w)
}

func (a *FeeAccount) DecodeBorsh(r *borsh.Reader) {
	accountutils.ReadDiscriminator(r, FeeAccountDiscriminator)
	a.BumpSeed = r.U8()
	if r.OptionTag() {
		a.Owner.Value = r.Bytes32()
		a.Owner.Some = r.Ok()
	}
	a.Beneficiary = r.Bytes32()
	a.DomainID = r.U32()
	a.MinIssuedAt = r.I64()
	a.FeeData.DecodeBorsh(r)
}

func (a *FeeAccount) Size() int {
	n := accountutils.DiscriminatorLength + 1 + 1
	if a.Owner.Some {
		n += accountutils.PubkeySize
	}
	return n + accountutils.PubkeySize + 4 + 8 + a.FeeData.Size()
}

// --- Route PDAs ---

// RouteConfig is the shared payload of RouteDomain and CrossCollateralRoute.
type RouteConfig struct {
	BumpSeed uint8
	FeeData  FeeDataStrategy
	Signers  OptionSigners
}

func (c *RouteConfig) encode(w *borsh.Writer, d accountutils.Discriminator) {
	accountutils.WriteDiscriminator(w, d)
	w.U8(c.BumpSeed)
	c.FeeData.EncodeBorsh(w)
	writeOptionSigners(w, &c.Signers)
}

func (c *RouteConfig) decode(r *borsh.Reader, d accountutils.Discriminator) {
	accountutils.ReadDiscriminator(r, d)
	c.BumpSeed = r.U8()
	c.FeeData.DecodeBorsh(r)
	c.Signers = readOptionSigners(r)
}

func (c *RouteConfig) size() int {
	return accountutils.DiscriminatorLength + 1 + FeeDataStrategySize + optionSignersSize(&c.Signers)
}

// RouteDomain is DiscriminatorPrefixed<RouteDomain> (ROUTEDOM).
type RouteDomain RouteConfig

func (c *RouteDomain) EncodeBorsh(w *borsh.Writer) {
	(*RouteConfig)(c).encode(w, RouteDomainDiscriminator)
}
func (c *RouteDomain) DecodeBorsh(r *borsh.Reader) {
	(*RouteConfig)(c).decode(r, RouteDomainDiscriminator)
}
func (c *RouteDomain) Size() int { return (*RouteConfig)(c).size() }

// CrossCollateralRoute is DiscriminatorPrefixed<CrossCollateralRoute> (CC_ROUTE).
type CrossCollateralRoute RouteConfig

func (c *CrossCollateralRoute) EncodeBorsh(w *borsh.Writer) {
	(*RouteConfig)(c).encode(w, CCRouteDiscriminator)
}
func (c *CrossCollateralRoute) DecodeBorsh(r *borsh.Reader) {
	(*RouteConfig)(c).decode(r, CCRouteDiscriminator)
}
func (c *CrossCollateralRoute) Size() int { return (*RouteConfig)(c).size() }

// --- TransientQuote ---

// TransientQuote is DiscriminatorPrefixed<TransientQuote> (TRNQUOTE).
type TransientQuote struct {
	BumpSeed   uint8
	Payer      Pubkey
	ScopedSalt H256
	Context    []byte
	Data       []byte
	Expiry     int64
}

func (q *TransientQuote) EncodeBorsh(w *borsh.Writer) {
	accountutils.WriteDiscriminator(w, TransientQuoteDiscriminator)
	w.U8(q.BumpSeed)
	w.Bytes32(q.Payer)
	w.Bytes32(q.ScopedSalt)
	w.ByteVec(q.Context)
	w.ByteVec(q.Data)
	w.I64(q.Expiry)
}

// DecodeBorsh aliases Context and Data into the input.
func (q *TransientQuote) DecodeBorsh(r *borsh.Reader) {
	accountutils.ReadDiscriminator(r, TransientQuoteDiscriminator)
	q.BumpSeed = r.U8()
	q.Payer = r.Bytes32()
	q.ScopedSalt = r.Bytes32()
	q.Context = r.ByteVecView()
	q.Data = r.ByteVecView()
	q.Expiry = r.I64()
}

func (q *TransientQuote) Size() int {
	return accountutils.DiscriminatorLength + 1 + 32 + 32 + 4 + len(q.Context) + 4 + len(q.Data) + 8
}

// --- Standing quotes ---

// FeeStandingQuoteValue is one standing quote.
type FeeStandingQuoteValue struct {
	IssuedAt int64
	Expiry   int64
	FeeData  FeeDataStrategy
}

// FeeStandingQuoteValueSize is SizedData::size.
const FeeStandingQuoteValueSize = 8 + 8 + FeeDataStrategySize

func writeStandingValue(w *borsh.Writer, v FeeStandingQuoteValue) {
	w.I64(v.IssuedAt)
	w.I64(v.Expiry)
	v.FeeData.EncodeBorsh(w)
}

func readStandingValue(r *borsh.Reader) FeeStandingQuoteValue {
	var v FeeStandingQuoteValue
	v.IssuedAt = r.I64()
	v.Expiry = r.I64()
	v.FeeData.DecodeBorsh(r)
	return v
}

// StandingQuoteEntry is one BTreeMap<H256, FeeStandingQuoteValue> entry.
type StandingQuoteEntry = borsh.Pair[H256, FeeStandingQuoteValue]

// FeeStandingQuotePda is DiscriminatorPrefixed<FeeStandingQuotePda>
// (STDQUOTE). Quotes are sorted by recipient.
type FeeStandingQuotePda struct {
	BumpSeed uint8
	Quotes   []StandingQuoteEntry
}

func (p *FeeStandingQuotePda) EncodeBorsh(w *borsh.Writer) {
	accountutils.WriteDiscriminator(w, StandingQuoteDiscriminator)
	w.U8(p.BumpSeed)
	borsh.WriteMap(w, p.Quotes, borsh.WriteBytes32, writeStandingValue)
}

func (p *FeeStandingQuotePda) DecodeBorsh(r *borsh.Reader) {
	accountutils.ReadDiscriminator(r, StandingQuoteDiscriminator)
	p.BumpSeed = r.U8()
	p.Quotes = borsh.ReadMap(r, borsh.ReadBytes32, readStandingValue, borsh.Less32)
}

func (p *FeeStandingQuotePda) Size() int {
	return accountutils.DiscriminatorLength + 1 + 4 + len(p.Quotes)*(32+FeeStandingQuoteValueSize)
}

// find is BTreeMap::get: the entry index, or -1.
func (p *FeeStandingQuotePda) find(key *H256) int {
	for i := range p.Quotes {
		if p.Quotes[i].Key == *key {
			return i
		}
	}
	return -1
}

// insert is BTreeMap::insert.
func (p *FeeStandingQuotePda) insert(key H256, v FeeStandingQuoteValue) {
	j := 0
	for j < len(p.Quotes) && borsh.Less32(p.Quotes[j].Key, key) {
		j++
	}
	if j < len(p.Quotes) && p.Quotes[j].Key == key {
		p.Quotes[j].Value = v
		return
	}
	p.Quotes = append(p.Quotes, StandingQuoteEntry{})
	for k := len(p.Quotes) - 1; k > j; k-- {
		p.Quotes[k] = p.Quotes[k-1]
	}
	p.Quotes[j] = StandingQuoteEntry{Key: key, Value: v}
}

// --- Quote contexts ---

// FeeQuoteContext is the 44-byte Leaf/Routing context.
type FeeQuoteContext struct {
	DestinationDomain uint32
	Recipient         H256
	Amount            uint64
	// TargetRouter is set only by the 76-byte CC context.
	TargetRouter H256
}

func le32(b []byte) uint32 {
	return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
}

func le64(b []byte) uint64 {
	v := uint64(0)
	for i := 0; i < 8; i++ {
		v |= uint64(b[i]) << (8 * uint64(i))
	}
	return v
}

// ParseQuoteContext is FeeQuoteContext::try_from_bytes (cc=false, 44 bytes)
// or CcFeeQuoteContext::try_from_bytes (cc=true, 76 bytes). A wrong length
// is InvalidInstructionData.
func ParseQuoteContext(b []byte, cc bool) (FeeQuoteContext, uint64) {
	var ctx FeeQuoteContext
	want := 44
	if cc {
		want = 76
	}
	if len(b) != want {
		return ctx, svm.InvalidInstructionData
	}
	ctx.DestinationDomain = le32(b[0:4])
	copy(ctx.Recipient[:], b[4:36])
	ctx.Amount = le64(b[36:44])
	if cc {
		copy(ctx.TargetRouter[:], b[44:76])
	}
	return ctx, svm.Success
}
