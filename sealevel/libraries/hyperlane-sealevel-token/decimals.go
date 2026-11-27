package tokenlib

import (
	"math/bits"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
)

// maxPow10 is the largest k with 10^k < 2^256: U256::checked_pow(10, k) is
// None above it.
const maxPow10 = 77

// pow10Chunk is the largest power of ten that fits a u64 (10^19).
const pow10Chunk = 19

func pow10(k uint8) uint64 {
	p := uint64(1)
	for i := uint8(0); i < k; i++ {
		p *= 10
	}
	return p
}

func divSmall(a borsh.U256, d uint64) borsh.U256 {
	var q borsh.U256
	rem := uint64(0)
	for i := 3; i >= 0; i-- {
		q[i], rem = bits.Div64(rem, a[i], d)
	}
	return q
}

func mulSmall(a borsh.U256, m uint64) (borsh.U256, bool) {
	var out borsh.U256
	carry := uint64(0)
	for i := 0; i < 4; i++ {
		hi, lo := bits.Mul64(a[i], m)
		lo, c := bits.Add64(lo, carry, 0)
		out[i] = lo
		carry = hi + c
	}
	return out, carry == 0
}

// ConvertDecimals is accounts::convert_decimals: amount * 10^(to-from) or
// amount / 10^(from-to), false when the power or the product overflows U256.
// Division floors, so dividing in 10^19 chunks equals one division.
func ConvertDecimals(amount borsh.U256, from, to uint8) (borsh.U256, bool) {
	if from > to {
		k := from - to
		if k > maxPow10 {
			return borsh.U256{}, false
		}
		for k > 0 {
			step := k
			if step > pow10Chunk {
				step = pow10Chunk
			}
			amount = divSmall(amount, pow10(step))
			k -= step
		}
		return amount, true
	}
	if to > from {
		k := to - from
		if k > maxPow10 {
			return borsh.U256{}, false
		}
		for k > 0 {
			step := k
			if step > pow10Chunk {
				step = pow10Chunk
			}
			var ok bool
			amount, ok = mulSmall(amount, pow10(step))
			if !ok {
				return borsh.U256{}, false
			}
			k -= step
		}
	}
	return amount, true
}
