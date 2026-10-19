package hyperlanecore

// Checked U256 arithmetic, matching the uint crate's checked_* results that
// hyperlane-core's U256 exposes. No math/bits: products and quotients are
// built from 32-bit halves, which SBF multiplies and divides natively.

func mul64(x, y uint64) (hi, lo uint64) {
	const mask = 0xffffffff
	x0, x1 := x&mask, x>>32
	y0, y1 := y&mask, y>>32
	w0 := x0 * y0
	t := x1*y0 + w0>>32
	w1, w2 := t&mask, t>>32
	w1 = x0*y1 + w1
	return x1*y1 + w2 + w1>>32, x * y
}

func add64(x, y, carry uint64) (sum, carryOut uint64) {
	sum = x + y + carry
	carryOut = ((x & y) | ((x | y) &^ sum)) >> 63
	return sum, carryOut
}

// U256IsZero reports whether a is 0.
func U256IsZero(a U256) bool { return a[0]|a[1]|a[2]|a[3] == 0 }

// U256Cmp returns -1, 0 or 1 as a is less than, equal to or greater than b.
func U256Cmp(a, b U256) int {
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

// U256CheckedAdd is checked_add: ok is false on overflow.
func U256CheckedAdd(a, b U256) (U256, bool) {
	var r U256
	carry := uint64(0)
	for i := 0; i < 4; i++ {
		r[i], carry = add64(a[i], b[i], carry)
	}
	return r, carry == 0
}

// U256CheckedMul is checked_mul: ok is false on overflow.
func U256CheckedMul(a, b U256) (U256, bool) {
	var r U256
	for i := 0; i < 4; i++ {
		if a[i] == 0 {
			continue
		}
		carry := uint64(0)
		for j := 0; i+j < 4; j++ {
			hi, lo := mul64(a[i], b[j])
			s, c1 := add64(r[i+j], lo, 0)
			s, c2 := add64(s, carry, 0)
			r[i+j] = s
			carry = hi + c1 + c2
		}
		if carry != 0 {
			return U256{}, false
		}
		for j := 4 - i; j < 4; j++ {
			if b[j] != 0 {
				return U256{}, false
			}
		}
	}
	return r, true
}

// U256CheckedDiv is checked_div: ok is false when b is 0. The quotient is
// truncated, as in Rust.
func U256CheckedDiv(a, b U256) (U256, bool) {
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

// U256ToUint64 is try_into::<u64>: ok is false when a does not fit.
func U256ToUint64(a U256) (uint64, bool) {
	return a[0], a[1]|a[2]|a[3] == 0
}
