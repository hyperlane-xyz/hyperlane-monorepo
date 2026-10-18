package system

import "gosvm/solana"

const ErrRent uint64 = 3020
const MaxDataLen uint64 = 10485760

// MinimumBalance reads the current Rent sysvar rather than assuming default rent.
func MinimumBalance(c solana.Context, size uint64) (uint64, uint64) {
	var rent [17]byte
	code := solana.Rent(c, rent[:])
	if code != 0 {
		return 0, code
	}
	rate, threshold := uint64(0), uint64(0)
	for j := uint64(0); j < 8; j++ {
		rate = rate | uint64(rent[j])<<(j*8)
		threshold = threshold | uint64(rent[8+j])<<(j*8)
	}
	return MinimumBalanceFor(rate, threshold, size)
}

func bitLength(n uint64) uint64 {
	length := uint64(0)
	for n != 0 {
		length++
		n = n >> 1
	}
	return length
}

// product is the unsigned two-limb multiplication from Go's math/bits Mul64.
// Copyright and BSD license attribution are retained in THIRD_PARTY_NOTICES.
func product(x, y uint64) (uint64, uint64) {
	mask := uint64(0xffffffff)
	x0, x1 := x&mask, x>>32
	y0, y1 := y&mask, y>>32
	w0 := x0 * y0
	t := x1*y0 + w0>>32
	w1, w2 := t&mask, t>>32
	w1 = x0*y1 + w1
	return x1*y1 + w2 + w1>>32, x * y
}

// MinimumBalanceFor matches the pinned solana-rent 3.0.0 minimum_balance's
// uint64 -> f64 conversion, f64 multiplication, and saturating uint64 cast.
// Integer bit operations reproduce the two round-to-nearest-even stages without
// floating-point runtime helpers on SBF. Unlike Rust's release-mode integer
// wrap, overflow in (128+size)*rate is an explicit error. Sizes over 10 MiB and
// negative/nonfinite thresholds are also rejected; signed zero is accepted.
func MinimumBalanceFor(rate, thresholdBits, size uint64) (uint64, uint64) {
	if size > MaxDataLen || rate > ^uint64(0)/(128+size) {
		return 0, ErrRent
	}
	exponent := thresholdBits >> 52 & 0x7ff
	mask := uint64(1)<<52 - 1
	fraction := thresholdBits & mask
	if exponent == 0x7ff || thresholdBits>>63 != 0 && (exponent != 0 || fraction != 0) {
		return 0, ErrRent
	}
	n := (128 + size) * rate
	if n == 0 || exponent == 0 && fraction == 0 {
		return 0, 0
	}
	shift := uint64(0)
	length := bitLength(n)
	if length > 53 {
		shift = length - 53
		m := n >> shift
		low := n & (uint64(1)<<shift - 1)
		half := uint64(1) << (shift - 1)
		if low > half || low == half && m&1 != 0 {
			m++
		}
		if m == uint64(1)<<53 {
			m = m >> 1
			shift++
		}
		n = m
	}
	mantissa := fraction
	if exponent == 0 {
		exponent = 1
	} else {
		mantissa = mantissa | uint64(1)<<52
	}
	hi, lo := product(n, mantissa)
	length = bitLength(lo)
	if hi != 0 {
		length = 64 + bitLength(hi)
	}
	if length > 53 {
		s := length - 53 // Product has at most 106 bits, so s <= 53.
		m := hi<<(64-s) | lo>>s
		low := lo & (uint64(1)<<s - 1)
		half := uint64(1) << (s - 1)
		if low > half || low == half && m&1 != 0 {
			m++
		}
		if m == uint64(1)<<53 {
			m = m >> 1
			s++
		}
		lo = m
		shift = shift + s
	}
	power := exponent + shift
	if power >= 1075 {
		s := power - 1075
		if s >= 64 || lo > ^uint64(0)>>s {
			return ^uint64(0), 0
		}
		return lo << s, 0
	}
	s := uint64(1075) - power
	if s >= 64 {
		return 0, 0
	}
	return lo >> s, 0
}
