package merkle

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/keccaktest"
)

// TestMerkleVectors replays vectors/merkle.json (leaves are
// ethers' hashMessage of the strings, as solidity/test/merkle.test.ts does) and checks every intermediate root against
// a recomputed full tree.
func TestMerkleVectors(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "vectors", "merkle.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		TestName     string   `json:"testName"`
		ExpectedRoot string   `json:"expectedRoot"`
		Leaves       []string `json:"leaves"`
	}
	if err = json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	c := keccaktest.Context()
	for _, tc := range cases {
		tree := make([]byte, Size)
		Init(tree)
		for _, leaf := range tc.Leaves {
			if code := Ingest(c, tree, keccaktest.Keccak256([]byte("\x19Ethereum Signed Message:\n"+strconv.Itoa(len(leaf))+leaf))); code != 0 {
				t.Fatal(code)
			}
		}
		root := make([]byte, 32)
		if code := Root(c, tree, root); code != 0 {
			t.Fatal(code)
		}
		if got := "0x" + hex.EncodeToString(root); got != strings.ToLower(tc.ExpectedRoot) {
			t.Fatalf("%s: root %s, want %s", tc.TestName, got, tc.ExpectedRoot)
		}
		if Count(tree) != uint64(len(tc.Leaves)) {
			t.Fatal("count")
		}
	}
}

// fullRoot computes the depth-32 root of leaves directly.
func fullRoot(leaves [][]byte) []byte {
	level := append([][]byte(nil), leaves...)
	zero := make([]byte, 32)
	for d := 0; d < Depth; d++ {
		var next [][]byte
		for i := 0; i < len(level); i += 2 {
			right := zero
			if i+1 < len(level) {
				right = level[i+1]
			}
			next = append(next, keccaktest.Keccak256(append(append([]byte(nil), level[i]...), right...)))
		}
		if len(next) == 0 {
			next = [][]byte{keccaktest.Keccak256(append(append([]byte(nil), zero...), zero...))}
		}
		level = next
		zero = keccaktest.Keccak256(append(append([]byte(nil), zero...), zero...))
	}
	return level[0]
}

func TestMerkleMatchesFullTree(t *testing.T) {
	c := keccaktest.Context()
	tree := make([]byte, Size)
	Init(tree)
	var leaves [][]byte
	for n := 0; n <= 70; n++ {
		root := make([]byte, 32)
		Root(c, tree, root)
		want := fullRoot(leaves)
		if n == 0 {
			want = []byte(zeroHashes[Depth*32:])
		}
		if hex.EncodeToString(root) != hex.EncodeToString(want) {
			t.Fatalf("root after %d leaves", n)
		}
		leaf := keccaktest.Keccak256([]byte{byte(n), byte(n >> 8)})
		leaves = append(leaves, leaf)
		Ingest(c, tree, leaf)
	}
}

func TestZeroHashes(t *testing.T) {
	z := make([]byte, 32)
	for i := 0; i <= Depth; i++ {
		if hex.EncodeToString(z) != hex.EncodeToString([]byte(zeroHashes[i*32:i*32+32])) {
			t.Fatal(i)
		}
		z = keccaktest.Keccak256(append(append([]byte(nil), z...), z...))
	}
}
