package fee

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
)

// Instruction enum indices (instruction.rs order).
const (
	IxInitFee                    uint8 = 0
	IxQuoteFee                   uint8 = 1
	IxSetRemoteFeeRoute          uint8 = 2
	IxRemoveRemoteFeeRoute       uint8 = 3
	IxUpdateFeeParams            uint8 = 4
	IxSetBeneficiary             uint8 = 5
	IxTransferOwnership          uint8 = 6
	IxSetQuoteSigner             uint8 = 7
	IxSetMinIssuedAt             uint8 = 8
	IxSetWildcardQuoteSigners    uint8 = 9
	IxSubmitQuote                uint8 = 10
	IxCloseTransientQuote        uint8 = 11
	IxPruneExpiredQuotes         uint8 = 12
	IxGetQuoteAccountMetas       uint8 = 13
	IxGetSubmitQuoteAccountMetas uint8 = 14
)

// InitFee is Instruction::InitFee's payload.
type InitFee struct {
	Salt        H256
	Beneficiary Pubkey
	FeeData     FeeData
	DomainID    uint32
}

func (x *InitFee) DecodeBorsh(r *borsh.Reader) {
	x.Salt = r.Bytes32()
	x.Beneficiary = r.Bytes32()
	x.FeeData.DecodeBorsh(r)
	x.DomainID = r.U32()
}

func (x *InitFee) EncodeBorsh(w *borsh.Writer) {
	w.Bytes32(x.Salt)
	w.Bytes32(x.Beneficiary)
	x.FeeData.EncodeBorsh(w)
	w.U32(x.DomainID)
}

// QuoteFee is Instruction::QuoteFee's payload.
type QuoteFee struct {
	DestinationDomain uint32
	Recipient         H256
	Amount            uint64
	TargetRouter      H256
}

func (x *QuoteFee) DecodeBorsh(r *borsh.Reader) {
	x.DestinationDomain = r.U32()
	x.Recipient = r.Bytes32()
	x.Amount = r.U64()
	x.TargetRouter = r.Bytes32()
}

func (x *QuoteFee) EncodeBorsh(w *borsh.Writer) {
	w.U32(x.DestinationDomain)
	w.Bytes32(x.Recipient)
	w.U64(x.Amount)
	w.Bytes32(x.TargetRouter)
}

// OptionH256 is Option<H256>.
type OptionH256 = borsh.Option[H256]

func readOptionH256(r *borsh.Reader) OptionH256 {
	var o OptionH256
	if r.OptionTag() {
		o.Value = r.Bytes32()
		o.Some = r.Ok()
	}
	return o
}

func writeOptionH256(w *borsh.Writer, o *OptionH256) {
	w.OptionTag(o.Some)
	if o.Some {
		w.Bytes32(o.Value)
	}
}

// SetRemoteFeeRoute is Instruction::SetRemoteFeeRoute's payload.
type SetRemoteFeeRoute struct {
	Domain       uint32
	TargetRouter OptionH256
	FeeData      FeeDataStrategy
	Signers      OptionSigners
}

func (x *SetRemoteFeeRoute) DecodeBorsh(r *borsh.Reader) {
	x.Domain = r.U32()
	x.TargetRouter = readOptionH256(r)
	x.FeeData.DecodeBorsh(r)
	x.Signers = readOptionSigners(r)
}

func (x *SetRemoteFeeRoute) EncodeBorsh(w *borsh.Writer) {
	w.U32(x.Domain)
	writeOptionH256(w, &x.TargetRouter)
	x.FeeData.EncodeBorsh(w)
	writeOptionSigners(w, &x.Signers)
}

// DomainRouter is RemoveRemoteFeeRoute and PruneExpiredQuotes's payload
// (domain, Option<target_router>).
type DomainRouter struct {
	Domain       uint32
	TargetRouter OptionH256
}

func (x *DomainRouter) DecodeBorsh(r *borsh.Reader) {
	x.Domain = r.U32()
	x.TargetRouter = readOptionH256(r)
}

func (x *DomainRouter) EncodeBorsh(w *borsh.Writer) {
	w.U32(x.Domain)
	writeOptionH256(w, &x.TargetRouter)
}

// RouteKey variants.
const (
	RouteKeyDomain          uint8 = 0
	RouteKeyCrossCollateral uint8 = 1
)

// RouteKey is RouteKey::Domain(Domain) or
// RouteKey::CrossCollateral{destination: Domain, target_router}.
type RouteKey struct {
	Kind         uint8
	Domain       uint32
	TargetRouter H256
}

// SetQuoteSigner is Instruction::SetQuoteSigner's payload.
type SetQuoteSigner struct {
	// Remove selects SetQuoteSignerOperation::Remove (else Add).
	Remove bool
	Signer H160
	Route  borsh.Option[RouteKey]
}

func (x *SetQuoteSigner) DecodeBorsh(r *borsh.Reader) {
	switch r.EnumTag() {
	case 0:
	case 1:
		x.Remove = true
	default:
		r.Fail()
		return
	}
	x.Signer = r.Bytes20()
	if r.OptionTag() {
		k := &x.Route.Value
		k.Kind = r.EnumTag()
		switch k.Kind {
		case RouteKeyDomain:
			k.Domain = r.U32()
		case RouteKeyCrossCollateral:
			k.Domain = r.U32()
			k.TargetRouter = r.Bytes32()
		default:
			r.Fail()
		}
		x.Route.Some = r.Ok()
	}
}

func (x *SetQuoteSigner) EncodeBorsh(w *borsh.Writer) {
	w.Bool(x.Remove)
	w.Bytes20(x.Signer)
	w.OptionTag(x.Route.Some)
	if x.Route.Some {
		w.EnumTag(x.Route.Value.Kind)
		w.U32(x.Route.Value.Domain)
		if x.Route.Value.Kind == RouteKeyCrossCollateral {
			w.Bytes32(x.Route.Value.TargetRouter)
		}
	}
}

// GetAccountMetas is GetQuoteAccountMetas and GetSubmitQuoteAccountMetas's
// payload.
type GetAccountMetas struct {
	DestinationDomain uint32
	TargetRouter      H256
	ScopedSalt        OptionH256
}

func (x *GetAccountMetas) DecodeBorsh(r *borsh.Reader) {
	x.DestinationDomain = r.U32()
	x.TargetRouter = r.Bytes32()
	x.ScopedSalt = readOptionH256(r)
}

func (x *GetAccountMetas) EncodeBorsh(w *borsh.Writer) {
	w.U32(x.DestinationDomain)
	w.Bytes32(x.TargetRouter)
	writeOptionH256(w, &x.ScopedSalt)
}
