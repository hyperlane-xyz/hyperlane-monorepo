package compositeism

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"strings"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
)

func seq32(start byte) (k [32]byte) {
	for i := range k {
		k[i] = start + byte(i)
	}
	return
}

func seq20(start byte) (k [20]byte) {
	for i := range k {
		k[i] = start + byte(i)
	}
	return
}

func u256(v *big.Int) borsh.U256 {
	var out borsh.U256
	b := make([]byte, 32)
	v.FillBytes(b)
	for limb := 0; limb < 4; limb++ {
		out[limb] = binary.BigEndian.Uint64(b[24-8*limb:])
	}
	return out
}

// The builders mirror composite_* in sealevel/tools/rust-vectors.

func deep(depth int) IsmNode {
	node := IsmNode{Kind: NodeTest, Accept: true}
	for i := 0; i < depth; i++ {
		node = IsmNode{Kind: NodeAggregation, Threshold: 1, Subs: []IsmNode{node}}
	}
	return node
}

func deepAmount(depth int) IsmNode {
	node := IsmNode{Kind: NodePausable, Paused: true}
	for i := 0; i < depth; i++ {
		t := new(big.Int).Lsh(big.NewInt(int64(i)), uint(i*7))
		t.And(t, new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1)))
		node = IsmNode{Kind: NodeAmountRouting, Amount: u256(t), Subs: []IsmNode{
			node, {Kind: NodeTrustedRelayer, Key: seq32(byte(i))},
		}}
	}
	return node
}

func leaf(i int) IsmNode {
	switch i % 7 {
	case 0:
		return IsmNode{Kind: NodeTest, Accept: i%2 == 0}
	case 1:
		return IsmNode{Kind: NodePausable, Paused: i%3 == 0}
	case 2:
		return IsmNode{Kind: NodeTrustedRelayer, Key: seq32(byte(i))}
	case 3:
		vals := [][20]byte{}
		for j := 0; j < i%5; j++ {
			vals = append(vals, seq20(byte(i+j)))
		}
		return IsmNode{Kind: NodeMultisigMessageID, Validators: vals, Threshold: uint8(i % 4)}
	case 4:
		n := IsmNode{Kind: NodeRateLimited, MaxCapacity: ^uint64(0) - uint64(i), FilledLevel: uint64(i) * 1000,
			LastUpdated: -int64(i), Key: seq32(byte(i + 1))}
		if i%2 != 0 {
			n.Recipient = borsh.SomeOf(seq32(byte(i)))
		}
		return n
	case 5:
		return IsmNode{Kind: NodeFallbackRouting, Key: seq32(byte(i + 2))}
	}
	return IsmNode{Kind: NodeRouting}
}

func wide(width int) IsmNode {
	subs := make([]IsmNode, width)
	for i := range subs {
		subs[i] = leaf(i)
	}
	return IsmNode{Kind: NodeAggregation, Threshold: uint8(width % 256), Subs: subs}
}

func bushy(depth, fanout int) IsmNode {
	node := leaf(depth)
	max := u256(new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1)))
	for d := 0; d < depth; d++ {
		subs := make([]IsmNode, 0, fanout+1)
		for j := 0; j < fanout; j++ {
			subs = append(subs, leaf(d*fanout+j))
		}
		subs[d%fanout] = node
		subs = append(subs, IsmNode{Kind: NodeAmountRouting, Amount: max, Subs: []IsmNode{
			leaf(d + 3), {Kind: NodeAggregation, Subs: []IsmNode{}},
		}})
		node = IsmNode{Kind: NodeAggregation, Threshold: uint8(d), Subs: subs}
	}
	return node
}

func encode(v interface{ EncodeBorsh(*borsh.Writer) }) []byte {
	w := borsh.NewWriter(0)
	v.EncodeBorsh(&w)
	return w.Bytes()
}

func account(v interface{ EncodeBorsh(*borsh.Writer) }) []byte {
	return append([]byte{1}, encode(v)...)
}

func decodeNode(b []byte) (IsmNode, bool) {
	r := borsh.NewReader(b)
	var n IsmNode
	n.DecodeBorsh(&r)
	return n, r.Done()
}

func TestRustVectors(t *testing.T) {
	v := testvectors.Rust(t, "composite-ism")
	nodes := map[string]IsmNode{
		"node_deep_16":           deep(16),
		"node_deep_200":          deep(200),
		"node_deep_amount_40":    deepAmount(40),
		"node_wide_50":           wide(50),
		"node_wide_300":          wide(300),
		"node_bushy_6x5":         bushy(6, 5),
		"node_empty_aggregation": {Kind: NodeAggregation, Subs: []IsmNode{}},
		"node_routing":           {Kind: NodeRouting},
	}
	for name, node := range nodes {
		want := v[name].Bytes(t)
		if got := encode(&node); !bytes.Equal(got, want) {
			t.Errorf("%s: encode differs from Rust\n go %x\n rs %x", name, got, want)
		}
		if node.Size() != len(want) {
			t.Errorf("%s: Size %d, Rust %d", name, node.Size(), len(want))
		}
		got, ok := decodeNode(want)
		if !ok || !reflect.DeepEqual(got, node) {
			t.Errorf("%s: decode mismatch (ok=%v)", name, ok)
		}
	}

	b := bushy(6, 5)
	accounts := map[string]interface{ EncodeBorsh(*borsh.Writer) }{
		"storage_bushy":         &Storage{BumpSeed: 251, Owner: borsh.SomeOf(seq32(9)), Root: borsh.SomeOf(b)},
		"storage_deep_no_owner": &Storage{BumpSeed: 1, Root: borsh.SomeOf(deep(30))},
		"domain_storage_wide":   &DomainStorage{BumpSeed: 7, Domain: ^uint32(0), Ism: borsh.SomeOf(wide(40))},
		"domain_storage_none":   &DomainStorage{BumpSeed: 7, Domain: 5},
	}
	for name, value := range accounts {
		want := v[name].Bytes(t)
		if got := account(value); !bytes.Equal(got, want) {
			t.Errorf("%s: account bytes differ from Rust", name)
		}
	}
	var s Storage
	if ok, code := fetchStorage(v["storage_bushy"].Bytes(t), &s); !ok || code != 0 || !reflect.DeepEqual(&s, accounts["storage_bushy"]) {
		t.Errorf("storage_bushy: fetch %v %#x", ok, code)
	}
	if s.Size()+1 != len(v["storage_bushy"].Bytes(t)) {
		t.Errorf("storage size %d", s.Size())
	}
	var ds DomainStorage
	if ok, code := fetchDomainStorage(v["domain_storage_wide"].Bytes(t), &ds); !ok || code != 0 || !reflect.DeepEqual(&ds, accounts["domain_storage_wide"]) {
		t.Errorf("domain_storage_wide: fetch %v %#x", ok, code)
	}
	if ds.Size()+1 != len(v["domain_storage_wide"].Bytes(t)) {
		t.Errorf("domain storage size %d", ds.Size())
	}

	ixs := map[string]Instruction{
		"ix_initialize_bushy":        {Kind: IxInitialize, Node: b},
		"ix_update_config_deep":      {Kind: IxUpdateConfig, Node: deepAmount(12)},
		"ix_get_owner":               {Kind: IxGetOwner},
		"ix_transfer_ownership_none": {Kind: IxTransferOwnership},
		"ix_transfer_ownership_some": {Kind: IxTransferOwnership, NewOwner: borsh.SomeOf(seq32(4))},
		"ix_set_domain_ism_wide":     {Kind: IxSetDomainIsm, Domain: 0x01020304, Node: wide(20)},
		"ix_remove_domain_ism":       {Kind: IxRemoveDomainIsm, Domain: 77},
		"ix_pause":                   {Kind: IxPause},
		"ix_unpause":                 {Kind: IxUnpause},
	}
	for name, ix := range ixs {
		want := v[name].Bytes(t)
		if got := ix.Encode(); !bytes.Equal(got, want) {
			t.Errorf("%s: encode differs from Rust", name)
		}
		got, code := DecodeInstruction(want)
		if code != 0 || !reflect.DeepEqual(got, ix) {
			t.Errorf("%s: decode %#x", name, code)
		}
		if code := func() uint64 { _, c := DecodeInstruction(want[:len(want)-1]); return c }(); len(want) > 9 && code == 0 {
			t.Errorf("%s: truncated decodes", name)
		}
	}

	for name, vec := range v {
		if !strings.HasPrefix(name, "reject_") {
			continue
		}
		if vec.OK {
			t.Fatalf("%s marked ok", name)
		}
		if _, ok := decodeNode(vec.Bytes(t)); ok {
			t.Errorf("%s: Go accepts bytes Rust rejects", name)
		}
	}

	for i := 0; i < 10; i++ {
		b := v[fmt.Sprintf("rate_level_%d", i)].Bytes(t)
		w := func(k int) uint64 { return binary.LittleEndian.Uint64(b[8*k:]) }
		if got := currentLevel(w(0), int64(w(1)), int64(w(2)), w(3)); got != w(4) {
			t.Errorf("rate_level_%d: %d, Rust %d", i, got, w(4))
		}
	}
}

// goldenNode builds an IsmNode from the goldens' externally tagged JSON.
func goldenNode(t *testing.T, raw json.RawMessage) IsmNode {
	t.Helper()
	var unit string
	if json.Unmarshal(raw, &unit) == nil {
		if unit != "Routing" {
			t.Fatalf("unit variant %q", unit)
		}
		return IsmNode{Kind: NodeRouting}
	}
	var tagged map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tagged); err != nil || len(tagged) != 1 {
		t.Fatalf("bad node %s", raw)
	}
	for variant, body := range tagged {
		var f map[string]json.RawMessage
		if err := json.Unmarshal(body, &f); err != nil {
			t.Fatal(err)
		}
		str := func(k string) string {
			var s string
			if err := json.Unmarshal(f[k], &s); err != nil {
				t.Fatalf("%s.%s: %v", variant, k, err)
			}
			return s
		}
		num := func(k string) uint64 {
			var n uint64
			if err := json.Unmarshal(f[k], &n); err != nil {
				t.Fatalf("%s.%s: %v", variant, k, err)
			}
			return n
		}
		dec := func(k string) *big.Int {
			v, ok := new(big.Int).SetString(str(k), 10)
			if !ok {
				t.Fatalf("%s.%s not decimal", variant, k)
			}
			return v
		}
		boolean := func(k string) bool {
			var b bool
			if err := json.Unmarshal(f[k], &b); err != nil {
				t.Fatal(err)
			}
			return b
		}
		key := func(k string) [32]byte { return testvectors.Base58Key(t, str(k)) }
		switch variant {
		case "TrustedRelayer":
			return IsmNode{Kind: NodeTrustedRelayer, Key: key("relayer")}
		case "MultisigMessageId":
			var hexes []string
			if err := json.Unmarshal(f["validators"], &hexes); err != nil {
				t.Fatal(err)
			}
			vals := [][20]byte{}
			for _, h := range hexes {
				var v [20]byte
				copy(v[:], testvectors.MustHex(t, h))
				vals = append(vals, v)
			}
			return IsmNode{Kind: NodeMultisigMessageID, Validators: vals, Threshold: uint8(num("threshold"))}
		case "Aggregation":
			var subs []json.RawMessage
			if err := json.Unmarshal(f["sub_isms"], &subs); err != nil {
				t.Fatal(err)
			}
			n := IsmNode{Kind: NodeAggregation, Threshold: uint8(num("threshold")), Subs: []IsmNode{}}
			for _, s := range subs {
				n.Subs = append(n.Subs, goldenNode(t, s))
			}
			return n
		case "Test":
			return IsmNode{Kind: NodeTest, Accept: boolean("accept")}
		case "Pausable":
			return IsmNode{Kind: NodePausable, Paused: boolean("paused")}
		case "AmountRouting":
			return IsmNode{Kind: NodeAmountRouting, Amount: u256(dec("threshold")),
				Subs: []IsmNode{goldenNode(t, f["lower"]), goldenNode(t, f["upper"])}}
		case "RateLimited":
			n := IsmNode{Kind: NodeRateLimited, MaxCapacity: dec("max_capacity").Uint64(),
				FilledLevel: dec("filled_level").Uint64(), LastUpdated: dec("last_updated").Int64(), Key: key("mailbox")}
			if string(f["recipient"]) != "null" {
				var r [32]byte
				copy(r[:], testvectors.MustHex(t, str("recipient")))
				n.Recipient = borsh.SomeOf(r)
			}
			return n
		case "FallbackRouting":
			return IsmNode{Kind: NodeFallbackRouting, Key: key("fallback_ism")}
		}
		t.Fatalf("unknown variant %s", variant)
	}
	return IsmNode{}
}

func optionKey(t *testing.T, raw json.RawMessage) borsh.Option[[32]byte] {
	if string(raw) == "null" {
		return borsh.Option[[32]byte]{}
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return borsh.SomeOf(testvectors.Base58Key(t, s))
}

func optionNode(t *testing.T, raw json.RawMessage) borsh.Option[IsmNode] {
	if string(raw) == "null" {
		return borsh.Option[IsmNode]{}
	}
	return borsh.SomeOf(goldenNode(t, raw))
}

// TestGoldens encodes every composite_ism.json value from its fields and
// checks the bytes, the decode, and the error codes and seeds.
func TestGoldens(t *testing.T) {
	g := testvectors.LoadGolden(t, "composite_ism")
	kinds := map[string]uint8{"Initialize": IxInitialize, "UpdateConfig": IxUpdateConfig, "GetOwner": IxGetOwner,
		"TransferOwnership": IxTransferOwnership, "SetDomainIsm": IxSetDomainIsm, "RemoveDomainIsm": IxRemoveDomainIsm,
		"Pause": IxPause, "Unpause": IxUnpause}
	seen := map[string]bool{}
	for _, v := range g.Values {
		want := testvectors.MustHex(t, v.Hex)
		var got []byte
		var name string
		switch v.Type {
		case "composite_ism.Instruction":
			name = *v.Variant
			ix := Instruction{Kind: kinds[name]}
			switch ix.Kind {
			case IxInitialize, IxUpdateConfig:
				ix.Node = goldenNode(t, v.Fields)
			case IxTransferOwnership:
				ix.NewOwner = optionKey(t, v.Fields)
			case IxSetDomainIsm, IxRemoveDomainIsm:
				var f struct {
					Domain uint32
					Ism    json.RawMessage
				}
				if err := json.Unmarshal(v.Fields, &f); err != nil {
					t.Fatal(err)
				}
				ix.Domain = f.Domain
				if ix.Kind == IxSetDomainIsm {
					ix.Node = goldenNode(t, f.Ism)
				}
			}
			got = ix.Encode()
			back, code := DecodeInstruction(want)
			if code != 0 || !reflect.DeepEqual(back, ix) {
				t.Errorf("%s: decode %#x", name, code)
			}
		case "composite_ism.CompositeIsmStorage":
			name = "CompositeIsmStorage " + *v.Name
			var f struct {
				BumpSeed uint8 `json:"bump_seed"`
				Owner    json.RawMessage
				Root     json.RawMessage
			}
			if err := json.Unmarshal(v.Fields, &f); err != nil {
				t.Fatal(err)
			}
			s := &Storage{BumpSeed: f.BumpSeed, Owner: optionKey(t, f.Owner), Root: optionNode(t, f.Root)}
			got = account(s)
			var back Storage
			if ok, code := fetchStorage(want, &back); !ok || code != 0 || !reflect.DeepEqual(&back, s) {
				t.Errorf("%s: fetch", name)
			}
		case "composite_ism.DomainIsmStorage":
			name = "DomainIsmStorage"
			var f struct {
				BumpSeed uint8 `json:"bump_seed"`
				Domain   uint32
				Ism      json.RawMessage
			}
			if err := json.Unmarshal(v.Fields, &f); err != nil {
				t.Fatal(err)
			}
			s := &DomainStorage{BumpSeed: f.BumpSeed, Domain: f.Domain, Ism: optionNode(t, f.Ism)}
			got = account(s)
			var back DomainStorage
			if ok, code := fetchDomainStorage(want, &back); !ok || code != 0 || !reflect.DeepEqual(&back, s) {
				t.Errorf("%s: fetch", name)
			}
		default:
			t.Errorf("unhandled golden type %s", v.Type)
			continue
		}
		seen[name] = true
		if !bytes.Equal(got, want) {
			t.Errorf("%s: Go %x\n golden %x", name, got, want)
		}
	}
	for name := range kinds {
		if !seen[name] {
			t.Errorf("no golden for %s", name)
		}
	}

	errs := map[string]uint64{}
	for _, e := range g.Errors {
		errs[e.Name] = e.Code
	}
	for name, code := range map[string]uint64{
		"ProgramIdNotOwner": ErrProgramIDNotOwner, "AccountNotInitialized": ErrAccountNotInitialized,
		"AlreadyInitialized": ErrAlreadyInitialized, "ConfigNotSet": ErrConfigNotSet,
		"InvalidMetadata": ErrInvalidMetadata, "InvalidSignature": ErrInvalidSignature,
		"ThresholdNotMet": ErrThresholdNotMet, "NoRouteForDomain": ErrNoRouteForDomain,
		"InvalidRelayer": ErrInvalidRelayer, "RelayerNotSigner": ErrRelayerNotSigner,
		"VerifyRejected": ErrVerifyRejected, "InvalidConfig": ErrInvalidConfig,
		"InvalidMessageBody": ErrInvalidMessageBody, "RateLimitExceeded": ErrRateLimitExceeded,
		"RecipientMismatch": ErrRecipientMismatch, "MultipleRoutingNodes": ErrMultipleRoutingNodes,
		"RoutingInDomainIsm": ErrRoutingInDomainIsm, "DomainPdaNotWritable": ErrDomainPdaNotWritable,
		"InvalidSystemProgram": ErrInvalidSystemProgram, "InvalidStoragePda": ErrInvalidStoragePda,
		"InvalidDomainPda": ErrInvalidDomainPda, "FallbackRoutingInDomainIsm": ErrFallbackRoutingInDomainIsm,
		"InvalidFallbackIsmAccount": ErrInvalidFallbackIsmAccount, "FallbackIsmCallFailed": ErrFallbackIsmCallFailed,
		"FallbackRoutingNotLast": ErrFallbackRoutingNotLast, "InvalidProcessAuthority": ErrInvalidProcessAuthority,
		"ProcessAuthorityNotSigner": ErrProcessAuthorityNotSigner, "PausableInDomainIsm": ErrPausableInDomainIsm,
		"InvalidProgramDataAccount": ErrInvalidProgramDataAccount,
	} {
		if got, ok := errs["Error."+name]; !ok || got != code {
			t.Errorf("Error.%s = %d (golden %d, present %v)", name, code, got, ok)
		}
	}
	if len(errs) != 29 {
		t.Errorf("%d golden errors", len(errs))
	}
	for _, c := range g.Constants {
		var want []byte
		switch c.Name {
		case "DOMAIN_ISM_SEED":
			want = DomainIsmSeed
		case "PROCESS_AUTHORITY_SEED":
			want = ProcessAuthoritySeed
		default:
			continue
		}
		if !bytes.Equal(testvectors.MustHex(t, c.Value), want) {
			t.Errorf("%s differs", c.Name)
		}
	}
	for _, p := range g.PDAs {
		if p.Name == "domain_ism" {
			var le [4]byte
			seeds := domainSeeds(binary.LittleEndian.Uint32(testvectors.MustHex(t, p.Seeds[1])), &le)
			for i := range seeds {
				if !bytes.Equal(seeds[i], testvectors.MustHex(t, p.Seeds[i])) {
					t.Errorf("domain seed %d differs", i)
				}
			}
		}
	}
}

func TestSubMetadataAt(t *testing.T) {
	meta := []byte{0, 0, 0, 16, 0, 0, 0, 21, 0, 0, 0, 0, 0, 0, 0, 0, 'm', 'e', 't', 'a', '0'}
	if sub, ok, code := subMetadataAt(meta, 0); code != 0 || !ok || string(sub) != "meta0" {
		t.Errorf("index 0: %q %v %d", sub, ok, code)
	}
	if _, ok, code := subMetadataAt(meta, 1); code != 0 || ok {
		t.Errorf("index 1 should be absent")
	}
	if _, _, code := subMetadataAt(meta[:7], 0); code != ErrInvalidMetadata {
		t.Errorf("short header: %d", code)
	}
	if _, _, code := subMetadataAt([]byte{0, 0, 0, 100, 0, 0, 0, 200, 0, 0, 0, 0}, 0); code != ErrInvalidMetadata {
		t.Errorf("out of bounds: %d", code)
	}
	body := make([]byte, 64)
	body[63] = 42
	thr := borsh.U256{42}
	if ge, ok := amountAtLeast(body, &thr); !ok || !ge {
		t.Errorf("42 >= 42")
	}
	thr = borsh.U256{43}
	if ge, _ := amountAtLeast(body, &thr); ge {
		t.Errorf("42 >= 43")
	}
	body[32] = 1
	thr = borsh.U256{0, 0, 0, 1 << 57}
	if ge, _ := amountAtLeast(body, &thr); ge {
		t.Errorf("2^248 >= 2^249")
	}
	if _, ok := amountAtLeast(body[:63], &thr); ok {
		t.Errorf("short body")
	}
}

func TestValidateOrder(t *testing.T) {
	fallback := IsmNode{Kind: NodeFallbackRouting, Key: seq32(1)}
	pid := seq32(2)
	for name, tc := range map[string]struct {
		node IsmNode
		want uint64
	}{
		"fallback not last": {IsmNode{Kind: NodeAggregation, Threshold: 1, Subs: []IsmNode{fallback, {Kind: NodeTest}}}, ErrFallbackRoutingNotLast},
		"fallback in amount not last": {IsmNode{Kind: NodeAggregation, Threshold: 1, Subs: []IsmNode{
			{Kind: NodeAmountRouting, Subs: []IsmNode{fallback, {Kind: NodeTest}}}, {Kind: NodeTest}}}, ErrFallbackRoutingNotLast},
		"fallback last":   {IsmNode{Kind: NodeAggregation, Threshold: 1, Subs: []IsmNode{{Kind: NodeTest}, fallback}}, 0},
		"two routings":    {IsmNode{Kind: NodeAggregation, Threshold: 2, Subs: []IsmNode{{Kind: NodeRouting}, {Kind: NodeRouting}}}, ErrMultipleRoutingNodes},
		"self fallback":   {IsmNode{Kind: NodeFallbackRouting, Key: pid}, ErrInvalidConfig},
		"dup validators":  {IsmNode{Kind: NodeMultisigMessageID, Validators: [][20]byte{seq20(1), seq20(1)}, Threshold: 2}, ErrInvalidConfig},
		"threshold first": {IsmNode{Kind: NodeAggregation, Threshold: 3, Subs: []IsmNode{{Kind: NodeRouting}, {Kind: NodeRouting}}}, ErrInvalidConfig},
		// Preorder: the first child's error wins over a later sibling's.
		"preorder": {IsmNode{Kind: NodeAggregation, Threshold: 2, Subs: []IsmNode{
			{Kind: NodeAggregation, Threshold: 1, Subs: []IsmNode{{Kind: NodeRouting}, {Kind: NodeTrustedRelayer}}},
			{Kind: NodeRouting}}}, ErrInvalidConfig},
	} {
		if got := validateConfig(&pid, &tc.node); got != tc.want {
			t.Errorf("%s: %d, want %d", name, got, tc.want)
		}
	}
	if got := validateDomainIsm(&IsmNode{Kind: NodeAggregation, Threshold: 1, Subs: []IsmNode{{Kind: NodePausable}}}); got != ErrPausableInDomainIsm {
		t.Errorf("domain pausable: %d", got)
	}
	n := IsmNode{Kind: NodeAggregation, Subs: []IsmNode{leaf(4), {Kind: NodeAmountRouting, Subs: []IsmNode{leaf(11), leaf(1)}}}}
	normalize(&n)
	if n.Subs[0].FilledLevel != n.Subs[0].MaxCapacity || n.Subs[1].Subs[0].LastUpdated != 0 {
		t.Errorf("normalize missed a node")
	}
	flipPausable(&n, true)
	if !n.Subs[1].Subs[1].Paused {
		t.Errorf("flipPausable missed a node")
	}
}
