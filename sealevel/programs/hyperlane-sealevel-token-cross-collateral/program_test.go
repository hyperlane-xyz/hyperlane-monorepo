package tokencrosscollateral

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	tt "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/tokentest"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

func updateFields(u *CrossCollateralRouterUpdate) any {
	if u.Kind == UpdateAdd {
		return map[string]any{"Add": map[string]any{"domain": u.Domain, "router": tt.Hex(u.Router.Value[:])}}
	}
	var router any
	if u.Router.Some {
		router = tt.Hex(u.Router.Value[:])
	}
	return map[string]any{"Remove": map[string]any{"domain": u.Domain, "router": router}}
}

func instructionFields(ix *Instruction) any {
	switch ix.Kind {
	case KindSetCrossCollateralRouters:
		out := []any{}
		for i := range ix.Updates {
			out = append(out, updateFields(&ix.Updates[i]))
		}
		return out
	case KindTransferRemoteTo:
		x := &ix.Transfer
		return map[string]any{
			"destination_domain": x.DestinationDomain,
			"recipient":          tt.Hex(x.Recipient[:]),
			"amount_or_id":       tt.U256(x.AmountOrID),
			"target_router":      tt.Hex(x.TargetRouter[:]),
		}
	}
	return map[string]any{"sender_program_id": tt.B58(ix.Handle.SenderProgramID), "message": tt.Hex(ix.Handle.Message)}
}

var variants = map[string]uint8{
	"SetCrossCollateralRouters": KindSetCrossCollateralRouters,
	"TransferRemoteTo":          KindTransferRemoteTo,
	"HandleLocal":               KindHandleLocal,
	"HandleLocalAccountMetas":   KindHandleLocalAccountMetas,
}

func stateFields(s *CrossCollateralState) any {
	routers := []any{}
	for _, p := range s.EnrolledRouters {
		set := []any{}
		for _, r := range p.Value.Routers {
			set = append(set, tt.Hex(r[:]))
		}
		routers = append(routers, []any{p.Key, set})
	}
	return map[string]any{"bump": s.Bump, "dispatch_authority_bump": s.DispatchAuthorityBump, "local_domain": s.LocalDomain, "enrolled_routers": routers}
}

// Every golden instruction and state decodes, re-encodes byte-identically
// and matches the golden fields.
func TestGoldenValues(t *testing.T) {
	g := tt.LoadGolden(t, "token_cross_collateral")
	seen := map[string]bool{}
	for _, v := range g.Values {
		data := testvectors.MustHex(t, v.Hex)
		switch v.Type {
		case "token_cross_collateral.CrossCollateralInstruction":
			ix := new(Instruction)
			if code := DecodeInstruction(data, ix); code != 0 {
				t.Fatalf("%s: decode %#x", *v.Variant, code)
			}
			if ix.Kind != variants[*v.Variant] {
				t.Errorf("%s: kind %d", *v.Variant, ix.Kind)
			}
			if got := EncodeInstruction(ix); !bytes.Equal(got, data) {
				t.Errorf("%s: encode %x\nRust %x", *v.Variant, got, data)
			}
			tt.SameJSON(t, *v.Variant, instructionFields(ix), v.Fields)
			seen[*v.Variant] = true
		case "token_cross_collateral.CrossCollateralState":
			s := new(CrossCollateralState)
			c := solana.Context{Accounts: []solana.Account{{Data: data}}}
			if code := fetchState(c, 0, s); code != 0 {
				t.Fatalf("state: fetch %#x", code)
			}
			buf := make([]byte, len(data))
			if !accountutils.StoreInSlice(buf, s) || !bytes.Equal(buf, data) {
				t.Errorf("state: store %x\nRust %x", buf, data)
			}
			if got := accountutils.AccountDataSize(s); got != uint64(len(data)) {
				t.Errorf("state: size %d != %d", got, len(data))
			}
			tt.SameJSON(t, "state", stateFields(s), v.Fields)
			seen["state"] = true
		default:
			t.Errorf("unexpected golden type %s", v.Type)
		}
	}
	if len(seen) != 5 {
		t.Errorf("checked %v", seen)
	}
}

// The golden set_cross_collateral_routers_instruction data decodes and
// re-encodes.
func TestGoldenInstructionBuilder(t *testing.T) {
	tt.LoadGolden(t, "token_cross_collateral") // resolves SEALEVEL_GOLDEN_DIR
	raw, err := os.ReadFile(filepath.Join(os.Getenv("SEALEVEL_GOLDEN_DIR"), "token_cross_collateral.json"))
	if err != nil {
		t.Skip(err)
	}
	var g struct {
		Instructions []struct {
			Name string `json:"name"`
			Hex  string `json:"hex"`
		} `json:"instructions"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Instructions) != 1 {
		t.Fatalf("%d instructions", len(g.Instructions))
	}
	data := testvectors.MustHex(t, g.Instructions[0].Hex)
	ix := new(Instruction)
	if code := DecodeInstruction(data, ix); code != 0 || ix.Kind != KindSetCrossCollateralRouters || len(ix.Updates) != 1 {
		t.Fatalf("decode %#x %+v", code, ix)
	}
	if got := EncodeInstruction(ix); !bytes.Equal(got, data) {
		t.Errorf("encode %x", got)
	}
}

func TestGoldenErrorsPDAsConstants(t *testing.T) {
	g := tt.LoadGolden(t, "token_cross_collateral")
	errs := map[string]uint64{
		"Error.UnauthorizedRouter":       ErrUnauthorizedRouter,
		"Error.InvalidDispatchAuthority": ErrInvalidDispatchAuthority,
		"Error.SameDomainViaMailbox":     ErrSameDomainViaMailbox,
	}
	for _, e := range g.Errors {
		if want, ok := errs[e.Name]; !ok || want != e.Code {
			t.Errorf("%s = %d, Go %d", e.Name, e.Code, want)
		}
		delete(errs, e.Name)
	}
	if len(errs) != 0 {
		t.Errorf("unchecked errors %v", errs)
	}
	seeds := map[string][][]byte{"cross_collateral": CrossCollateralPDASeeds, "dispatch_authority": CrossCollateralDispatchAuthorityPDASeeds}
	for _, p := range g.PDAs {
		want, ok := seeds[p.Name]
		if !ok {
			t.Errorf("unexpected PDA %s", p.Name)
			continue
		}
		delete(seeds, p.Name)
		if len(want) != len(p.Seeds) {
			t.Fatalf("%s seeds %v", p.Name, p.Seeds)
		}
		for i, s := range p.Seeds {
			if !bytes.Equal(testvectors.MustHex(t, s), want[i]) {
				t.Errorf("%s seed %d %s", p.Name, i, s)
			}
		}
	}
	if len(seeds) != 0 {
		t.Errorf("unchecked PDAs %v", seeds)
	}
	if len(g.Constants) != 1 || g.Constants[0].Name != "CROSS_COLLATERAL_INSTRUCTION_DISCRIMINATOR" ||
		!bytes.Equal(testvectors.MustHex(t, g.Constants[0].Value), InstructionDiscriminator[:]) {
		t.Errorf("constants %+v", g.Constants)
	}
}

// Malformed CC instructions are InvalidInstructionData (Rust's
// try_from_slice: strict tags, no trailing bytes).
func TestDecodeRejects(t *testing.T) {
	g := tt.LoadGolden(t, "token_cross_collateral")
	good := testvectors.MustHex(t, g.Values[0].Hex) // SetCrossCollateralRouters
	cases := map[string][]byte{
		"short":         good[:7],
		"discriminator": append([]byte{1, 1, 1, 1, 1, 1, 1, 1}, good[8:]...),
		"variant":       append(append([]byte{}, good[:8]...), 4),
		"trailing":      append(append([]byte{}, good...), 0),
		"truncated":     good[:len(good)-1],
		"update tag":    append(append([]byte{}, good[:8]...), 0, 1, 0, 0, 0, 2),
		"option tag":    append(append(append([]byte{}, good[:8]...), 0, 1, 0, 0, 0, 1, 7, 0, 0, 0), 2),
	}
	for name, data := range cases {
		if code := DecodeInstruction(data, new(Instruction)); code != svm.InvalidInstructionData {
			t.Errorf("%s: %#x", name, code)
		}
	}
	// Remove(None) decodes.
	none := append(append([]byte{}, good[:8]...), 0, 1, 0, 0, 0, 1, 7, 0, 0, 0, 0)
	ix := new(Instruction)
	if code := DecodeInstruction(none, ix); code != 0 || ix.Updates[0].Kind != UpdateRemove || ix.Updates[0].Router.Some || ix.Updates[0].Domain != 7 {
		t.Errorf("remove none: %#x %+v", code, ix.Updates)
	}
	if !bytes.Equal(EncodeInstruction(ix), none) {
		t.Errorf("remove none re-encode")
	}
}

// Unsorted and duplicate map/set input normalizes like borsh 1.x BTreeMap /
// BTreeSet (sorted, last duplicate key wins, duplicate set entries dropped).
func TestStateNormalization(t *testing.T) {
	w := borsh.NewWriter(256)
	w.U8(1)
	w.U8(2)
	w.U32(3)
	w.U32(3) // entries
	w.U32(20)
	w.U32(2)
	w.Bytes32(h(9))
	w.Bytes32(h(1))
	w.U32(10)
	w.U32(1)
	w.Bytes32(h(5))
	w.U32(20) // duplicate key: replaces the first
	w.U32(3)
	w.Bytes32(h(7))
	w.Bytes32(h(7))
	w.Bytes32(h(2))
	r := borsh.NewReader(w.Bytes())
	s := new(CrossCollateralState)
	s.DecodeBorsh(&r)
	if !r.Done() {
		t.Fatal("decode")
	}
	want := EnrolledRouters{
		{Key: 10, Value: RouterSet{Routers: []hyperlanecore.H256{h(5)}}},
		{Key: 20, Value: RouterSet{Routers: []hyperlanecore.H256{h(2), h(7)}}},
	}
	if !sameRouters(s.EnrolledRouters, want) {
		t.Errorf("got %+v", s.EnrolledRouters)
	}
}

func h(b byte) hyperlanecore.H256 {
	var x hyperlanecore.H256
	x[0] = b
	x[31] = b
	return x
}

func sameRouters(a, b EnrolledRouters) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Key != b[i].Key || len(a[i].Value.Routers) != len(b[i].Value.Routers) {
			return false
		}
		for j := range a[i].Value.Routers {
			if a[i].Value.Routers[j] != b[i].Value.Routers[j] {
				return false
			}
		}
	}
	return true
}

// Random update sequences match a BTreeMap<u32, BTreeSet<H256>> model of
// set_cross_collateral_routers, and the encoding stays sorted with Size equal
// to its length.
func TestRouterUpdatesModel(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for round := 0; round < 200; round++ {
		s := new(CrossCollateralState)
		model := map[uint32]map[hyperlanecore.H256]bool{}
		for step := 0; step < 30; step++ {
			domain := uint32(rng.Intn(5))
			router := h(byte(rng.Intn(6)))
			switch rng.Intn(3) {
			case 0, 1:
				s.AddRouter(domain, &router)
				if model[domain] == nil {
					model[domain] = map[hyperlanecore.H256]bool{}
				}
				model[domain][router] = true
			case 2:
				if rng.Intn(2) == 0 {
					s.RemoveRouter(domain, &router)
					if set, ok := model[domain]; ok {
						delete(set, router)
						if len(set) == 0 {
							delete(model, domain)
						}
					}
				} else {
					s.RemoveDomain(domain)
					delete(model, domain)
				}
			}
			var want EnrolledRouters
			for d, set := range model {
				var rs []hyperlanecore.H256
				for r := range set {
					rs = append(rs, r)
				}
				sort.Slice(rs, func(i, j int) bool { return borsh.Less32(rs[i], rs[j]) })
				want = append(want, borsh.Pair[uint32, RouterSet]{Key: d, Value: RouterSet{Routers: rs}})
			}
			sort.Slice(want, func(i, j int) bool { return want[i].Key < want[j].Key })
			if !sameRouters(s.EnrolledRouters, want) {
				t.Fatalf("round %d step %d: got %+v want %+v", round, step, s.EnrolledRouters, want)
			}
			for d := uint32(0); d < 5; d++ {
				for b := byte(0); b < 6; b++ {
					r := h(b)
					if s.IsEnrolledRouter(d, &r) != model[d][r] {
						t.Fatalf("enrolled %d %d", d, b)
					}
				}
			}
			w := borsh.NewWriter(64)
			s.EncodeBorsh(&w)
			if w.Len() != s.Size() {
				t.Fatalf("size %d != %d", s.Size(), w.Len())
			}
			back := new(CrossCollateralState)
			r := borsh.NewReader(w.Bytes())
			back.DecodeBorsh(&r)
			if !r.Done() || !sameRouters(back.EnrolledRouters, s.EnrolledRouters) {
				t.Fatal("round trip")
			}
		}
	}
}

// The Rust vectors (tools/rust-vectors cc.rs): every instruction shape
// round-trips, the rejects are InvalidInstructionData, and non-canonical
// state input stores as Rust's canonical encoding.
func TestRustVectors(t *testing.T) {
	vs := testvectors.Rust(t, "token-cross-collateral")
	n := 0
	for name, v := range vs {
		data := v.Bytes(t)
		if len(name) > 6 && name[:6] == "state_" {
			continue
		}
		n++
		ix := new(Instruction)
		code := DecodeInstruction(data, ix)
		if !v.OK {
			if code != svm.InvalidInstructionData {
				t.Errorf("%s: %#x", name, code)
			}
			continue
		}
		if code != 0 {
			t.Errorf("%s: decode %#x", name, code)
			continue
		}
		if got := EncodeInstruction(ix); !bytes.Equal(got, data) {
			t.Errorf("%s: encode %x\nRust %x", name, got, data)
		}
	}
	if n != 11 {
		t.Errorf("%d instruction vectors", n)
	}

	// The local path's HandleLocal CPI data.
	msg := hyperlanecore.TokenMessage{Recipient: h(6), AmountOrID: borsh.U256{123456789}}
	ix := new(Instruction)
	ix.Kind = KindHandleLocal
	ix.Handle.SenderProgramID = svm.Pubkey{5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5}
	ix.Handle.Message = msg.Encode()
	if got := EncodeInstruction(ix); !bytes.Equal(got, vs["handle_local_cpi"].Bytes(t)) {
		t.Errorf("handle_local_cpi %x", got)
	}

	s := new(CrossCollateralState)
	c := solana.Context{Accounts: []solana.Account{{Data: vs["state_unsorted_input"].Bytes(t)}}}
	if code := fetchState(c, 0, s); code != 0 {
		t.Fatalf("unsorted fetch %#x", code)
	}
	want := vs["state_unsorted_canonical"].Bytes(t)
	buf := make([]byte, len(want))
	if !accountutils.StoreInSlice(buf, s) || !bytes.Equal(buf, want) || accountutils.AccountDataSize(s) != uint64(len(want)) {
		t.Errorf("unsorted store %x\nRust %x", buf, want)
	}
	canonical := vs["state_canonical"].Bytes(t)
	r := borsh.NewReader(canonical)
	s = new(CrossCollateralState)
	s.DecodeBorsh(&r)
	w := borsh.NewWriter(len(canonical))
	s.EncodeBorsh(&w)
	if !r.Done() || !bytes.Equal(w.Bytes(), canonical) || s.Size() != len(canonical) {
		t.Errorf("canonical %x", w.Bytes())
	}
}
