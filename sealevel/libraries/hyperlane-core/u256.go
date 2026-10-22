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

// U256Cmp returns -1, 0 or 1 as a is less than, equal to or greater than b.
func U256Cmp(a, b *U256) int {
	for i := 3; i >= 0; i-- {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// U256CheckedAdd is U256::checked_add: ok is false on overflow.
func U256CheckedAdd(a, b *U256) (U256, bool) {
	var out U256
	var carry uint64
	for i := 0; i < 4; i++ {
		out[i], carry = bits.Add64(a[i], b[i], carry)
	}
	return out, carry == 0
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

// U256CheckedDiv is checked_div: ok is false when b is 0. The quotient is
// truncated, as in Rust.
func U256CheckedDiv(a, b *U256) (U256, bool) {
	if U256IsZero(b) {
		return U256{}, false
	}
	// Knuth's algorithm D (TAOCP 4.3.1) in base 2^32, as in Hacker's
	// Delight's divmnu.
	const base = uint64(1) << 32
	const mask = base - 1
	var u, v [8]uint32
	for i := 0; i < 4; i++ {
		u[2*i] = uint32(a[i])
		u[2*i+1] = uint32(a[i] >> 32)
		v[2*i] = uint32(b[i])
		v[2*i+1] = uint32(b[i] >> 32)
	}
	m := 8
	for m > 0 && u[m-1] == 0 {
		m--
	}
	n := 8
	for v[n-1] == 0 {
		n--
	}
	var q [8]uint32
	if m < n {
		return U256{}, true
	}
	if n == 1 {
		d := uint64(v[0])
		rem := uint64(0)
		for j := m - 1; j >= 0; j-- {
			cur := rem<<32 | uint64(u[j])
			q[j] = uint32(cur / d)
			rem = cur % d
		}
		return digitsToU256(&q), true
	}
	// Normalize so the divisor's top digit has its high bit set.
	s := uint32(0)
	for top := v[n-1]; top&0x80000000 == 0; top <<= 1 {
		s++
	}
	var vn [8]uint32
	var un [9]uint32
	for i := n - 1; i > 0; i-- {
		vn[i] = v[i]<<s | uint32(uint64(v[i-1])>>(32-s))
	}
	vn[0] = v[0] << s
	un[m] = uint32(uint64(u[m-1]) >> (32 - s))
	for i := m - 1; i > 0; i-- {
		un[i] = u[i]<<s | uint32(uint64(u[i-1])>>(32-s))
	}
	un[0] = u[0] << s
	top := uint64(vn[n-1])
	next := uint64(vn[n-2])
	for j := m - n; j >= 0; j-- {
		num := uint64(un[j+n])<<32 | uint64(un[j+n-1])
		qhat := num / top
		rhat := num % top
		for {
			if qhat >= base || qhat*next > (rhat<<32|uint64(un[j+n-2])) {
				qhat--
				rhat += top
				if rhat < base {
					continue
				}
			}
			break
		}
		// Multiply and subtract qhat * vn from un[j .. j+n].
		borrow := uint64(0)
		carry := uint64(0)
		for i := 0; i < n; i++ {
			p := qhat*uint64(vn[i]) + carry
			carry = p >> 32
			sub := uint64(un[i+j]) - (p & mask) - borrow
			un[i+j] = uint32(sub)
			borrow = sub >> 63
		}
		sub := uint64(un[j+n]) - carry - borrow
		un[j+n] = uint32(sub)
		if sub>>63 != 0 {
			// qhat was one too large: add the divisor back.
			qhat--
			c := uint64(0)
			for i := 0; i < n; i++ {
				t := uint64(un[i+j]) + uint64(vn[i]) + c
				un[i+j] = uint32(t)
				c = t >> 32
			}
			un[j+n] = uint32(uint64(un[j+n]) + c)
		}
		q[j] = uint32(qhat)
	}
	return digitsToU256(&q), true
}

func digitsToU256(q *[8]uint32) U256 {
	var r U256
	for i := 0; i < 4; i++ {
		r[i] = uint64(q[2*i]) | uint64(q[2*i+1])<<32
	}
	return r
}
