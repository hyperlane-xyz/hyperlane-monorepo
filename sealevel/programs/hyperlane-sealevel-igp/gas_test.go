package igp_test

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	igp "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/programs/hyperlane-sealevel-igp"
)

func le128(b []byte) borsh.U128 {
	return borsh.U128{Lo: binary.LittleEndian.Uint64(b), Hi: binary.LittleEndian.Uint64(b[8:])}
}

// compute_gas_fee against Rust over the overflow boundaries.
func TestComputeGasFeeMatchesRust(t *testing.T) {
	n, overflow := 0, 0
	for name, v := range testvectors.Rust(t, "igp") {
		if !strings.HasPrefix(name, "gas_fee_") {
			continue
		}
		b := v.Bytes(t)
		rate, price := le128(b[0:16]), le128(b[16:32])
		amount, decimals := binary.LittleEndian.Uint64(b[32:40]), b[40]
		want := binary.LittleEndian.Uint64(b[41:49])
		fee, code := igp.ComputeGasFee(rate, price, amount, decimals)
		if v.OK && (code != svm.Success || fee != want) {
			t.Errorf("%s: %d %#x, Rust %d", name, fee, code, want)
		}
		if !v.OK && code != want {
			t.Errorf("%s: %#x, Rust error %#x", name, code, want)
		}
		if !v.OK {
			overflow++
		}
		n++
	}
	if n < 700 || overflow == 0 || overflow == n {
		t.Fatalf("%d cases, %d errors", n, overflow)
	}
}

// Igp::deserialize_reader on stale gas_oracles tails (HLSVM-2026Q2-010).
func TestIgpStaleTailMatchesRust(t *testing.T) {
	v := testvectors.Rust(t, "igp")
	for _, name := range []string{"stale_tail_02", "stale_tail_01", "fee_config_stale_tail"} {
		// The vectors are borsh(Igp); the Go type includes the
		// DiscriminatorPrefixed prefix.
		data := append(igp.IgpDiscriminator[:], v["igp_"+name].Bytes(t)...)
		r := borsh.NewReader(data)
		var g igp.Igp
		g.DecodeBorsh(&r)
		if !r.Ok() {
			t.Fatalf("%s: decode failed", name)
		}
		w := borsh.NewWriter(len(data))
		g.EncodeBorsh(&w)
		if want := append(igp.IgpDiscriminator[:], v["igp_"+name+"_decoded"].Bytes(t)...); !bytes.Equal(w.Bytes(), want) {
			t.Errorf("%s:\n got %x\nwant %x", name, w.Bytes(), want)
		}
	}
}
