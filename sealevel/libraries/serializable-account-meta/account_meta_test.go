package accountmeta_test

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
)

func key(start byte) (k [32]byte) {
	for i := range k {
		k[i] = start + byte(i)
	}
	return
}

func TestVectors(t *testing.T) {
	v := testvectors.Rust(t, "interfaces")
	metas := []accountmeta.SerializableAccountMeta{accountmeta.Readonly(key(1), false), accountmeta.Writable(key(2), true)}
	want := v["simulation_return_data_metas"].Bytes(t)
	if got := accountmeta.EncodeMetasReturnData(metas); !bytes.Equal(got, want) {
		t.Fatalf("encode %x, Rust %x", got, want)
	}
	got, ok := accountmeta.DecodeMetasReturnData(want)
	if !ok || len(got) != 2 || got[0] != metas[0] || got[1] != metas[1] {
		t.Fatalf("decode %+v %v", got, ok)
	}
	if u32 := v["simulation_return_data_u32"].Bytes(t); !bytes.Equal(u32, []byte{0, 0, 0, 0, accountmeta.SimulationReturnDataTrailer}) {
		t.Fatalf("SimulationReturnData<u32> = %x", u32)
	}
}

func TestGoldens(t *testing.T) {
	g := testvectors.LoadGolden(t, "interfaces")
	for _, v := range g.Values {
		if v.Type != "interfaces.serializable_account_meta.SimulationReturnData<Vec<SerializableAccountMeta>>" {
			continue
		}
		b := testvectors.MustHex(t, v.Hex)
		metas, ok := accountmeta.DecodeMetasReturnData(b)
		if !ok || !bytes.Equal(accountmeta.EncodeMetasReturnData(metas), b) {
			t.Fatalf("round trip failed for %s", v.Hex)
		}
		var f struct {
			ReturnData []struct {
				Pubkey     string `json:"pubkey"`
				IsSigner   bool   `json:"is_signer"`
				IsWritable bool   `json:"is_writable"`
			} `json:"return_data"`
		}
		if err := json.Unmarshal(v.Fields, &f); err != nil {
			t.Fatal(err)
		}
		if len(f.ReturnData) != len(metas) {
			t.Fatalf("%d metas, golden %d", len(metas), len(f.ReturnData))
		}
		for i, m := range f.ReturnData {
			want := accountmeta.SerializableAccountMeta{Pubkey: testvectors.Base58Key(t, m.Pubkey), IsSigner: m.IsSigner, IsWritable: m.IsWritable}
			if metas[i] != want {
				t.Errorf("meta %d = %+v, golden %+v", i, metas[i], want)
			}
		}
		return
	}
	t.Fatal("no SimulationReturnData<Vec<SerializableAccountMeta>> in goldens")
}
