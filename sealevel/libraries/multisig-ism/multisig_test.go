package multisigism_test

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strings"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/secp256k1test"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	ecdsa "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/ecdsa-signature"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	multisigism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/multisig-ism"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

const group = "multisig-ism"

func vec(t *testing.T, name string) []byte {
	v, ok := testvectors.Rust(t, group)[name]
	if !ok {
		t.Fatalf("no vector %s", name)
	}
	return v.Bytes(t)
}

func b32(b []byte) [32]byte {
	var o [32]byte
	copy(o[:], b)
	return o
}

func validators(t *testing.T) [][20]byte {
	b := vec(t, "test_data_validators")
	out := make([][20]byte, len(b)/20)
	for i := range out {
		copy(out[i][:], b[20*i:])
	}
	return out
}

func signatures(t *testing.T, idx []byte) []ecdsa.EcdsaSignature {
	out := make([]ecdsa.EcdsaSignature, len(idx))
	for i, j := range idx {
		s, e := ecdsa.FromBytes(vec(t, fmt.Sprintf("test_data_signature_%d", j)))
		if e != ecdsa.OK {
			t.Fatal(e)
		}
		out[i] = s
	}
	return out
}

func TestCheckpointSigningHash(t *testing.T) {
	c := secp256k1test.Context(t, group)
	msg := vec(t, "test_data_message")
	var id [32]byte
	if code := hyperlanecore.MessageID(c, msg, 0, uint64(len(msg)), id[:]); code != 0 || id != b32(vec(t, "test_data_message_id")) {
		t.Fatalf("message id %x", id)
	}
	f := vec(t, "test_data_checkpoint_fields")
	hook, root, mid := b32(f[:32]), b32(f[36:68]), b32(f[72:104])
	h, code := multisigism.CheckpointSigningHash(c, &hook, binary.BigEndian.Uint32(f[32:]), &root, binary.BigEndian.Uint32(f[68:]), &mid)
	if code != 0 || h != b32(vec(t, "test_data_signing_hash")) {
		t.Fatalf("signing hash %x", h)
	}
	if mid != id {
		t.Fatal("checkpoint message id")
	}
}

func TestVerifyMatchesRust(t *testing.T) {
	c := secp256k1test.Context(t, group)
	f := vec(t, "test_data_checkpoint_fields")
	hook, root, mid := b32(f[:32]), b32(f[36:68]), b32(f[72:104])
	h, _ := multisigism.CheckpointSigningHash(c, &hook, binary.BigEndian.Uint32(f[32:]), &root, binary.BigEndian.Uint32(f[68:]), &mid)
	n := 0
	for name := range testvectors.Rust(t, group) {
		if !strings.HasPrefix(name, "verify_") || strings.HasSuffix(name, "_result") {
			continue
		}
		n++
		in := vec(t, name)
		want := vec(t, name+"_result")[0]
		e, code := multisigism.Verify(c, &h, signatures(t, in[:len(in)-1]), validators(t), in[len(in)-1])
		if code != 0 || byte(e) != want {
			t.Errorf("%s: %d (%d), Rust %d", name, e, code, want)
		}
	}
	if n < 8 {
		t.Fatalf("%d verify vectors", n)
	}
	// The same signatures over a different message ID recover other keys.
	other := vec(t, "test_data_message_nonce_420")
	var oid [32]byte
	hyperlanecore.MessageID(c, other, 0, uint64(len(other)), oid[:])
	oh, _ := multisigism.CheckpointSigningHash(c, &hook, binary.BigEndian.Uint32(f[32:]), &root, binary.BigEndian.Uint32(f[68:]), &oid)
	if e, _ := multisigism.Verify(c, &oh, signatures(t, []byte{0, 1}), validators(t), 2); e != multisigism.ErrThresholdNotMet {
		t.Fatalf("nonce 420: %d", e)
	}
}

func TestMetadata(t *testing.T) {
	for _, tc := range []struct {
		name string
		idx  []byte
	}{{"metadata_sigs_0_1", []byte{0, 1}}, {"metadata_sigs_0_2_3", []byte{0, 2, 3}}} {
		b := vec(t, tc.name)
		m, e := multisigism.ParseMessageIDMetadata(b)
		if e != multisigism.OK || len(m.Signatures) != len(tc.idx) {
			t.Fatalf("%s: %d", tc.name, e)
		}
		if !bytes.Equal(m.Encode(), b) {
			t.Fatalf("%s: re-encode", tc.name)
		}
		want := signatures(t, tc.idx)
		for i := range want {
			if m.Signatures[i] != want[i] {
				t.Fatalf("%s: signature %d", tc.name, i)
			}
		}
	}
	for name, v := range testvectors.Rust(t, group) {
		if !strings.HasPrefix(name, "metadata_reject_") {
			continue
		}
		if _, e := multisigism.ParseMessageIDMetadata(v.Bytes(t)); e != multisigism.ErrInvalidMetadata {
			t.Errorf("%s: %d", name, e)
		}
	}
}

func TestInstructions(t *testing.T) {
	for _, tc := range []struct {
		name string
		kind multisigism.InstructionKind
	}{
		{"ix_validators_and_threshold", multisigism.KindValidatorsAndThreshold},
		{"ix_validators_and_threshold_account_metas", multisigism.KindValidatorsAndThresholdAccountMetas},
	} {
		b := vec(t, tc.name)
		ix, code := multisigism.DecodeInstruction(b)
		if code != 0 || ix.Kind != tc.kind || !bytes.Equal(ix.Message, b[8:]) || !bytes.Equal(ix.Encode(), b) {
			t.Fatalf("%s: %+v %d", tc.name, ix, code)
		}
	}
	for _, b := range [][]byte{nil, {82, 96, 5, 220, 241, 173, 13}, make([]byte, 16)} {
		if _, code := multisigism.DecodeInstruction(b); code != svm.InvalidInstructionData {
			t.Fatalf("%x: %d", b, code)
		}
	}
	vt := vec(t, "validators_and_threshold")
	var v multisigism.ValidatorsAndThreshold
	r := borsh.NewReader(vt)
	v.DecodeBorsh(&r)
	w := borsh.NewWriter(0)
	v.EncodeBorsh(&w)
	if !r.Done() || !bytes.Equal(w.Bytes(), vt) || v.Size() != len(vt) || v.Threshold != 2 || len(v.Validators) != 3 {
		t.Fatalf("validators_and_threshold %+v", v)
	}
}

// Cross-check the interface goldens (gosvm/decouple-svm-types) when present.
func TestGoldens(t *testing.T) {
	g := testvectors.LoadGolden(t, "interfaces")
	n := 0
	for _, v := range g.Values {
		if !strings.HasPrefix(v.Type, "interfaces.multisig_ism.") {
			continue
		}
		n++
		b := testvectors.MustHex(t, v.Hex)
		switch v.Type {
		case "interfaces.multisig_ism.MultisigIsmInstruction":
			ix, code := multisigism.DecodeInstruction(b)
			if code != 0 || !bytes.Equal(ix.Encode(), b) {
				t.Errorf("%s %v", v.Type, *v.Variant)
			}
			want := map[string]multisigism.InstructionKind{
				"ValidatorsAndThreshold":             multisigism.KindValidatorsAndThreshold,
				"ValidatorsAndThresholdAccountMetas": multisigism.KindValidatorsAndThresholdAccountMetas,
			}[*v.Variant]
			if ix.Kind != want {
				t.Errorf("%s: kind %d", *v.Variant, ix.Kind)
			}
		case "interfaces.multisig_ism.ValidatorsAndThreshold":
			var x multisigism.ValidatorsAndThreshold
			r := borsh.NewReader(b)
			x.DecodeBorsh(&r)
			w := borsh.NewWriter(0)
			x.EncodeBorsh(&w)
			if !r.Done() || !bytes.Equal(w.Bytes(), b) {
				t.Errorf("%s", v.Type)
			}
		default:
			t.Errorf("unhandled golden %s", v.Type)
		}
	}
	for _, p := range g.PDAs {
		if p.Name != "multisig_ism.VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS" {
			continue
		}
		n++
		if len(p.Seeds) != len(multisigism.ValidatorsAndThresholdAccountMetasPDASeeds) {
			t.Fatal("seed count")
		}
		for i, s := range p.Seeds {
			if !bytes.Equal(testvectors.MustHex(t, s), multisigism.ValidatorsAndThresholdAccountMetasPDASeeds[i]) {
				t.Errorf("seed %d", i)
			}
		}
	}
	if n != 4 {
		t.Fatalf("checked %d multisig_ism goldens, want 4", n)
	}
}
