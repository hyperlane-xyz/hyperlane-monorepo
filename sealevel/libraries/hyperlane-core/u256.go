package hyperlanecore

import "math/bits"

// U256 arithmetic with the semantics of the Rust `uint` crate's U256 that
// hyperlane-core re-exports: checked_* return ok=false where Rust returns
// None.

// U256FromU128 widens a u128 given as (lo, hi) limbs.
func U256FromU128(lo, hi uint64) U256 { return U256{lo, hi, 0, 0} }

// U256IsZero reports whether v is zero.
func U256IsZero(v *U256) bool { return v[0]|v[1]|v[2]|v[3] == 0 }

// U256Uint64 is u64::try_from(v): ok is false when v does not fit.
func U256Uint64(v *U256) (uint64, bool) {
	return v[0], v[1]|v[2]|v[3] == 0
}

// U256CheckedMul is U256::checked_mul: ok is false when a*b >= 2^256.
func U256CheckedMul(a, b *U256) (U256, bool) {
	var out U256
	overflow := false
	for i := 0; i < 4; i++ {
		if a[i] == 0 {
			continue
		}
		var carry uint64
		for j := 0; j < 4; j++ {
			hi, lo := bits.Mul64(a[i], b[j])
			if i+j >= 4 {
				if hi|lo != 0 {
					overflow = true
				}
				continue
			}
			var c uint64
			lo, c = bits.Add64(lo, carry, 0)
			hi += c
			out[i+j], c = bits.Add64(out[i+j], lo, 0)
			hi += c
			carry = hi
		}
		if carry != 0 {
			// The carry out of limb 3 is past the top.
			overflow = true
		}
	}
	return out, !overflow
}

// U256CheckedMulU64 is checked_mul by a u64 factor.
func U256CheckedMulU64(a *U256, m uint64) (U256, bool) {
	var out U256
	var carry uint64
	for i := 0; i < 4; i++ {
		hi, lo := bits.Mul64(a[i], m)
		var c uint64
		out[i], c = bits.Add64(lo, carry, 0)
		carry = hi + c
	}
	return out, carry == 0
}

// U256DivU64 is floor(a / d) for d != 0 (d == 0 traps, like Rust's panic).
func U256DivU64(a *U256, d uint64) U256 {
	var out U256
	var rem uint64
	for i := 3; i >= 0; i-- {
		out[i], rem = bits.Div64(rem, a[i], d)
	}
	return out
}

// pow10u64[k] = 10^k for k <= 19.
var pow10u64 = [20]uint64{
	1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000,
	10000000000, 100000000000, 1000000000000, 10000000000000, 100000000000000,
	1000000000000000, 10000000000000000, 100000000000000000, 1000000000000000000,
	10000000000000000000,
}

// U256MaxPow10 is the largest k with 10^k < 2^256, so U256::from(10)
// .checked_pow(k) is None exactly when k > U256MaxPow10.
const U256MaxPow10 = 77

// U256DivPow10 is floor(a / 10^k) for k <= U256MaxPow10, as successive u64
// divisions (floor(floor(a/x)/y) = floor(a/(x*y))).
func U256DivPow10(a *U256, k uint32) U256 {
	out := *a
	for k > 19 {
		out = U256DivU64(&out, pow10u64[19])
		k -= 19
	}
	return U256DivU64(&out, pow10u64[k])
}

// U256CheckedMulPow10 is a.checked_mul(10^k) for k <= U256MaxPow10. Chunked
// u64 multiplications overflow exactly when the single product does, because
// every chunk is >= 1.
func U256CheckedMulPow10(a *U256, k uint32) (U256, bool) {
	out := *a
	for k > 19 {
		var ok bool
		if out, ok = U256CheckedMulU64(&out, pow10u64[19]); !ok {
			return out, false
		}
		k -= 19
	}
	return U256CheckedMulU64(&out, pow10u64[k])
}
