package recipient_test

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	recipient "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/message-recipient-interface"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

func key(start byte) (k [32]byte) {
	for i := range k {
		k[i] = start + byte(i)
	}
	return
}

func equal(a, b recipient.Instruction) bool {
	return a.Kind == b.Kind && a.Handle.Origin == b.Handle.Origin && a.Handle.Sender == b.Handle.Sender && bytes.Equal(a.Handle.Message, b.Handle.Message)
}

func TestVectors(t *testing.T) {
	v := testvectors.Rust(t, "interfaces")
	for name, ix := range map[string]recipient.Instruction{
		"recipient_ism":               {Kind: recipient.KindInterchainSecurityModule},
		"recipient_ism_account_metas": {Kind: recipient.KindInterchainSecurityModuleAccountMetas},
		"recipient_handle": {Kind: recipient.KindHandle, Handle: recipient.HandleInstruction{
			Origin: 69, Sender: key(1), Message: []byte{1, 2, 3, 4, 5}}},
		"recipient_handle_account_metas": {Kind: recipient.KindHandleAccountMetas, Handle: recipient.HandleInstruction{
			Origin: ^uint32(0), Sender: key(2), Message: []byte{}}},
	} {
		want := v[name].Bytes(t)
		if got := ix.Encode(); !bytes.Equal(got, want) {
			t.Errorf("%s: encode %x, Rust %x", name, got, want)
		}
		if got, code := recipient.Decode(want); code != 0 || !equal(got, ix) {
			t.Errorf("%s: decode %+v %#x", name, got, code)
		}
	}
}

func TestDecodeErrors(t *testing.T) {
	handle := (&recipient.Instruction{Kind: recipient.KindHandle, Handle: recipient.HandleInstruction{Message: []byte{1}}}).Encode()
	for _, tc := range []struct {
		data []byte
		code uint64
	}{
		{handle[:7], svm.InvalidInstructionData},
		{bytes.Repeat([]byte{1}, 8), svm.InvalidInstructionData},
		{handle[:len(handle)-1], svm.BorshIoError},
		{append(bytes.Clone(handle), 0), svm.BorshIoError},
	} {
		if _, code := recipient.Decode(tc.data); code != tc.code {
			t.Errorf("Decode(%x) = %#x, want %#x", tc.data, code, tc.code)
		}
	}
}

func TestGoldens(t *testing.T) {
	g := testvectors.LoadGolden(t, "interfaces")
	seen := 0
	for _, v := range g.Values {
		if v.Type != "interfaces.message_recipient.MessageRecipientInstruction" {
			continue
		}
		seen++
		b := testvectors.MustHex(t, v.Hex)
		ix, code := recipient.Decode(b)
		if code != 0 || !bytes.Equal(ix.Encode(), b) {
			t.Errorf("%s: decode %#x / re-encode mismatch", *v.Variant, code)
			continue
		}
		if string(v.Fields) == "null" {
			continue
		}
		var f struct {
			Origin          uint32
			Sender, Message string
		}
		if err := json.Unmarshal(v.Fields, &f); err != nil {
			t.Fatal(err)
		}
		var sender [32]byte
		copy(sender[:], testvectors.MustHex(t, f.Sender))
		if ix.Handle.Origin != f.Origin || ix.Handle.Sender != sender || !bytes.Equal(ix.Handle.Message, testvectors.MustHex(t, f.Message)) {
			t.Errorf("%s: fields differ: %+v", *v.Variant, ix.Handle)
		}
	}
	if seen == 0 {
		t.Fatal("no recipient values in goldens")
	}
	seeds := map[string][][]byte{
		"message_recipient.INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS": recipient.InterchainSecurityModuleAccountMetasPDASeeds,
		"message_recipient.HANDLE_ACCOUNT_METAS_PDA_SEEDS":                     recipient.HandleAccountMetasPDASeeds,
	}
	for _, p := range g.PDAs {
		want, ok := seeds[p.Name]
		if !ok {
			continue
		}
		delete(seeds, p.Name)
		if len(p.Seeds) != len(want) {
			t.Fatalf("%s: %d seeds", p.Name, len(p.Seeds))
		}
		for i, s := range p.Seeds {
			if !bytes.Equal(testvectors.MustHex(t, s), want[i]) {
				t.Errorf("%s seed %d = %s", p.Name, i, s)
			}
		}
	}
	for name := range seeds {
		t.Errorf("golden has no PDA %s", name)
	}
}
