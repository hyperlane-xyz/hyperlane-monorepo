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
