package tokenlib_test

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

type call struct {
	program uint64
	metas   []byte
	data    []byte
}

// splContext has accounts 0..9 with key [i; 32] (account 9 is the program).
func splContext(calls *[]call) solana.Context {
	c := solana.Context{InvokeInstruction: func(program uint64, metas, data, signers []byte) uint64 {
		*calls = append(*calls, call{program, bytes.Clone(metas), bytes.Clone(data)})
		return 0
	}}
	for i := 0; i < 10; i++ {
		c.Accounts = append(c.Accounts, solana.Account{Key: bytes.Repeat([]byte{byte(i)}, 32), Executable: i == 9})
	}
	return c
}

// rustMetas re-expresses Rust's [pubkey is_signer is_writable] metas as
// goSVM's [index flags] with index = the key's byte.
func rustMetas(t *testing.T, b []byte) []byte {
	var out []byte
	for off := 0; off < len(b); off += 34 {
		idx := make([]byte, 8)
		binary.LittleEndian.PutUint64(idx, uint64(b[off]))
		flags := b[off+33]
		if b[off+32] == 1 {
			flags |= 2
		}
		out = append(append(out, idx...), flags)
	}
	return out
}

func TestSPLVectors(t *testing.T) {
	v := testvectors.Rust(t, "token")
	for name, id := range map[string]svm.Pubkey{
		"id_token_2022": tokenlib.SPLToken2022ProgramID, "id_token": tokenlib.SPLTokenProgramID,
		"id_ata": tokenlib.AssociatedTokenProgramID, "id_rent": tokenlib.RentSysvarID,
	} {
		if !bytes.Equal(v[name].Bytes(t), id[:]) {
			t.Errorf("%s = %x", name, id)
		}
	}
	var calls []call
	c := splContext(&calls)
	tokenlib.BurnCheckedWithSigner(c, 9, 1, 2, 4, 1_234_567_890, 9)
	tokenlib.TransferChecked(c, 9, 1, 2, 3, 4, ^uint64(0), 6, nil)
	tokenlib.TransferChecked(c, 9, 1, 2, 3, 4, 7, 0, nil)
	tokenlib.MintToChecked(c, 9, 2, 3, 2, 42, 18, nil)
	tokenlib.CreateAssociatedTokenAccountIdempotent(c, 9, 5, 7, 6, 2, 0, 8, nil)
	names := []string{"burn_checked_self_signer", "transfer_checked", "transfer_checked_classic", "mint_to_checked", "create_idempotent"}
	if len(calls) != len(names) {
		t.Fatalf("%d calls", len(calls))
	}
	for i, name := range names {
		if want := v[name].Bytes(t); !bytes.Equal(calls[i].data, want) {
			t.Errorf("%s data %x, Rust %x", name, calls[i].data, want)
		}
		want := rustMetas(t, v[name+"_metas"].Bytes(t))
		if name == "create_idempotent" {
			// Rust derives the ATA and lists System and Token-2022 by ID;
			// the Go CPI passes the accounts at indices 7, 0 and 8.
			want = rustMetas(t, v[name+"_metas"].Bytes(t))
			want[9] = 7
			want[36] = 0
			want[45] = 8
		}
		if !bytes.Equal(calls[i].metas, want) {
			t.Errorf("%s metas %x, Rust %x", name, calls[i].metas, want)
		}
	}
	if d := tokenlib.GetAccountDataSizeData(); !bytes.Equal(d[:], v["get_account_data_size"].Bytes(t)) {
		t.Errorf("get_account_data_size %x", d)
	}
	if d := tokenlib.InitializeAccountData(); !bytes.Equal(d[:], v["initialize_account"].Bytes(t)) {
		t.Errorf("initialize_account %x", d)
	}
}
