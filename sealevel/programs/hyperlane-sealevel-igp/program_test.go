package igp_test

import (
	"bytes"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	igp "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/programs/hyperlane-sealevel-igp"
	"gosvm/solana"
)

func run(data []byte) (uint64, []byte) {
	var ret []byte
	c := solana.Context{
		ID:              make([]byte, 32),
		InstructionData: data,
		WriteReturnData: func(b []byte) { ret = b },
	}
	return igp.Process(c), ret
}

func TestGetProgramVersion(t *testing.T) {
	code, ret := run([]byte{150, 230, 176, 162, 236, 96, 183, 171})
	if want := []byte{5, 0, 0, 0, '1', '.', '0', '.', '0', 0xff}; code != 0 || !bytes.Equal(ret, want) {
		t.Fatalf("%#x %x", code, ret)
	}
}

// Malformed instruction data is BorshIoError (try_from_slice through `?`).
func TestMalformedInstructionData(t *testing.T) {
	for _, data := range [][]byte{nil, {18}, {0, 0}, {150, 230, 176, 162, 236, 96, 183}} {
		if code, _ := run(data); code != svm.BorshIoError {
			t.Errorf("%x: %#x", data, code)
		}
	}
}
