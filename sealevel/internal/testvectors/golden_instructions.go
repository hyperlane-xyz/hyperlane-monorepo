package testvectors

import (
	"encoding/json"
	"testing"
)

// GoldenMeta is one account of a golden instruction.
type GoldenMeta struct {
	Pubkey     string `json:"pubkey"`
	IsSigner   bool   `json:"is_signer"`
	IsWritable bool   `json:"is_writable"`
}

// GoldenInstruction is one Rust instruction-builder output of a golden file.
type GoldenInstruction struct {
	Name      string       `json:"name"`
	ProgramID string       `json:"program_id"`
	Accounts  []GoldenMeta `json:"accounts"`
	Hex       string       `json:"hex"`
}

// GoldenInstructions reads the "instructions" of <golden dir>/<name>.json.
func GoldenInstructions(t testing.TB, name string) []GoldenInstruction {
	t.Helper()
	raw := ReadGolden(t, name)
	var g struct {
		Instructions []GoldenInstruction `json:"instructions"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g.Instructions
}

// Base58 encodes a 32-byte key.
func Base58(k [32]byte) string {
	digits := []byte{}
	for _, b := range k {
		carry := int(b)
		for i := range digits {
			carry += int(digits[i]) << 8
			digits[i] = byte(carry % 58)
			carry /= 58
		}
		for carry > 0 {
			digits = append(digits, byte(carry%58))
			carry /= 58
		}
	}
	out := []byte{}
	for _, b := range k {
		if b != 0 {
			break
		}
		out = append(out, '1')
	}
	for i := len(digits) - 1; i >= 0; i-- {
		out = append(out, base58Alphabet[digits[i]])
	}
	return string(out)
}
