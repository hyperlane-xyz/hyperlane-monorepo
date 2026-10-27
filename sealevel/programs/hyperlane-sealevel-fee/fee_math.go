package fee

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

// FeeParams are the fee curve parameters.
type FeeParams struct {
	MaxFee     uint64
	HalfAmount uint64
}

func (p *FeeParams) EncodeBorsh(w *borsh.Writer) {
	w.U64(p.MaxFee)
	w.U64(p.HalfAmount)
}

func (p *FeeParams) DecodeBorsh(r *borsh.Reader) {
	p.MaxFee = r.U64()
	p.HalfAmount = r.U64()
}

// FeeDataStrategy variants (Borsh enum indices).
const (
	StrategyLinear      uint8 = 0
	StrategyRegressive  uint8 = 1
	StrategyProgressive uint8 = 2
)

// FeeDataStrategy is the curve enum. Every variant wraps FeeParams, so it is
// a tag plus params. The zero value is Linear(0, 0), Rust's Default.
type FeeDataStrategy struct {
	Kind   uint8
	Params FeeParams
}

// FeeDataStrategySize is SizedData::size: tag + two u64.
const FeeDataStrategySize = 17

func (s *FeeDataStrategy) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(s.Kind)
	s.Params.EncodeBorsh(w)
}

func (s *FeeDataStrategy) DecodeBorsh(r *borsh.Reader) {
	s.Kind = r.EnumTag()
	if s.Kind > StrategyProgressive {
		r.Fail()
		return
	}
	s.Params.DecodeBorsh(r)
}

// DecodeStrategyBytes is FeeDataStrategy::try_from(&[u8]) (borsh::from_slice:
// every byte consumed). ok is false where Rust returns an error.
func DecodeStrategyBytes(b []byte) (FeeDataStrategy, bool) {
	var s FeeDataStrategy
	r := borsh.NewReader(b)
	s.DecodeBorsh(&r)
	return s, r.Done()
}

// ValidateParams rejects zero max_fee or half_amount.
func (s *FeeDataStrategy) ValidateParams() uint64 {
	if s.Params.MaxFee == 0 || s.Params.HalfAmount == 0 {
		return ErrZeroFeeParams
	}
	return svm.Success
}

// ComputeFee computes the fee for amount with U256 intermediates, rounding
// down. Zero max_fee or half_amount gives 0.
func (s *FeeDataStrategy) ComputeFee(amount uint64) (uint64, uint64) {
	maxFee := hyperlanecore.U256FromUint64(s.Params.MaxFee)
	half := hyperlanecore.U256FromUint64(s.Params.HalfAmount)
	amt := hyperlanecore.U256FromUint64(amount)
	switch s.Kind {
	case StrategyRegressive:
		return computeRegressive(maxFee, half, amt)
	case StrategyProgressive:
		return computeProgressive(maxFee, half, amt)
	}
	return computeLinear(maxFee, half, amt)
}

// computeLinear: fee = min(max_fee, amount * max_fee / (2 * half_amount)).
func computeLinear(maxFee, half, amount hyperlanecore.U256) (uint64, uint64) {
	if hyperlanecore.U256IsZero(&maxFee) || hyperlanecore.U256IsZero(&half) {
		return 0, svm.Success
	}
	denominator, ok := hyperlanecore.U256CheckedMulU64(&half, 2)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	product, ok := hyperlanecore.U256CheckedMul(&amount, &maxFee)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	fee, ok := hyperlanecore.U256CheckedDiv(&product, &denominator)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	if hyperlanecore.U256Cmp(&fee, &maxFee) > 0 {
		fee = maxFee
	}
	return toU64(fee)
}

// computeRegressive: fee = max_fee * amount / (half_amount + amount).
func computeRegressive(maxFee, half, amount hyperlanecore.U256) (uint64, uint64) {
	if hyperlanecore.U256IsZero(&maxFee) || hyperlanecore.U256IsZero(&half) {
		return 0, svm.Success
	}
	numerator, ok := hyperlanecore.U256CheckedMul(&maxFee, &amount)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	denominator, ok := hyperlanecore.U256CheckedAdd(&half, &amount)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	fee, ok := hyperlanecore.U256CheckedDiv(&numerator, &denominator)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	return toU64(fee)
}

// computeProgressive: fee = max_fee * amount^2 / (half_amount^2 + amount^2).
func computeProgressive(maxFee, half, amount hyperlanecore.U256) (uint64, uint64) {
	if hyperlanecore.U256IsZero(&maxFee) || hyperlanecore.U256IsZero(&half) {
		return 0, svm.Success
	}
	amountSq, ok := hyperlanecore.U256CheckedMul(&amount, &amount)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	halfSq, ok := hyperlanecore.U256CheckedMul(&half, &half)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	denominator, ok := hyperlanecore.U256CheckedAdd(&halfSq, &amountSq)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	if hyperlanecore.U256IsZero(&denominator) {
		return 0, svm.Success
	}
	numerator, ok := hyperlanecore.U256CheckedMul(&maxFee, &amountSq)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	fee, ok := hyperlanecore.U256CheckedDiv(&numerator, &denominator)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	return toU64(fee)
}

func toU64(v hyperlanecore.U256) (uint64, uint64) {
	x, ok := hyperlanecore.U256Uint64(&v)
	if !ok {
		return 0, ErrFeeComputationOverflow
	}
	return x, svm.Success
}
