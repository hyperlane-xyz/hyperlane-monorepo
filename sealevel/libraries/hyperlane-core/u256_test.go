package hyperlanecore

import (
	"math/big"
	"math/rand"
	"testing"
)

func toBig(a U256) *big.Int {
	b := new(big.Int)
	for i := 3; i >= 0; i-- {
		b.Lsh(b, 64)
		b.Or(b, new(big.Int).SetUint64(a[i]))
	}
	return b
}

func fromBig(b *big.Int) U256 {
	var a U256
	m := new(big.Int).SetUint64(^uint64(0))
	x := new(big.Int).Set(b)
	for i := 0; i < 4; i++ {
		a[i] = new(big.Int).And(x, m).Uint64()
		x.Rsh(x, 64)
	}
	return a
}

var max256 = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))

// randU256 picks values with random bit lengths and edge-heavy limbs so the
// division's normalization and add-back paths are exercised.
func randU256(r *rand.Rand) U256 {
	var a U256
	bitsLen := r.Intn(257)
	for i := 0; i < 4; i++ {
		switch r.Intn(4) {
		case 0:
			a[i] = ^uint64(0)
		case 1:
			a[i] = 0
		case 2:
			a[i] = 1 << uint(r.Intn(64))
		default:
			a[i] = r.Uint64()
		}
	}
	b := toBig(a)
	b.Rsh(b, uint(256-bitsLen))
	return fromBig(b)
}

func TestU256AgainstBig(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for n := 0; n < 200000; n++ {
		a, b := randU256(r), randU256(r)
		ba, bb := toBig(a), toBig(b)
		sum := new(big.Int).Add(ba, bb)
		if got, ok := U256CheckedAdd(a, b); ok != (sum.Cmp(max256) <= 0) || ok && toBig(got).Cmp(sum) != 0 {
			t.Fatalf("add %v %v = %v %v", ba, bb, toBig(got), ok)
		}
		prod := new(big.Int).Mul(ba, bb)
		if got, ok := U256CheckedMul(a, b); ok != (prod.Cmp(max256) <= 0) || ok && toBig(got).Cmp(prod) != 0 {
			t.Fatalf("mul %v %v = %v %v", ba, bb, toBig(got), ok)
		}
		got, ok := U256CheckedDiv(a, b)
		if bb.Sign() == 0 {
			if ok {
				t.Fatalf("div by zero ok")
			}
		} else if quo := new(big.Int).Quo(ba, bb); !ok || toBig(got).Cmp(quo) != 0 {
			t.Fatalf("div %v / %v = %v, want %v", ba, bb, toBig(got), quo)
		}
		if c := U256Cmp(a, b); c != ba.Cmp(bb) {
			t.Fatalf("cmp %v %v = %d", ba, bb, c)
		}
		if v, ok := U256ToUint64(a); ok != ba.IsUint64() || ok && v != ba.Uint64() {
			t.Fatalf("to u64 %v", ba)
		}
	}
}

func TestU256DivAddBack(t *testing.T) {
	// Knuth's add-back case (D6) in base 2^32: rare in random inputs.
	cases := [][2]*big.Int{}
	two := big.NewInt(2)
	for _, p := range []int{64, 96, 128, 160, 192} {
		a := new(big.Int).Lsh(big.NewInt(1), uint(p+63))
		b := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), uint(p)), big.NewInt(3))
		cases = append(cases, [2]*big.Int{a, b}, [2]*big.Int{new(big.Int).Sub(a, two), new(big.Int).Sub(b, two)})
	}
	// 0x7fff_ffff_8000_0000_0000_0000 style divisors from Hacker's Delight tests.
	hd, _ := new(big.Int).SetString("800000000000000000000000fffffffe", 16)
	hdv, _ := new(big.Int).SetString("800000000000000000000001", 16)
	cases = append(cases, [2]*big.Int{hd, hdv})
	for _, tc := range cases {
		got, ok := U256CheckedDiv(fromBig(tc[0]), fromBig(tc[1]))
		if want := new(big.Int).Quo(tc[0], tc[1]); !ok || toBig(got).Cmp(want) != 0 {
			t.Fatalf("%v / %v = %v, want %v", tc[0], tc[1], toBig(got), want)
		}
	}
}

func TestU256DivDigitEdges(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	digit := func() uint64 {
		switch r.Intn(6) {
		case 0:
			return 0
		case 1:
			return 0xffffffff
		case 2:
			return 0x80000000
		case 3:
			return 0x7fffffff
		case 4:
			return 1
		}
		return uint64(r.Uint32())
	}
	mk := func() U256 {
		var a U256
		n := r.Intn(9)
		for i := 0; i < n; i++ {
			a[i/2] |= digit() << (32 * uint(i%2))
		}
		return a
	}
	for n := 0; n < 300000; n++ {
		a, b := mk(), mk()
		if U256IsZero(b) {
			continue
		}
		got, ok := U256CheckedDiv(a, b)
		if want := new(big.Int).Quo(toBig(a), toBig(b)); !ok || toBig(got).Cmp(want) != 0 {
			t.Fatalf("%x / %x = %x, want %x", toBig(a), toBig(b), toBig(got), want)
		}
	}
}
