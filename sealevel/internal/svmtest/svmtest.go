// Package svmtest is a small native runtime for program tests: PDA
// derivation with a bump table, the System program (CreateAccount, Assign,
// Transfer, Allocate) behind CPIs, the default Rent sysvar, return data,
// Keccak and a secp256k1 recovery table. Programs never import it.
//
// PDA addresses use the real formula, sha256(seeds || bump || program ||
// "ProgramDerivedAddress"). Whether an address is off curve is not computed:
// a seed list registered with Bump is off curve only at that bump (and on
// curve above it); any other seed list is off curve at 255. Register the
// bumps from the goldens or Rust vectors for every PDA a test derives.
package svmtest

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/keccaktest"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/secp256k1test"
	"gosvm/solana"
)

// DefaultRent is solana-rent's default: 3,480 lamports per byte-year, 2-year
// exemption threshold, 50% burn.
const (
	LamportsPerByteYear = 3480
	ExemptionThreshold  = 2.0
)

// MinimumBalance is Rent::default().minimum_balance(size).
func MinimumBalance(size uint64) uint64 {
	return uint64(float64((128+size)*LamportsPerByteYear) * ExemptionThreshold)
}

// PDA computes create_program_address(seeds ++ [bump], program) without the
// curve check.
func PDA(seeds [][]byte, bump uint8, program [32]byte) [32]byte {
	h := sha256.New()
	for _, s := range seeds {
		h.Write(s)
	}
	h.Write([]byte{bump})
	h.Write(program[:])
	h.Write([]byte("ProgramDerivedAddress"))
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// CPI records one System program call.
type CPI struct {
	Instruction uint32
	Accounts    []uint64
	Lamports    uint64
	Space       uint64
	Owner       [32]byte
}

// Runtime is the mutable state behind a test Context.
type Runtime struct {
	t        testing.TB
	Program  [32]byte
	Accounts []solana.Account
	Return   []byte
	CPIs     []CPI
	bumps    map[string]uint8
	recover  func(hash []byte, recoveryID uint64, signature []byte) ([]byte, uint64)
}

// New returns a runtime for program, recovering signatures from the
// recover_* entries of the given Rust vector groups.
func New(t testing.TB, program [32]byte, vectorGroups ...string) *Runtime {
	r := &Runtime{t: t, Program: program, bumps: map[string]uint8{}}
	if len(vectorGroups) > 0 {
		r.recover = secp256k1test.Recover(t, vectorGroups...)
	}
	return r
}

func seedKey(seeds [][]byte) string {
	k := ""
	for _, s := range seeds {
		k += fmt.Sprintf("%d:%x/", len(s), s)
	}
	return k
}

// Bump registers seeds' canonical bump and returns the PDA.
func (r *Runtime) Bump(seeds [][]byte, bump uint8) [32]byte {
	r.bumps[seedKey(seeds)] = bump
	return PDA(seeds, bump, r.Program)
}

// decodeGroup parses goSVM's [count][len][bytes]... seed group; the last
// seed is the bump.
func decodeGroup(b []byte) ([][]byte, int) {
	n := int(b[0])
	off := 1
	out := make([][]byte, n)
	for i := 0; i < n; i++ {
		l := int(b[off])
		out[i] = b[off+1 : off+1+l]
		off += 1 + l
	}
	return out, off
}

func (r *Runtime) derive(seeds []byte, program, output []byte) uint64 {
	all, _ := decodeGroup(seeds)
	if len(all) == 0 || len(all[len(all)-1]) != 1 {
		// Not a seeds+bump list: treat as on curve.
		return 1
	}
	base, bump := all[:len(all)-1], all[len(all)-1][0]
	want, ok := r.bumps[seedKey(base)]
	if !ok {
		want = 255
	}
	if bump > want {
		return 1 // on curve
	}
	var p [32]byte
	copy(p[:], program)
	a := PDA(base, bump, p)
	copy(output, a[:])
	return 0
}

// Account adds an account and returns its index.
func (r *Runtime) Account(a solana.Account) uint64 {
	if a.OriginalDataLen == 0 {
		a.OriginalDataLen = uint64(len(a.Data))
	}
	r.Accounts = append(r.Accounts, a)
	return uint64(len(r.Accounts) - 1)
}

// SystemProgram is the System program's account.
func SystemProgram() solana.Account {
	return solana.Account{Key: make([]byte, 32), Owner: make([]byte, 32), Executable: true}
}

func (r *Runtime) signerSeedsSign(signerSeeds []byte, key []byte) bool {
	if len(signerSeeds) == 0 {
		return false
	}
	off := 1
	for g := 0; g < int(signerSeeds[0]); g++ {
		var a [32]byte
		n := r.derive(signerSeeds[off:], r.Program[:], a[:])
		_, used := decodeGroup(signerSeeds[off:])
		off += used
		if n == 0 && string(a[:]) == string(key) {
			return true
		}
	}
	return false
}

func (r *Runtime) invoke(c *solana.Context, program uint64, metas, data, signerSeeds []byte) uint64 {
	if string(c.Accounts[program].Key) != string(make([]byte, 32)) {
		r.t.Fatalf("CPI to non-System program %x", c.Accounts[program].Key)
	}
	var idx []uint64
	for off := 0; off < len(metas); off += 9 {
		i := binary.LittleEndian.Uint64(metas[off:])
		flags := metas[off+8]
		a := c.Accounts[i]
		if flags&2 != 0 && !a.Signer && !r.signerSeedsSign(signerSeeds, a.Key) {
			r.t.Fatalf("CPI signer %x did not sign", a.Key)
		}
		if flags&1 != 0 && !a.Writable {
			r.t.Fatalf("CPI writable %x is read-only", a.Key)
		}
		idx = append(idx, i)
	}
	ix := binary.LittleEndian.Uint32(data)
	cpi := CPI{Instruction: ix, Accounts: idx}
	acc := c.Accounts
	switch ix {
	case 0: // CreateAccount
		cpi.Lamports = binary.LittleEndian.Uint64(data[4:])
		cpi.Space = binary.LittleEndian.Uint64(data[12:])
		copy(cpi.Owner[:], data[20:52])
		from, to := &acc[idx[0]], &acc[idx[1]]
		if to.Lamports != 0 || len(to.Data) != 0 {
			return 1 << 32 // Custom(0): AccountAlreadyInUse
		}
		if from.Lamports < cpi.Lamports {
			return 1 // Custom(1) ResultWithNegativeLamports
		}
		from.Lamports -= cpi.Lamports
		to.Lamports = cpi.Lamports
		to.Data = make([]byte, cpi.Space)
		to.OriginalDataLen = cpi.Space
		to.Owner = append([]byte(nil), cpi.Owner[:]...)
	case 1: // Assign
		copy(cpi.Owner[:], data[4:36])
		acc[idx[0]].Owner = append([]byte(nil), cpi.Owner[:]...)
	case 2: // Transfer
		cpi.Lamports = binary.LittleEndian.Uint64(data[4:])
		from, to := &acc[idx[0]], &acc[idx[1]]
		if from.Lamports < cpi.Lamports {
			return 1
		}
		from.Lamports -= cpi.Lamports
		to.Lamports += cpi.Lamports
	case 8: // Allocate
		cpi.Space = binary.LittleEndian.Uint64(data[4:])
		acc[idx[0]].Data = make([]byte, cpi.Space)
		acc[idx[0]].OriginalDataLen = cpi.Space
	default:
		r.t.Fatalf("unsupported System instruction %d", ix)
	}
	r.CPIs = append(r.CPIs, cpi)
	return 0
}

// Run executes process with data over the runtime's accounts. Account
// changes persist in r.Accounts; return data lands in r.Return.
func (r *Runtime) Run(process func(solana.Context) uint64, data []byte) uint64 {
	r.Return = nil
	r.CPIs = nil
	c := keccaktest.Context()
	c.ID = r.Program[:]
	c.InstructionData = data
	c.Accounts = r.Accounts
	c.DeriveAddress = r.derive
	c.RecoverSecp256k1 = r.recover
	c.WriteReturnData = func(b []byte) { r.Return = b }
	c.ReadRent = func(out []byte) uint64 {
		binary.LittleEndian.PutUint64(out[0:], LamportsPerByteYear)
		binary.LittleEndian.PutUint64(out[8:], math.Float64bits(ExemptionThreshold))
		out[16] = 50
		return 0
	}
	c.InvokeInstruction = func(program uint64, metas, data, signerSeeds []byte) uint64 {
		return r.invoke(&c, program, metas, data, signerSeeds)
	}
	// Copy accounts so a failing instruction leaves r.Accounts unchanged,
	// like a failed transaction.
	saved := make([]solana.Account, len(r.Accounts))
	for i, a := range r.Accounts {
		a.Data = append([]byte(nil), a.Data...)
		saved[i] = a
	}
	code := process(c)
	if code != 0 {
		r.Accounts = saved
	}
	return code
}
