package ism_test

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

func seq(start byte, n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = start + byte(i)
	}
	return b
}

func key(start byte) (k [32]byte)  { copy(k[:], seq(start, 32)); return }
func h160(start byte) (k [20]byte) { copy(k[:], seq(start, 20)); return }

func TestInstructionVectors(t *testing.T) {
	v := testvectors.Rust(t, "interfaces")
	for name, ix := range map[string]ism.Instruction{
		"ism_type":                 {Kind: ism.KindType},
		"ism_verify":               {Kind: ism.KindVerify, Metadata: []byte{5, 4, 3, 2, 1}, Message: []byte{1, 2, 3, 4, 5}},
		"ism_verify_account_metas": {Kind: ism.KindVerifyAccountMetas, Metadata: []byte{}, Message: []byte{9}},
		"ism_verify_metadata_spec": {Kind: ism.KindVerifyMetadataSpec, Message: []byte{1, 2, 3}},
	} {
		want := v[name].Bytes(t)
		if got := ix.Encode(); !bytes.Equal(got, want) {
			t.Errorf("%s: encode %x, Rust %x", name, got, want)
		}
		got, code := ism.Decode(want)
		if code != 0 || got.Kind != ix.Kind || !bytes.Equal(got.Metadata, ix.Metadata) || !bytes.Equal(got.Message, ix.Message) {
			t.Errorf("%s: decode %+v %#x", name, got, code)
		}
	}
}

func TestDecodeErrors(t *testing.T) {
	verify := (&ism.Instruction{Kind: ism.KindVerify, Metadata: []byte{1}, Message: []byte{2}}).Encode()
	typ := (&ism.Instruction{Kind: ism.KindType}).Encode()
	for _, tc := range []struct {
		data []byte
		code uint64
	}{
		{nil, svm.InvalidInstructionData},
		{typ[:7], svm.InvalidInstructionData},
		{bytes.Repeat([]byte{9}, 8), svm.InvalidInstructionData},
		{verify[:len(verify)-1], svm.BorshIoError},
		{append(bytes.Clone(verify), 0), svm.BorshIoError},
		{append(bytes.Clone(typ), 1, 2, 3), 0},
	} {
		if _, code := ism.Decode(tc.data); code != tc.code {
			t.Errorf("Decode(%x) = %#x, want %#x", tc.data, code, tc.code)
		}
	}
}

func nestedResult() ism.MetadataSpecResult {
	return ism.MetadataSpecResult{
		Spec: borsh.SomeOf(ism.MetadataSpec{Kind: ism.SpecAggregation, Threshold: 2, SubSpecs: []ism.MetadataSpec{
			{Kind: ism.SpecNull},
			{Kind: ism.SpecAggregation, Threshold: 1, SubSpecs: []ism.MetadataSpec{
				{Kind: ism.SpecTrustedRelayer, Relayer: key(7)},
				{Kind: ism.SpecAggregation, Threshold: 0, SubSpecs: []ism.MetadataSpec{}},
			}},
			{Kind: ism.SpecMultisigMessageID, Validators: [][20]byte{h160(1), h160(2)}, Threshold: 2},
			{Kind: ism.SpecCannotVerify},
		}}),
		Accounts: [][32]byte{key(3)},
	}
}

func encodeResult(r *ism.MetadataSpecResult) []byte {
	w := borsh.NewWriter(0)
	r.EncodeBorsh(&w)
	return w.Bytes()
}

func TestMetadataSpecVectors(t *testing.T) {
	v := testvectors.Rust(t, "interfaces")
	nested := nestedResult()
	null := ism.MetadataSpecResult{Spec: borsh.SomeOf(ism.MetadataSpec{Kind: ism.SpecNull}), Accounts: [][32]byte{}}
	for name, want := range map[string]*ism.MetadataSpecResult{
		"metadata_spec_result_nested": &nested,
		"metadata_spec_result_null":   &null,
	} {
		b := v[name].Bytes(t)
		if got := encodeResult(want); !bytes.Equal(got, b) {
			t.Errorf("%s: encode %x, Rust %x", name, got, b)
		}
		r := borsh.NewReader(b)
		var got ism.MetadataSpecResult
		got.DecodeBorsh(&r)
		if !r.Done() || !reflect.DeepEqual(&got, want) {
			t.Errorf("%s: decode %+v", name, got)
		}
	}
	if got, want := ism.EncodeMetadataSpecReturnData(&ism.MetadataSpecResult{Spec: borsh.SomeOf(ism.MetadataSpec{Kind: ism.SpecNull})}), v["simulation_return_data_metadata_spec_null"].Bytes(t); !bytes.Equal(got, want) {
		t.Errorf("SimulationReturnData = %x, Rust %x", got, want)
	}
}

func TestMetadataSpecRejects(t *testing.T) {
	for _, b := range [][]byte{
		{1, 5},                // unknown variant
		{1, 2, 1, 2, 0, 0, 0}, // aggregation missing children
		{1, 2, 1, 0xff, 0xff, 0xff, 0x7f, 0},
		{2},
	} {
		r := borsh.NewReader(b)
		var got ism.MetadataSpecResult
		got.DecodeBorsh(&r)
		if r.Ok() && r.Done() {
			t.Errorf("%x accepted", b)
		}
	}
}

// specJSON renders a spec in the goldens' externally tagged form.
func specJSON(s *ism.MetadataSpec) any {
	switch s.Kind {
	case ism.SpecNull:
		return "Null"
	case ism.SpecCannotVerify:
		return "CannotVerify"
	case ism.SpecTrustedRelayer:
		return map[string]any{"TrustedRelayer": map[string]any{"relayer": s.Relayer}}
	case ism.SpecMultisigMessageID:
		vals := []any{}
		for _, v := range s.Validators {
			vals = append(vals, v)
		}
		return map[string]any{"MultisigMessageId": map[string]any{"validators": vals, "threshold": s.Threshold}}
	}
	subs := []any{}
	for i := range s.SubSpecs {
		subs = append(subs, specJSON(&s.SubSpecs[i]))
	}
	return map[string]any{"Aggregation": map[string]any{"threshold": s.Threshold, "sub_specs": subs}}
}

// TestGoldens checks every interface value in the shared goldens: Go decodes
// the bytes, re-encodes them identically, and agrees with the listed fields.
func TestGoldens(t *testing.T) {
	g := testvectors.LoadGolden(t, "interfaces")
	seen := 0
	for _, v := range g.Values {
		b := testvectors.MustHex(t, v.Hex)
		switch v.Type {
		case "interfaces.ism.InterchainSecurityModuleInstruction":
			seen++
			ix, code := ism.Decode(b)
			if code != 0 || !bytes.Equal(ix.Encode(), b) {
				t.Errorf("%s %s: decode %#x / re-encode mismatch", v.Type, *v.Variant, code)
				continue
			}
			var f struct{ Metadata, Message string }
			if len(v.Fields) > 0 && string(v.Fields) != "null" {
				if err := json.Unmarshal(v.Fields, &f); err != nil {
					t.Fatal(err)
				}
			}
			if f.Metadata != "" && !bytes.Equal(testvectors.MustHex(t, f.Metadata), ix.Metadata) ||
				f.Message != "" && !bytes.Equal(testvectors.MustHex(t, f.Message), ix.Message) {
				t.Errorf("%s: fields differ", *v.Variant)
			}
		case "interfaces.ism.MetadataSpecResult":
			seen++
			r := borsh.NewReader(b)
			var res ism.MetadataSpecResult
			res.DecodeBorsh(&r)
			if !r.Done() || !bytes.Equal(encodeResult(&res), b) {
				t.Errorf("MetadataSpecResult %s: round trip failed", v.Hex)
				continue
			}
			var spec any
			if res.Spec.Some {
				spec = specJSON(&res.Spec.Value)
			}
			accounts := []any{}
			for _, a := range res.Accounts {
				accounts = append(accounts, a)
			}
			got := normalize(t, map[string]any{"spec": spec, "accounts": accounts})
			want := normalizeRaw(t, v.Fields)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("MetadataSpecResult fields: Go %v, golden %v", got, want)
			}
		}
	}
	if seen == 0 {
		t.Fatal("no ISM values in goldens")
	}
	for _, p := range g.PDAs {
		if p.Name != "ism.VERIFY_ACCOUNT_METAS_PDA_SEEDS" {
			continue
		}
		if len(p.Seeds) != len(ism.VerifyAccountMetasPDASeeds) {
			t.Fatalf("seed count %d", len(p.Seeds))
		}
		for i, s := range p.Seeds {
			if !bytes.Equal(testvectors.MustHex(t, s), ism.VerifyAccountMetasPDASeeds[i]) {
				t.Errorf("seed %d = %s", i, s)
			}
		}
	}
}

// normalize converts Go values to the goldens' JSON conventions: byte arrays
// become 0x hex for H160 and base58 is avoided by comparing keys as hex.
func normalize(t *testing.T, v any) any {
	t.Helper()
	switch x := v.(type) {
	case [20]byte:
		return "0x" + hexs(x[:])
	case [32]byte:
		return "key:" + hexs(x[:])
	case uint8:
		return float64(x)
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			out[k] = normalize(t, e)
		}
		return out
	case []any:
		out := []any{}
		for _, e := range x {
			out = append(out, normalize(t, e))
		}
		return out
	}
	return v
}

// normalizeRaw parses golden fields, rewriting base58 Pubkeys (fields named
// relayer or accounts) to the same "key:" form.
func normalizeRaw(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	var walk func(any, string) any
	walk = func(v any, field string) any {
		switch x := v.(type) {
		case map[string]any:
			out := map[string]any{}
			for k, e := range x {
				out[k] = walk(e, k)
			}
			return out
		case []any:
			out := []any{}
			for _, e := range x {
				out = append(out, walk(e, field))
			}
			return out
		case string:
			if field == "relayer" || field == "accounts" {
				k := testvectors.Base58Key(t, x)
				return "key:" + hexs(k[:])
			}
		}
		return v
	}
	return walk(v, "")
}

func hexs(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, 2*len(b))
	for _, c := range b {
		out = append(out, digits[c>>4], digits[c&15])
	}
	return string(out)
}
