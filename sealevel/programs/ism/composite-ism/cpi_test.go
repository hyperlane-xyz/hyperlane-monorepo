package compositeism

import (
	"bytes"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Fallback-ISM CPIs pass up to goSVM's 64 metas (Rust has no smaller bound).
func TestInvokeRangeUpToMaxCPIMetas(t *testing.T) {
	program := svm.Pubkey(bytes.Repeat([]byte{9}, 32))
	accounts := []solana.Account{{Key: program[:], Owner: make([]byte, 32), Executable: true}}
	for i := 0; i < svm.MaxCPIMetas+1; i++ {
		accounts = append(accounts, solana.Account{Key: bytes.Repeat([]byte{byte(i + 10)}, 32), Owner: make([]byte, 32), Writable: i%2 == 0})
	}
	var got int
	c := solana.Context{Accounts: accounts, InvokeInstruction: func(p uint64, metas, data, seeds []byte) uint64 {
		got = len(metas) / 9
		return 0
	}}
	for _, n := range []uint64{17, svm.MaxCPIMetas} {
		if code := invokeRange(c, &program, 1, 1+n, nil); code != 0 || got != int(n) {
			t.Fatalf("%d accounts: code %#x, %d metas", n, code, got)
		}
	}
	if code := invokeRange(c, &program, 1, 2+svm.MaxCPIMetas, nil); code != errCPIAccounts {
		t.Fatalf("65 accounts: code %#x", code)
	}
}
