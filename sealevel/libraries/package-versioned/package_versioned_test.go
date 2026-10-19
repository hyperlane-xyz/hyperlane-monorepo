package packageversioned_test

import (
	"bytes"
	"testing"

	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
)

func TestVersionReturnData(t *testing.T) {
	want := append([]byte{5, 0, 0, 0}, []byte("1.0.0\xff")...)
	if got := packageversioned.VersionReturnData(); !bytes.Equal(got, want) {
		t.Fatalf("version return data %x", got)
	}
	d := packageversioned.GetProgramVersionDiscriminator
	if !packageversioned.IsGetProgramVersion(d[:]) || packageversioned.IsGetProgramVersion(append(d[:], 0)) || packageversioned.IsGetProgramVersion(d[:7]) {
		t.Fatal("IsGetProgramVersion")
	}
}
