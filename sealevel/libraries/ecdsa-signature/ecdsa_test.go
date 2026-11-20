package ecdsasignature_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/keccaktest"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/secp256k1test"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	ecdsa "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/ecdsa-signature"
)

const group = "ecdsa-signature"

func TestFromBytesMatchesRust(t *testing.T) {
	g := testvectors.Rust(t, group)
	n := 0
	for name, v := range g {
		if !strings.HasPrefix(name, "from_bytes_") || strings.HasSuffix(name, "_result") {
			continue
		}
		n++
		in := v.Bytes(t)
		want := g[name+"_result"].Bytes(t)
		s, code := ecdsa.FromBytes(in)
		if byte(code) != want[0] {
			t.Errorf("%s: code %d, Rust %d", name, code, want[0])
			continue
		}
		if (code == ecdsa.OK) != v.OK {
			t.Errorf("%s: ok mismatch", name)
		}
		if code != ecdsa.OK {
			continue
		}
		if s.RecoveryID != want[1] || !bytes.Equal(s.SerializedRS[:], in[:64]) {
			t.Errorf("%s: decoded %x/%d", name, s.SerializedRS, s.RecoveryID)
		}
		fixed := s.AsFixedBytes()
		if !bytes.Equal(fixed[:64], in[:64]) || fixed[64] != s.RecoveryID {
			t.Errorf("%s: as_fixed_bytes %x", name, fixed)
		}
	}
	if n < 10 {
		t.Fatalf("only %d from_bytes vectors", n)
	}
}

func TestEthSignedMessageHash(t *testing.T) {
	c := keccaktest.Context()
	for _, name := range []string{"eth_signed_zero", "eth_signed_seq", "eth_signed_f0f"} {
		b := testvectors.Rust(t, group)[name].Bytes(t)
		var in [32]byte
		copy(in[:], b[:32])
		out, code := ecdsa.EthSignedMessageHash(c, &in)
		if code != 0 || !bytes.Equal(out[:], b[32:]) {
			t.Errorf("%s: %x (%d), Rust %x", name, out, code, b[32:])
		}
	}
}

func TestRecoverEthereumAddress(t *testing.T) {
	c := secp256k1test.Context(t, group)
	e := secp256k1test.Entries(t, group)["lib_test"]
	s, code := ecdsa.FromBytes(e.Signature[:])
	if code != ecdsa.OK {
		t.Fatal(code)
	}
	address, status := s.RecoverEthereumAddress(c, e.Hash[:])
	if status != 0 || address != e.Address {
		t.Fatalf("recovered %x (%d), want %x", address, status, e.Address)
	}
	// Zero r and s never recover: the syscall's InvalidSignature (3).
	zero := ecdsa.EcdsaSignature{RecoveryID: 1}
	if _, status := zero.RecoverEthereumAddress(c, e.Hash[:]); status != 3 {
		t.Fatalf("zero signature status %d", status)
	}
	// Wrong hash length never reaches the syscall.
	if _, status := s.RecoverEthereumAddress(c, e.Hash[:31]); status != 2018 {
		t.Fatalf("short hash status %d", status)
	}
}
