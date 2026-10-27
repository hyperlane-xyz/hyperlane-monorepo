package testism_test

import (
	"bytes"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	testism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/programs/ism/test-ism"
	"gosvm/solana"
)

var programID = testvectors.Base58Key(&testing.T{}, "CWVYdRomCv3bksSsRTuds9SRR5y17Ft5nPqhaXjp4tnb")

// storagePDA is find_program_address(["test_ism", "-", "storage"], program),
// bump 255 (from `solana find-program-derived-address`).
var storagePDA = testvectors.Base58Key(&testing.T{}, "5z3MupACjiDuWM8TV49cnc3ShGA1WtvGsNe36aSHDcaK")

func run(data []byte, accounts ...solana.Account) (uint64, []byte, solana.Context) {
	var ret []byte
	c := solana.Context{
		ID:              programID[:],
		InstructionData: data,
		Accounts:        accounts,
		WriteReturnData: func(b []byte) { ret = b },
		// Native stand-in for create_program_address: only the storage
		// seeds with bump 255 are "off curve".
		DeriveAddress: func(seeds, program, out []byte) uint64 {
			if bytes.Equal(seeds, append([]byte{4, 8}, []byte("test_ism\x01-\x07storage\x01\xff")...)) {
				copy(out, storagePDA[:])
				return 0
			}
			return 1
		},
	}
	code := testism.Process(c)
	return code, ret, c
}

func storage(data []byte, writable bool) solana.Account {
	return solana.Account{Key: storagePDA[:], Owner: programID[:], Data: data, Writable: writable}
}

func TestReturnData(t *testing.T) {
	typ := (&ism.Instruction{Kind: ism.KindType}).Encode()
	if code, ret, _ := run(typ); code != 0 || !bytes.Equal(ret, []byte{0, 0, 0, 0, 0xff}) {
		t.Fatalf("Type: %#x %x", code, ret)
	}
	vms := (&ism.Instruction{Kind: ism.KindVerifyMetadataSpec, Message: []byte{1}}).Encode()
	if code, ret, _ := run(vms); code != 0 || !bytes.Equal(ret, []byte{1, 0, 0, 0, 0, 0, 0xff}) {
		t.Fatalf("VerifyMetadataSpec: %#x %x", code, ret)
	}
	vam := (&ism.Instruction{Kind: ism.KindVerifyAccountMetas, Message: []byte{1}}).Encode()
	want := append(append([]byte{1, 0, 0, 0}, storagePDA[:]...), 0, 0, 0xff)
	if code, ret, _ := run(vam); code != 0 || !bytes.Equal(ret, want) {
		t.Fatalf("VerifyAccountMetas: %#x %x", code, ret)
	}
}

func TestVerifyAndSetAccept(t *testing.T) {
	verify := (&ism.Instruction{Kind: ism.KindVerify, Metadata: []byte{}, Message: []byte{1}}).Encode()
	for _, tc := range []struct {
		data []byte
		code uint64
	}{
		{[]byte{1, 1}, 0},
		{[]byte{1, 0}, testism.ErrVerifyNotAccepted},
		{nil, testism.ErrVerifyNotAccepted},
		{[]byte{2, 1}, svm.BorshIoError},
	} {
		if code, _, _ := run(verify, storage(tc.data, false)); code != tc.code {
			t.Errorf("verify %x = %#x, want %#x", tc.data, code, tc.code)
		}
	}
	if code, _, _ := run(verify); code != svm.NotEnoughAccountKeys {
		t.Errorf("verify without accounts = %#x", code)
	}

	code, _, c := run([]byte{1, 0}, storage([]byte{1, 1}, true))
	if code != 0 || !bytes.Equal(c.Accounts[0].Data, []byte{1, 0}) {
		t.Fatalf("set_accept(false) %#x %x", code, c.Accounts[0].Data)
	}
	if code, _, _ := run([]byte{1, 0}, storage([]byte{1, 1}, false)); code != svm.InvalidAccountData {
		t.Errorf("readonly set_accept = %#x", code)
	}
	if code, _, _ := run([]byte{1, 0}, storage(nil, true)); code != svm.BorshIoError {
		t.Errorf("empty set_accept = %#x", code)
	}
}

func TestInitAccountChecks(t *testing.T) {
	system := solana.Account{Key: make([]byte, 32), Owner: make([]byte, 32), Executable: true}
	payer := solana.Account{Key: bytes.Repeat([]byte{2}, 32), Owner: make([]byte, 32), Signer: true, Writable: true}
	wrong := solana.Account{Key: bytes.Repeat([]byte{9}, 32), Owner: make([]byte, 32)}
	unsigned := payer
	unsigned.Signer = false
	for _, tc := range []struct {
		name     string
		accounts []solana.Account
		code     uint64
	}{
		{"no accounts", nil, svm.NotEnoughAccountKeys},
		{"wrong system program", []solana.Account{wrong}, svm.InvalidArgument},
		{"missing payer", []solana.Account{system}, svm.NotEnoughAccountKeys},
		{"payer not signer", []solana.Account{system, unsigned, storage(nil, true)}, svm.MissingRequiredSignature},
		{"missing storage", []solana.Account{system, payer}, svm.NotEnoughAccountKeys},
		{"wrong storage", []solana.Account{system, payer, wrong}, svm.InvalidArgument},
	} {
		if code, _, _ := run([]byte{0}, tc.accounts...); code != tc.code {
			t.Errorf("%s: %#x, want %#x", tc.name, code, tc.code)
		}
	}
}

func TestInvalidInstructionData(t *testing.T) {
	verify := (&ism.Instruction{Kind: ism.KindVerify, Metadata: []byte{1}, Message: []byte{2}}).Encode()
	for _, data := range [][]byte{nil, {2}, {0, 0}, {1}, {1, 2}, {1, 1, 0}, bytes.Repeat([]byte{9}, 8), verify[:len(verify)-1]} {
		if code, _, _ := run(data, storage([]byte{1, 1}, true)); code != svm.InvalidInstructionData {
			t.Errorf("%x: %#x", data, code)
		}
	}
}
