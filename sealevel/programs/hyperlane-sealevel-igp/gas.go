package igp

import (
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

// ComputeGasFee is accounts::compute_gas_fee:
// convert_decimals(gas_amount * gas_price * token_exchange_rate / 10^19,
// token_decimals, SOL_DECIMALS) as a u64, every overflow ArithmeticOverflow.
func ComputeGasFee(tokenExchangeRate, gasPrice U128, gasAmount uint64, tokenDecimals uint8) (uint64, uint64) {
	amount := hyperlanecore.U256FromUint64(gasAmount)
	price := hyperlanecore.U256FromU128(gasPrice.Lo, gasPrice.Hi)
	destCost, ok := hyperlanecore.U256CheckedMul(&amount, &price)
	if !ok {
		return 0, svm.ArithmeticOverflow
	}
	rate := hyperlanecore.U256FromU128(tokenExchangeRate.Lo, tokenExchangeRate.Hi)
	originCost, ok := hyperlanecore.U256CheckedMul(&destCost, &rate)
	if !ok {
		return 0, svm.ArithmeticOverflow
	}
	originCost = hyperlanecore.U256DivU64(&originCost, TokenExchangeRateScale)
	originCost, code := convertDecimals(&originCost, tokenDecimals, SolDecimals)
	if code != svm.Success {
		return 0, code
	}
	fee, ok := hyperlanecore.U256Uint64(&originCost)
	if !ok {
		return 0, svm.ArithmeticOverflow
	}
	return fee, svm.Success
}

// convertDecimals is accounts::convert_decimals. 10^k overflows U256 (Rust's
// checked_pow) for k > 77, whatever num is.
func convertDecimals(num *hyperlanecore.U256, from, to uint8) (hyperlanecore.U256, uint64) {
	switch {
	case from > to:
		k := uint32(from - to)
		if k > hyperlanecore.U256MaxPow10 {
			return hyperlanecore.U256{}, svm.ArithmeticOverflow
		}
		return hyperlanecore.U256DivPow10(num, k), svm.Success
	case from < to:
		k := uint32(to - from)
		if k > hyperlanecore.U256MaxPow10 {
			return hyperlanecore.U256{}, svm.ArithmeticOverflow
		}
		out, ok := hyperlanecore.U256CheckedMulPow10(num, k)
		if !ok {
			return out, svm.ArithmeticOverflow
		}
		return out, svm.Success
	}
	return *num, svm.Success
}
