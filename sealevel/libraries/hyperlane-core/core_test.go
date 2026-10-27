package hyperlanecore_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
)

func seq32(start byte) (k [32]byte) {
	for i := range k {
		k[i] = start + byte(i)
	}
	return
}

func h256(t *testing.T, s string) (k [32]byte) {
	copy(k[:], testvectors.MustHex(t, s))
	return
}

// The repo's vectors/message.json message, encoded by Rust's to_vec.
func TestMessageVectors(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "vectors", "message.json"))
	if err != nil {
		t.Fatal(err)
	}
	var msgs []struct {
		Nonce, Version, Origin, Destination uint32
		Sender, Recipient                   string
		Body                                []byte
	}
	if err := json.Unmarshal(raw, &msgs); err != nil {
		t.Fatal(err)
	}
	v := testvectors.Rust(t, "hyperlane-core")
	j := msgs[0]
	m := hyperlanecore.HyperlaneMessage{
		Version: uint8(j.Version), Nonce: j.Nonce, Origin: j.Origin, Sender: h256(t, j.Sender),
		Destination: j.Destination, Recipient: h256(t, j.Recipient), Body: []byte{0x12, 0x34},
	}
	cases := map[string]hyperlanecore.HyperlaneMessage{
		"message_vectors_json": m,
		"message_empty_body": {Version: 3, Nonce: ^uint32(0), Origin: 0x01020304, Sender: seq32(1),
			Destination: 0xa0b0c0d0, Recipient: seq32(100), Body: []byte{}},
	}
	for name, msg := range cases {
		want := v[name].Bytes(t)
		if got := msg.Encode(); !bytes.Equal(got, want) {
			t.Errorf("%s: encode %x, Rust %x", name, got, want)
		}
		got, ok := hyperlanecore.DecodeMessage(want)
		if !ok || got.Version != msg.Version || got.Nonce != msg.Nonce || got.Origin != msg.Origin ||
			got.Sender != msg.Sender || got.Destination != msg.Destination || got.Recipient != msg.Recipient ||
			!bytes.Equal(got.Body, msg.Body) {
			t.Errorf("%s: decode %+v", name, got)
		}
	}
	if _, ok := hyperlanecore.DecodeMessage(make([]byte, 76)); ok {
		t.Error("76-byte message accepted")
	}
}

func TestTokenMessageVectors(t *testing.T) {
	v := testvectors.Rust(t, "hyperlane-core")
	max := hyperlanecore.U256{^uint64(0) - 1, ^uint64(0), ^uint64(0), ^uint64(0)}
	for name, tm := range map[string]hyperlanecore.TokenMessage{
		// 2^128 + 1
		"token_message":          {Recipient: seq32(1), AmountOrID: hyperlanecore.U256{1, 0, 1, 0}, Metadata: []byte{}},
		"token_message_metadata": {Recipient: seq32(2), AmountOrID: max, Metadata: []byte{9, 9}},
	} {
		want := v[name].Bytes(t)
		if got := tm.Encode(); !bytes.Equal(got, want) {
			t.Errorf("%s: encode %x, Rust %x", name, got, want)
		}
		got, ok := hyperlanecore.DecodeTokenMessage(want)
		if !ok || got.Recipient != tm.Recipient || got.AmountOrID != tm.AmountOrID || !bytes.Equal(got.Metadata, tm.Metadata) {
			t.Errorf("%s: decode %+v", name, got)
		}
	}
	if _, ok := hyperlanecore.DecodeTokenMessage(make([]byte, 63)); ok {
		t.Error("63-byte token message accepted")
	}
}

func TestU256BigEndian(t *testing.T) {
	b, _ := hex.DecodeString("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20")
	v := hyperlanecore.U256FromBigEndian(b)
	if v[3] != 0x0102030405060708 || v[0] != 0x191a1b1c1d1e1f20 {
		t.Fatalf("limbs %x", v)
	}
	if out := hyperlanecore.U256ToBigEndian(v); !bytes.Equal(out[:], b) {
		t.Fatalf("round trip %x", out)
	}
}
