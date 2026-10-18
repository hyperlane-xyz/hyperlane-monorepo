package svm_test

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

func seq32(start byte) [32]byte {
	var b [32]byte
	for i := range b {
		b[i] = start + byte(i)
	}
	return b
}

func TestErrorCodesMatchRust(t *testing.T) {
	v := testvectors.Rust(t, "svm")
	codes := map[string]uint64{
		"InvalidArgument":                        svm.InvalidArgument,
		"InvalidInstructionData":                 svm.InvalidInstructionData,
		"InvalidAccountData":                     svm.InvalidAccountData,
		"AccountDataTooSmall":                    svm.AccountDataTooSmall,
		"InsufficientFunds":                      svm.InsufficientFunds,
		"IncorrectProgramId":                     svm.IncorrectProgramID,
		"MissingRequiredSignature":               svm.MissingRequiredSignature,
		"AccountAlreadyInitialized":              svm.AccountAlreadyInitialized,
		"UninitializedAccount":                   svm.UninitializedAccount,
		"NotEnoughAccountKeys":                   svm.NotEnoughAccountKeys,
		"AccountBorrowFailed":                    svm.AccountBorrowFailed,
		"MaxSeedLengthExceeded":                  svm.MaxSeedLengthExceeded,
		"InvalidSeeds":                           svm.InvalidSeeds,
		"BorshIoError":                           svm.BorshIoError,
		"AccountNotRentExempt":                   svm.AccountNotRentExempt,
		"UnsupportedSysvar":                      svm.UnsupportedSysvar,
		"IllegalOwner":                           svm.IllegalOwner,
		"MaxAccountsDataAllocationsExceeded":     svm.MaxAccountsDataAllocationsExceeded,
		"InvalidRealloc":                         svm.InvalidRealloc,
		"MaxInstructionTraceLengthExceeded":      svm.MaxInstructionTraceLengthExceeded,
		"BuiltinProgramsMustConsumeComputeUnits": svm.BuiltinProgramsMustConsumeCU,
		"InvalidAccountOwner":                    svm.InvalidAccountOwner,
		"ArithmeticOverflow":                     svm.ArithmeticOverflow,
		"Immutable":                              svm.Immutable,
		"IncorrectAuthority":                     svm.IncorrectAuthority,
		"Custom0":                                svm.Custom(0),
		"Custom69420":                            svm.Custom(69420),
	}
	for name, code := range codes {
		vec, ok := v["error_"+name]
		if !ok {
			t.Errorf("no Rust vector for %s", name)
			continue
		}
		if want := binary.LittleEndian.Uint64(vec.Bytes(t)); code != want {
			t.Errorf("%s = %#x, Rust %#x", name, code, want)
		}
	}
}

func TestSystemInstructionData(t *testing.T) {
	v := testvectors.Rust(t, "svm")
	create := svm.CreateAccountData(904_800, 2, seq32(3))
	transfer := svm.TransferData(^uint64(0))
	allocate := svm.AllocateData(10_240)
	assign := svm.AssignData(seq32(3))
	for name, got := range map[string][]byte{
		"system_create_account": create[:],
		"system_transfer":       transfer[:],
		"system_allocate":       allocate[:],
		"system_assign":         assign[:],
	} {
		if want := v[name].Bytes(t); !bytes.Equal(got, want) {
			t.Errorf("%s = %x, Rust %x", name, got, want)
		}
	}
}

func TestSeedsEncoding(t *testing.T) {
	s, code := svm.NewSeeds([][]byte{[]byte("ab"), {}, []byte("c")}, 7)
	if code != 0 {
		t.Fatal(code)
	}
	// One signer group: 4 seeds (3 + bump), each length-prefixed.
	if want := []byte{1, 4, 2, 'a', 'b', 0, 1, 'c', 1, 7}; !bytes.Equal(s.SignerBytes(), want) || s.Bump() != 7 {
		t.Fatalf("seeds %x", s.SignerBytes())
	}
	if _, code := svm.NewSeeds([][]byte{make([]byte, 33)}, 0); code != svm.MaxSeedLengthExceeded {
		t.Fatalf("long seed %#x", code)
	}
	if _, code := svm.NewSeeds(make([][]byte, 16), 0); code != svm.MaxSeedLengthExceeded {
		t.Fatalf("too many seeds %#x", code)
	}
}
