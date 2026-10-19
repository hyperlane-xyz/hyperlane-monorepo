// Package testvectors loads byte vectors produced by the Rust crates, for
// native Go tests only (never imported by on-chain code).
//
//   - sealevel/testdata/rust_vectors.json: written by sealevel/tools/rust-vectors.
//   - rust/sealevel/interface/testdata/golden/*.json: the shared Sealevel
//     interface goldens. Tests skip when they are absent; SEALEVEL_GOLDEN_DIR
//     overrides the directory.
package testvectors

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Vector is one encoded value; OK is false for bytes Rust rejects.
type Vector struct {
	Hex string `json:"hex"`
	OK  bool   `json:"ok"`
}

// Bytes decodes the vector's hex.
func (v Vector) Bytes(t testing.TB) []byte {
	t.Helper()
	b, err := hex.DecodeString(v.Hex)
	if err != nil {
		t.Fatalf("bad hex %q: %v", v.Hex, err)
	}
	return b
}

func sealevelDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..")
}

// Rust returns the named group of sealevel/testdata/rust_vectors.json.
func Rust(t testing.TB, group string) map[string]Vector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(sealevelDir(), "testdata", "rust_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var all map[string]map[string]Vector
	if err := json.Unmarshal(raw, &all); err != nil {
		t.Fatal(err)
	}
	g, ok := all[group]
	if !ok {
		t.Fatalf("no vector group %q", group)
	}
	return g
}

// Golden is one golden file (see rust/sealevel/interface/testdata/golden/README.md).
type Golden struct {
	Program string        `json:"program"`
	Values  []GoldenValue `json:"values"`
	PDAs    []GoldenPDA   `json:"pdas"`
	Errors  []struct {
		Name string `json:"name"`
		Code uint64 `json:"code"`
	} `json:"errors"`
	Constants []GoldenConstant `json:"constants"`
}

// GoldenConstant is one named constant. Value is the JSON string, or the
// literal text of a JSON number (fee.json and igp.json encode some as numbers).
type GoldenConstant struct {
	Name  string
	Value string
}

func (c *GoldenConstant) UnmarshalJSON(b []byte) error {
	var raw struct {
		Name  string          `json:"name"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	c.Name = raw.Name
	if len(raw.Value) > 0 && raw.Value[0] == '"' {
		return json.Unmarshal(raw.Value, &c.Value)
	}
	c.Value = string(raw.Value)
	return nil
}

// GoldenValue is one encoded value; Fields stays raw for per-type decoding.
type GoldenValue struct {
	Type     string          `json:"type"`
	Variant  *string         `json:"variant"`
	Name     *string         `json:"name"`
	Encoding string          `json:"encoding"`
	Fields   json.RawMessage `json:"fields"`
	Hex      string          `json:"hex"`
}

// GoldenPDA is one find_program_address result.
type GoldenPDA struct {
	Name      string   `json:"name"`
	ProgramID string   `json:"program_id"`
	Seeds     []string `json:"seeds"`
	Address   string   `json:"address"`
	Bump      uint8    `json:"bump"`
}

// LoadGolden reads <golden dir>/<name>.json, skipping the test if absent.
func LoadGolden(t testing.TB, name string) Golden {
	t.Helper()
	dir := os.Getenv("SEALEVEL_GOLDEN_DIR")
	if dir == "" {
		dir = filepath.Join(sealevelDir(), "..", "rust", "sealevel", "interface", "testdata", "golden")
	}
	raw, err := os.ReadFile(filepath.Join(dir, name+".json"))
	if os.IsNotExist(err) {
		t.Skipf("golden %s not present in %s", name, dir)
	}
	if err != nil {
		t.Fatal(err)
	}
	var g Golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

// MustHex decodes hex with an optional 0x prefix.
func MustHex(t testing.TB, s string) []byte {
	t.Helper()
	if len(s) >= 2 && s[:2] == "0x" {
		s = s[2:]
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// Base58Key decodes a base58 Solana public key.
func Base58Key(t testing.TB, s string) [32]byte {
	t.Helper()
	var out [32]byte
	// Big-endian base-58 to base-256 accumulation in out.
	for i := 0; i < len(s); i++ {
		d := -1
		for j := 0; j < len(base58Alphabet); j++ {
			if base58Alphabet[j] == s[i] {
				d = j
			}
		}
		if d < 0 {
			t.Fatalf("bad base58 %q", s)
		}
		carry := d
		for k := 31; k >= 0; k-- {
			carry += int(out[k]) * 58
			out[k] = byte(carry)
			carry >>= 8
		}
		if carry != 0 {
			t.Fatalf("base58 %q overflows 32 bytes", s)
		}
	}
	return out
}
