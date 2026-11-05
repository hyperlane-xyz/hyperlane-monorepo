package quoteverifier_test

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/secp256k1test"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	qv "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/quote-verifier"
)

const group = "quote-verifier"

func key32(t *testing.T, name string) [32]byte {
	var k [32]byte
	copy(k[:], testvectors.Rust(t, group)[name].Bytes(t))
	return k
}

func decode(t *testing.T, name string) qv.SvmSignedQuote {
	b := testvectors.Rust(t, group)[name].Bytes(t)
	var q qv.SvmSignedQuote
	r := borsh.NewReader(b)
	q.DecodeBorsh(&r)
	if !r.Done() {
		t.Fatalf("%s: decode failed", name)
	}
	w := borsh.NewWriter(0)
	q.EncodeBorsh(&w)
	if !bytes.Equal(w.Bytes(), b) {
		t.Fatalf("%s: re-encode %x, Rust %x", name, w.Bytes(), b)
	}
	return q
}

func TestBorshTruncated(t *testing.T) {
	b := testvectors.Rust(t, group)["quote"].Bytes(t)
	for n := 0; n < len(b); n++ {
		var q qv.SvmSignedQuote
		r := borsh.NewReader(b[:n])
		q.DecodeBorsh(&r)
		if r.Ok() {
			t.Fatalf("prefix %d decoded", n)
		}
	}
}

func TestHashes(t *testing.T) {
	c := secp256k1test.Context(t, group)
	q := decode(t, "quote")
	fee, payer := key32(t, "fee_account"), key32(t, "payer")
	salt, code := q.ComputeScopedSalt(c, &payer)
	if code != 0 || salt != key32(t, "scoped_salt") || salt != key32(t, "keccak_payer_salt") {
		t.Fatalf("scoped salt %x (%d)", salt, code)
	}
	for _, tc := range []struct {
		q      qv.SvmSignedQuote
		domain uint32
		want   string
	}{
		{q, 42, "message_hash"},
		{q, 43, "message_hash_domain_43"},
		{decode(t, "quote_empty_vecs"), 42, "message_hash_empty_vecs"},
	} {
		h, code := tc.q.BuildMessageHash(c, &fee, tc.domain, &salt)
		if code != 0 || h != key32(t, tc.want) {
			t.Errorf("%s: %x (%d)", tc.want, h, code)
		}
	}
}

func TestVerifySigner(t *testing.T) {
	c := secp256k1test.Context(t, group)
	g := testvectors.Rust(t, group)
	q := decode(t, "quote")
	fee, payer, otherPayer := key32(t, "fee_account"), key32(t, "payer"), key32(t, "other_payer")
	var signer [20]byte
	copy(signer[:], g["signer"].Bytes(t))
	other := [20]byte{9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28}
	zero := q
	zero.Signature = [65]byte{}
	high := q
	for i := 32; i < 64; i++ {
		high.Signature[i] = 0xff
	}
	for _, tc := range []struct {
		name  string
		q     qv.SvmSignedQuote
		payer [32]byte
		set   [][20]byte
	}{
		{"ok", q, payer, [][20]byte{signer}},
		{"ok_two_signers", q, payer, [][20]byte{other, signer}},
		{"empty_set", q, payer, nil},
		{"unauthorized", q, payer, [][20]byte{other}},
		{"wrong_payer", q, otherPayer, [][20]byte{signer}},
		{"zero_signature", zero, payer, [][20]byte{signer}},
		{"high_s", high, payer, [][20]byte{signer}},
		{"empty_set_bad_signature", zero, payer, nil},
	} {
		want := uint64(binary.LittleEndian.Uint32(g["verify_"+tc.name].Bytes(t)))
		got, code := tc.q.VerifySigner(c, &fee, 42, &tc.payer, tc.set)
		if code != want {
			t.Errorf("%s: code %d, Rust %d", tc.name, code, want)
		}
		if code == 0 && got != signer {
			t.Errorf("%s: signer %x", tc.name, got)
		}
	}
}

func TestValidationGridMatchesRust(t *testing.T) {
	b := testvectors.Rust(t, group)["validation_grid"].Bytes(t)
	const row = 6 + 6 + 8 + 8 + 4 + 4
	if len(b) == 0 || len(b)%row != 0 {
		t.Fatalf("grid length %d", len(b))
	}
	for off := 0; off < len(b); off += row {
		var q qv.SvmSignedQuote
		copy(q.IssuedAt[:], b[off:off+6])
		copy(q.Expiry[:], b[off+6:off+12])
		min := int64(binary.LittleEndian.Uint64(b[off+12:]))
		now := int64(binary.LittleEndian.Uint64(b[off+20:]))
		consume := uint64(binary.LittleEndian.Uint32(b[off+28:]))
		submit := uint64(binary.LittleEndian.Uint32(b[off+32:]))
		if got := q.Validate(min, now); got != consume {
			t.Errorf("validate %x/%x min=%d now=%d: %d, Rust %d", q.IssuedAt, q.Expiry, min, now, got, consume)
		}
		if got := q.ValidateSubmission(min, now); got != submit {
			t.Errorf("submission %x/%x min=%d now=%d: %d, Rust %d", q.IssuedAt, q.Expiry, min, now, got, submit)
		}
	}
}

func TestTimestamps(t *testing.T) {
	q := qv.SvmSignedQuote{IssuedAt: [6]byte{0, 0, 0, 0, 1, 0}, Expiry: [6]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff}}
	if q.IssuedAtTimestamp() != 256 || q.ExpiryTimestamp() != 1<<48-1 || q.IsTransient() {
		t.Fatal(q.IssuedAtTimestamp(), q.ExpiryTimestamp())
	}
	q.Expiry = q.IssuedAt
	if !q.IsTransient() {
		t.Fatal("transient")
	}
}
