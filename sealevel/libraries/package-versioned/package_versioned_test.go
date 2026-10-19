package packageversioned_test

import (
	"bytes"
	"testing"

	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	"gosvm/solana"
)

func TestGetProgramVersion(t *testing.T) {
	d := packageversioned.GetProgramVersionDiscriminator
	if !packageversioned.IsGetProgramVersion(d[:]) {
		t.Fatal("discriminator not recognised")
	}
	for _, b := range [][]byte{nil, d[:7], append(d[:8:8], 0), {150, 230, 176, 162, 236, 96, 183, 170}} {
		if packageversioned.IsGetProgramVersion(b) {
			t.Fatalf("%x recognised", b)
		}
	}
	var ret []byte
	c := solana.Context{WriteReturnData: func(b []byte) { ret = b }}
	if code := packageversioned.ProcessGetProgramVersion(c); code != 0 {
		t.Fatal(code)
	}
	// borsh(SimulationReturnData::new("1.0.0".to_string()))
	if want := []byte{5, 0, 0, 0, '1', '.', '0', '.', '0', 0xff}; !bytes.Equal(ret, want) {
		t.Fatalf("%x", ret)
	}
}
