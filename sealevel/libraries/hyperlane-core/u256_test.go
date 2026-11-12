package hyperlanecore_test

import (
	"math/big"
	"math/rand"
	"testing"

	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
)

var two256 = new(big.Int).Lsh(big.NewInt(1), 256)

func toBig(v hyperlanecore.U256) *big.Int {
	out := new(big.Int)
	for i := 3; i >= 0; i-- {
		out.Lsh(out, 64)
		out.Or(out, new(big.Int).SetUint64(v[i]))
	}
	return out
}

func fromBig(b *big.Int) hyperlanecore.U256 {
	var v hyperlanecore.U256
	x := new(big.Int).Set(b)
	mask := new(big.Int).SetUint64(^uint64(0))
	for i := 0; i < 4; i++ {
		v[i] = new(big.Int).And(x, mask).Uint64()
		x.Rsh(x, 64)
	}
	return v
}

// randU256 has a random number of significant limbs, so products land on
// both sides of 2^256.
func randU256(r *rand.Rand) hyperlanecore.U256 {
	var v hyperlanecore.U256
	n := r.Intn(5)
	for i := 0; i < n; i++ {
		v[i] = r.Uint64()
	}
	if n > 0 && r.Intn(4) == 0 {
		v[n-1] = ^uint64(0)
	}
	return v
}

func TestU256MatchesBigInt(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 20000; i++ {
		a, b := randU256(r), randU256(r)
		m := r.Uint64() >> uint(r.Intn(64))
		k := uint32(r.Intn(hyperlanecore.U256MaxPow10 + 1))
		ab, bb := toBig(a), toBig(b)

		got, ok := hyperlanecore.U256CheckedMul(&a, &b)
		want := new(big.Int).Mul(ab, bb)
		if wantOK := want.Cmp(two256) < 0; ok != wantOK || (ok && toBig(got).Cmp(want) != 0) {
			t.Fatalf("%v * %v = %v %v, want %v", ab, bb, toBig(got), ok, want)
		}

		got, ok = hyperlanecore.U256CheckedMulU64(&a, m)
		want = new(big.Int).Mul(ab, new(big.Int).SetUint64(m))
		if wantOK := want.Cmp(two256) < 0; ok != wantOK || (ok && toBig(got).Cmp(want) != 0) {
			t.Fatalf("%v * %d = %v %v", ab, m, toBig(got), ok)
		}

		if m != 0 {
			got = hyperlanecore.U256DivU64(&a, m)
			if want = new(big.Int).Quo(ab, new(big.Int).SetUint64(m)); toBig(got).Cmp(want) != 0 {
				t.Fatalf("%v / %d = %v, want %v", ab, m, toBig(got), want)
			}
		}

		p := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(k)), nil)
		got = hyperlanecore.U256DivPow10(&a, k)
		if want = new(big.Int).Quo(ab, p); toBig(got).Cmp(want) != 0 {
			t.Fatalf("%v / 10^%d = %v, want %v", ab, k, toBig(got), want)
		}
		got, ok = hyperlanecore.U256CheckedMulPow10(&a, k)
		want = new(big.Int).Mul(ab, p)
		if wantOK := want.Cmp(two256) < 0; ok != wantOK || (ok && toBig(got).Cmp(want) != 0) {
			t.Fatalf("%v * 10^%d = %v %v", ab, k, toBig(got), ok)
		}

		u, ok := hyperlanecore.U256Uint64(&a)
		if wantOK := ab.IsUint64(); ok != wantOK || (ok && u != ab.Uint64()) {
			t.Fatalf("u64(%v) = %d %v", ab, u, ok)
		}
		if hyperlanecore.U256IsZero(&a) != (ab.Sign() == 0) {
			t.Fatalf("is_zero(%v)", ab)
		}
	}
	// 10^77 < 2^256 < 10^78.
	p77 := new(big.Int).Exp(big.NewInt(10), big.NewInt(77), nil)
	if p77.Cmp(two256) >= 0 || new(big.Int).Mul(p77, big.NewInt(10)).Cmp(two256) < 0 {
		t.Fatal("U256MaxPow10")
	}
	one := fromBig(big.NewInt(1))
	if v, ok := hyperlanecore.U256CheckedMulPow10(&one, 77); !ok || toBig(v).Cmp(p77) != 0 {
		t.Fatal("10^77")
	}
}

var max256 = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))

// randU256Edges picks values with random bit lengths and edge-heavy limbs so the
// division's normalization and add-back paths are exercised.
func randU256Edges(r *rand.Rand) hyperlanecore.U256 {
	var a hyperlanecore.U256
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
		a, b := randU256Edges(r), randU256Edges(r)
		ba, bb := toBig(a), toBig(b)
		sum := new(big.Int).Add(ba, bb)
		if got, ok := hyperlanecore.U256CheckedAdd(&a, &b); ok != (sum.Cmp(max256) <= 0) || ok && toBig(got).Cmp(sum) != 0 {
			t.Fatalf("add %v %v = %v %v", ba, bb, toBig(got), ok)
		}
		prod := new(big.Int).Mul(ba, bb)
		if got, ok := hyperlanecore.U256CheckedMul(&a, &b); ok != (prod.Cmp(max256) <= 0) || ok && toBig(got).Cmp(prod) != 0 {
			t.Fatalf("mul %v %v = %v %v", ba, bb, toBig(got), ok)
		}
		got, ok := hyperlanecore.U256CheckedDiv(&a, &b)
		if bb.Sign() == 0 {
			if ok {
				t.Fatalf("div by zero ok")
			}
		} else if quo := new(big.Int).Quo(ba, bb); !ok || toBig(got).Cmp(quo) != 0 {
			t.Fatalf("div %v / %v = %v, want %v", ba, bb, toBig(got), quo)
		}
		if c := hyperlanecore.U256Cmp(&a, &b); c != ba.Cmp(bb) {
			t.Fatalf("cmp %v %v = %d", ba, bb, c)
		}
		if v, ok := hyperlanecore.U256Uint64(&a); ok != ba.IsUint64() || ok && v != ba.Uint64() {
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
		a, b := fromBig(tc[0]), fromBig(tc[1])
		got, ok := hyperlanecore.U256CheckedDiv(&a, &b)
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
	mk := func() hyperlanecore.U256 {
		var a hyperlanecore.U256
		n := r.Intn(9)
		for i := 0; i < n; i++ {
			a[i/2] |= digit() << (32 * uint(i%2))
		}
		return a
	}
	for n := 0; n < 300000; n++ {
		a, b := mk(), mk()
		if hyperlanecore.U256IsZero(&b) {
			continue
		}
		got, ok := hyperlanecore.U256CheckedDiv(&a, &b)
		if want := new(big.Int).Quo(toBig(a), toBig(b)); !ok || toBig(got).Cmp(want) != 0 {
			t.Fatalf("%x / %x = %x, want %x", toBig(a), toBig(b), toBig(got), want)
		}
	}
}
