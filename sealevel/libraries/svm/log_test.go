package svm_test

import (
	"encoding/binary"
	"strings"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// logged runs f against a native context and returns its one log line.
func logged(t *testing.T, f func(c solana.Context)) string {
	t.Helper()
	var lines []string
	f(solana.Context{WriteLog: func(s string) { lines = append(lines, s) }})
	if len(lines) != 1 {
		t.Fatalf("%d lines: %q", len(lines), lines)
	}
	return lines[0]
}

func TestMsgFormatsMatchRust(t *testing.T) {
	vectors := testvectors.Rust(t, "log")
	checked := 0
	for name, v := range vectors {
		b := v.Bytes(t)
		var got string
		switch {
		case strings.HasPrefix(name, "pubkey_"):
			k := [32]byte(b)
			got = logged(t, func(c solana.Context) { m := svm.NewMsg(""); m.Pubkey(&k); m.Emit(c) })
		case strings.HasPrefix(name, "some_pubkey_"):
			k := [32]byte(b)
			got = logged(t, func(c solana.Context) { m := svm.NewMsg(""); m.OptionPubkey(true, &k); m.Emit(c) })
		case name == "none_pubkey":
			got = logged(t, func(c solana.Context) { m := svm.NewMsg(""); m.OptionPubkey(false, nil); m.Emit(c) })
		case strings.HasPrefix(name, "h256_debug_"):
			k := [32]byte(b)
			got = logged(t, func(c solana.Context) { m := svm.NewMsg(""); m.H256(&k); m.Emit(c) })
		case strings.HasPrefix(name, "h256_"):
			k := [32]byte(b)
			got = logged(t, func(c solana.Context) { m := svm.NewMsg(""); m.H256Short(&k); m.Emit(c) })
		case strings.HasPrefix(name, "some_h256_"):
			k := [32]byte(b)
			got = logged(t, func(c solana.Context) { m := svm.NewMsg(""); m.OptionH256(true, &k); m.Emit(c) })
		case strings.HasPrefix(name, "h160_debug_"):
			k := [20]byte(b)
			got = logged(t, func(c solana.Context) { m := svm.NewMsg(""); m.H160(&k); m.Emit(c) })
		case strings.HasPrefix(name, "h160_"):
			k := [20]byte(b)
			got = logged(t, func(c solana.Context) { m := svm.NewMsg(""); m.H160Short(&k); m.Emit(c) })
		case strings.HasPrefix(name, "u64_"):
			got = logged(t, func(c solana.Context) { m := svm.NewMsg(""); m.Dec(binary.LittleEndian.Uint64(b)); m.Emit(c) })
		case strings.HasPrefix(name, "some_u64_"):
			got = logged(t, func(c solana.Context) {
				m := svm.NewMsg("")
				m.OptionDec(true, binary.LittleEndian.Uint64(b))
				m.Emit(c)
			})
		case strings.HasPrefix(name, "i64_"):
			got = logged(t, func(c solana.Context) {
				m := svm.NewMsg("")
				m.I64(int64(binary.LittleEndian.Uint64(b)))
				m.Emit(c)
			})
		case strings.HasPrefix(name, "program_error_"):
			got = logged(t, func(c solana.Context) { svm.LogProgramError(c, binary.LittleEndian.Uint64(b)) })
		default:
			t.Fatalf("unknown log vector %s", name)
		}
		if got != v.Text {
			t.Errorf("%s: got %q, want %q", name, got, v.Text)
		}
		checked++
	}
	if checked < 200 {
		t.Fatalf("only %d log vectors", checked)
	}
}
