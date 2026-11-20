package tokenlib_test

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	tt "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/tokentest"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

var variantKinds = map[string]uint8{
	"Init": tokenlib.KindInit, "TransferRemote": tokenlib.KindTransferRemote,
	"EnrollRemoteRouter": tokenlib.KindEnrollRemoteRouter, "EnrollRemoteRouters": tokenlib.KindEnrollRemoteRouters,
	"SetDestinationGasConfigs":    tokenlib.KindSetDestinationGasConfigs,
	"SetInterchainSecurityModule": tokenlib.KindSetInterchainSecurityModule,
	"SetInterchainGasPaymaster":   tokenlib.KindSetInterchainGasPaymaster,
	"TransferOwnership":           tokenlib.KindTransferOwnership,
	"TransferRemoteWithMemo":      tokenlib.KindTransferRemoteWithMemo,
	"SetFeeConfig":                tokenlib.KindSetFeeConfig,
}

func routerFields(r cc.RemoteRouterConfig) any {
	var router any
	if r.Router.Some {
		router = tt.Hex(r.Router.Value[:])
	}
	return map[string]any{"domain": r.Domain, "router": router}
}

func transferFields(x *tokenlib.TransferRemote) any {
	return map[string]any{"destination_domain": x.DestinationDomain, "recipient": tt.Hex(x.Recipient[:]), "amount_or_id": tt.U256(x.AmountOrID)}
}

func instructionFields(ix *tokenlib.Instruction) any {
	switch ix.Kind {
	case tokenlib.KindInit:
		return map[string]any{"mailbox": tt.B58(ix.Init.Mailbox), "interchain_security_module": tt.OptKey(ix.Init.InterchainSecurityModule),
			"interchain_gas_paymaster": tt.OptIGP(ix.Init.InterchainGasPaymaster), "decimals": ix.Init.Decimals, "remote_decimals": ix.Init.RemoteDecimals}
	case tokenlib.KindTransferRemote:
		return transferFields(&ix.Transfer)
	case tokenlib.KindEnrollRemoteRouter:
		return routerFields(ix.RouterConfig)
	case tokenlib.KindEnrollRemoteRouters:
		out := []any{}
		for _, r := range ix.RouterConfigs {
			out = append(out, routerFields(r))
		}
		return out
	case tokenlib.KindSetDestinationGasConfigs:
		out := []any{}
		for _, g := range ix.GasConfigs {
			var gas any
			if g.Gas.Some {
				gas = tt.U64(g.Gas.Value)
			}
			out = append(out, map[string]any{"domain": g.Domain, "gas": gas})
		}
		return out
	case tokenlib.KindSetInterchainSecurityModule, tokenlib.KindTransferOwnership:
		return tt.OptKey(ix.Pubkey)
	case tokenlib.KindSetInterchainGasPaymaster:
		return tt.OptIGP(ix.IGP)
	case tokenlib.KindTransferRemoteWithMemo:
		return map[string]any{"xfer": transferFields(&ix.Transfer), "memo": tt.Hex(ix.Memo)}
	case tokenlib.KindSetFeeConfig:
		return tt.FeeConfig(ix.FeeConfig)
	}
	return nil
}

func TestGoldenInstructions(t *testing.T) {
	g := tt.LoadGolden(t, "token")
	n := 0
	for _, v := range g.Values {
		if v.Type != "token.Instruction" {
			continue
		}
		n++
		data := testvectors.MustHex(t, v.Hex)
		ix := new(tokenlib.Instruction)
		if code := tokenlib.DecodeInstruction(data, ix); code != 0 {
			t.Fatalf("%s: decode %#x", *v.Variant, code)
		}
		if ix.Kind != variantKinds[*v.Variant] {
			t.Errorf("%s: kind %d", *v.Variant, ix.Kind)
		}
		if enc := tokenlib.EncodeInstruction(ix); !bytes.Equal(enc, data) {
			t.Errorf("%s: encode %x, Rust %x", *v.Variant, enc, data)
		}
		tt.SameJSON(t, *v.Variant, instructionFields(ix), v.Fields)
		// Trailing bytes and truncation are InvalidInstructionData.
		if code := tokenlib.DecodeInstruction(append(bytes.Clone(data), 0), new(tokenlib.Instruction)); code != svm.InvalidInstructionData {
			t.Errorf("%s: trailing byte %#x", *v.Variant, code)
		}
		if code := tokenlib.DecodeInstruction(data[:len(data)-1], new(tokenlib.Instruction)); code != svm.InvalidInstructionData {
			t.Errorf("%s: truncated %#x", *v.Variant, code)
		}
	}
	if n != 12 {
		t.Errorf("%d instruction vectors", n)
	}
	for _, bad := range [][]byte{nil, {1, 1, 1, 1, 1, 1, 1}, {1, 1, 1, 1, 1, 1, 1, 1, 10}, {1, 1, 1, 1, 1, 1, 1, 2, 0}} {
		if code := tokenlib.DecodeInstruction(bad, new(tokenlib.Instruction)); code != svm.InvalidInstructionData {
			t.Errorf("%x: %#x", bad, code)
		}
	}
}

func TestGoldenMetadata(t *testing.T) {
	g := tt.LoadGolden(t, "token")
	codes := map[string]uint64{
		"Error.ExtraneousAccount": tokenlib.ErrExtraneousAccount, "Error.IntegerOverflow": tokenlib.ErrIntegerOverflow,
		"Error.MessageDecodeError": tokenlib.ErrMessageDecodeError, "Error.InvalidFeeReturnData": tokenlib.ErrInvalidFeeReturnData,
		"Error.FeeAccountOwnerMismatch": tokenlib.ErrFeeAccountOwnerMismatch, "Error.FeeBeneficiaryNotFound": tokenlib.ErrFeeBeneficiaryNotFound,
		"Error.IgpNewFlowRequired": tokenlib.ErrIgpNewFlowRequired, "Error.InvalidFeeAccountDomain": tokenlib.ErrInvalidFeeAccountDomain,
	}
	if len(g.Errors) != len(codes) {
		t.Errorf("%d golden errors", len(g.Errors))
	}
	for _, e := range g.Errors {
		if c, ok := codes[e.Name]; !ok || c != e.Code {
			t.Errorf("%s = %d (Go %d)", e.Name, e.Code, c)
		}
	}
	for _, c := range g.Constants {
		if c.Name == "FeeConfig.DISCRIMINATOR" && !bytes.Equal(testvectors.MustHex(t, c.Value), tokenlib.FeeConfigDiscriminator[:]) {
			t.Errorf("%s = %s", c.Name, c.Value)
		}
	}
	for _, p := range g.PDAs {
		if p.Name != "token" {
			continue
		}
		if len(p.Seeds) != len(tokenlib.TokenPDASeeds) {
			t.Fatalf("token seeds %v", p.Seeds)
		}
		for i, s := range p.Seeds {
			if !bytes.Equal(testvectors.MustHex(t, s), tokenlib.TokenPDASeeds[i]) {
				t.Errorf("token seed %d = %s", i, s)
			}
		}
	}
}

func goldenValue(t *testing.T, g testvectors.Golden, typ, variant, name string) testvectors.GoldenValue {
	t.Helper()
	for _, v := range g.Values {
		if v.Type == typ && (variant == "" || v.Variant != nil && *v.Variant == variant) && (name == "" || v.Name != nil && *v.Name == name) {
			return v
		}
	}
	t.Fatalf("no golden %s %s %s", typ, variant, name)
	return testvectors.GoldenValue{}
}

func TestGoldenExternalEncodings(t *testing.T) {
	igp := tt.LoadGolden(t, "igp")
	v := goldenValue(t, igp, "igp.Instruction", "PayForGas", "")
	var f struct {
		MessageID   string `json:"message_id"`
		Destination uint32 `json:"destination_domain"`
		Gas         string `json:"gas_amount"`
	}
	json.Unmarshal(v.Fields, &f)
	var id [32]byte
	copy(id[:], testvectors.MustHex(t, f.MessageID))
	if got := cc.PayForGasData(id, f.Destination, 300000); !bytes.Equal(got, testvectors.MustHex(t, v.Hex)) || f.Gas != "300000" {
		t.Errorf("PayForGas %x", got)
	}
	for _, name := range []string{"igp", "overhead_igp"} {
		v := goldenValue(t, igp, "igp.InterchainGasPaymasterType", "", name)
		r := borsh.NewReader(testvectors.MustHex(t, v.Hex))
		var typ cc.InterchainGasPaymasterType
		typ.DecodeBorsh(&r)
		w := borsh.NewWriter(33)
		typ.EncodeBorsh(&w)
		if !r.Done() || !bytes.Equal(w.Bytes(), testvectors.MustHex(t, v.Hex)) || (typ.Kind == cc.IGPTypeOverheadIgp) != (name == "overhead_igp") {
			t.Errorf("%s: %+v", name, typ)
		}
		var key string
		json.Unmarshal(v.Fields, &key)
		if tt.B58(typ.Key) != key {
			t.Errorf("%s key %s", name, key)
		}
	}
	for name, want := range map[string]bool{"with_fee_config": true, "without_fee_config": false} {
		v := goldenValue(t, igp, "igp.Igp", "", name)
		data := testvectors.MustHex(t, v.Hex)
		if quoted, code := tokenlib.IgpQuoted(data); code != 0 || quoted != want {
			t.Errorf("%s: quoted %v %#x", name, quoted, code)
		}
		// Trailing zero padding (a realloced account) keeps the mode.
		if quoted, code := tokenlib.IgpQuoted(append(bytes.Clone(data), make([]byte, 40)...)); code != 0 || quoted != want {
			t.Errorf("%s padded: quoted %v %#x", name, quoted, code)
		}
		// Truncated inside the gas oracles: InvalidAccountData.
		if _, code := tokenlib.IgpQuoted(data[:90]); code != svm.InvalidAccountData {
			t.Errorf("%s truncated: %#x", name, code)
		}
	}
	if _, code := tokenlib.IgpQuoted(append([]byte{1}, []byte("OVRHDIGP")...)); code != svm.InvalidAccountData {
		t.Errorf("wrong discriminator: %#x", code)
	}

	mailbox := tt.LoadGolden(t, "mailbox")
	v = goldenValue(t, mailbox, "mailbox.Instruction", "OutboxDispatch", "")
	var d struct {
		Sender      string `json:"sender"`
		Destination uint32 `json:"destination_domain"`
		Recipient   string `json:"recipient"`
		Body        string `json:"message_body"`
	}
	json.Unmarshal(v.Fields, &d)
	var recipient [32]byte
	copy(recipient[:], testvectors.MustHex(t, d.Recipient))
	got := cc.OutboxDispatchData(testvectors.Base58Key(t, d.Sender), d.Destination, recipient, testvectors.MustHex(t, d.Body))
	if !bytes.Equal(got, testvectors.MustHex(t, v.Hex)) {
		t.Errorf("OutboxDispatch %x", got)
	}

	fee := tt.LoadGolden(t, "fee")
	v = goldenValue(t, fee, "fee.Instruction", "QuoteFee", "")
	var q struct {
		Destination  uint32 `json:"destination_domain"`
		Recipient    string `json:"recipient"`
		Amount       string `json:"amount"`
		TargetRouter string `json:"target_router"`
	}
	json.Unmarshal(v.Fields, &q)
	var qr, qt [32]byte
	copy(qr[:], testvectors.MustHex(t, q.Recipient))
	copy(qt[:], testvectors.MustHex(t, q.TargetRouter))
	if got := tokenlib.QuoteFeeData(q.Destination, &qr, 123456789, &qt); !bytes.Equal(got, testvectors.MustHex(t, v.Hex)) || q.Amount != "123456789" {
		t.Errorf("QuoteFee %x", got)
	}

	v = goldenValue(t, fee, "fee.FeeAccount", "", "")
	var fa struct {
		Beneficiary string `json:"beneficiary"`
		DomainID    uint32 `json:"domain_id"`
	}
	json.Unmarshal(v.Fields, &fa)
	data := testvectors.MustHex(t, v.Hex)
	var prefix tokenlib.FeeAccountPrefix
	if code := tokenlib.ParseFeeAccountPrefix(data, &prefix); code != 0 || tt.B58(prefix.Beneficiary) != fa.Beneficiary || prefix.DomainID != fa.DomainID {
		t.Errorf("FeeAccountPrefix %#x %+v", code, prefix)
	}
	for _, tc := range []struct {
		data []byte
		code uint64
	}{
		{data[:8], svm.InvalidAccountData},
		{append([]byte{0}, data[1:]...), svm.UninitializedAccount},
		{append([]byte{1, 'X'}, data[2:]...), svm.InvalidAccountData},
		{data[:9+1+33+32+3], svm.InvalidAccountData},
	} {
		if code := tokenlib.ParseFeeAccountPrefix(tc.data, &prefix); code != tc.code {
			t.Errorf("prefix %x: %#x", tc.data, code)
		}
	}

	for _, name := range []string{"owned", "unowned"} {
		v := goldenValue(t, mailbox, "mailbox.Outbox", "", name)
		var o struct {
			LocalDomain uint32 `json:"local_domain"`
			Bump        uint8  `json:"outbox_bump_seed"`
		}
		json.Unmarshal(v.Fields, &o)
		mailboxID := [32]byte{9}
		outboxKey := [32]byte{8}
		data := testvectors.MustHex(t, v.Hex)
		c := solana.Context{
			Accounts: []solana.Account{{Key: outboxKey[:], Owner: mailboxID[:], Data: data}},
			DeriveAddress: func(seeds, program, out []byte) uint64 {
				want := append([]byte{4, 9}, []byte("hyperlane\x01-\x06outbox\x01")...)
				if bytes.Equal(seeds, append(want, o.Bump)) && bytes.Equal(program, mailboxID[:]) {
					copy(out, outboxKey[:])
				}
				return 0
			},
		}
		if dom, code := tokenlib.VerifyOutboxAndFetchLocalDomain(c, &mailboxID, 0); code != 0 || dom != o.LocalDomain {
			t.Errorf("%s: domain %d %#x", name, dom, code)
		}
		c.Accounts[0].Data = data[:len(data)-1]
		if _, code := tokenlib.VerifyOutboxAndFetchLocalDomain(c, &mailboxID, 0); code != svm.BorshIoError {
			t.Errorf("%s short: %#x", name, code)
		}
		c.Accounts[0].Data = data
		c.Accounts[0].Owner = outboxKey[:]
		if _, code := tokenlib.VerifyOutboxAndFetchLocalDomain(c, &mailboxID, 0); code != svm.IllegalOwner {
			t.Errorf("%s owner: %#x", name, code)
		}
	}
}

func u256(lo uint64) borsh.U256 { return borsh.U256{lo, 0, 0, 0} }

func TestConvertDecimals(t *testing.T) {
	pow := func(k int) borsh.U256 {
		v := u256(1)
		for i := 0; i < k; i++ {
			v, _ = tokenlib.ConvertDecimals(v, 0, 1)
		}
		return v
	}
	for _, tc := range []struct {
		amount   borsh.U256
		from, to uint8
		want     borsh.U256
		ok       bool
	}{
		{u256(100), 2, 2, u256(100), true},
		{u256(100), 2, 5, u256(100000), true},
		{u256(100000), 5, 2, u256(100), true},
		{u256(100001), 5, 2, u256(100), true},
		{u256(1), 0, 77, pow(77), true},
		{u256(1), 0, 78, borsh.U256{}, false},
		{u256(0), 0, 78, borsh.U256{}, false},
		{u256(12), 0, 77, borsh.U256{}, false},
		{pow(77), 77, 0, u256(1), true},
		{pow(77), 78, 0, borsh.U256{}, false},
		{u256(1_000_000_000), 9, 18, pow(18), true},
		{borsh.U256{^uint64(0), ^uint64(0), ^uint64(0), ^uint64(0)}, 40, 0, borsh.U256{7075782581055379969, 627710173538668076, 0, 0}, true},
	} {
		got, ok := tokenlib.ConvertDecimals(tc.amount, tc.from, tc.to)
		if ok != tc.ok || ok && got != tc.want {
			t.Errorf("convert(%v, %d, %d) = %v %v", tc.amount, tc.from, tc.to, got, ok)
		}
	}
	if s := tt.U256(borsh.U256{7075782581055379969, 627710173538668076, 0, 0}); s != "11579208923731619542357098500868790785" {
		t.Errorf("u256::MAX / 10^40 = %s", s) // floor(115792089237316195423570985008687907853269984665640564039457584007913129639935 / 10^40)
	}
	tok := new(tokenlib.HyperlaneToken[plugin, *plugin])
	tok.Decimals, tok.RemoteDecimals = 9, 18
	if _, code := tok.RemoteAmountToLocalAmount(borsh.U256{0, 0, 0, 1}); code != svm.ArithmeticOverflow {
		t.Errorf("overflow %#x", code)
	}
	tok.Decimals, tok.RemoteDecimals = 9, 200
	if _, code := tok.LocalAmountToRemoteAmount(1_000_000_000); code != svm.InvalidArgument {
		t.Errorf("pow overflow %#x", code)
	}
}

type plugin struct{ A uint32 }

func (p *plugin) EncodeBorsh(w *borsh.Writer) { w.U32(p.A) }
func (p *plugin) DecodeBorsh(r *borsh.Reader) { p.A = r.U32() }
func (p *plugin) Size() int                   { return 4 }

func TestRouterMaps(t *testing.T) {
	var routers cc.Routers
	r := func(b byte) borsh.Option[[32]byte] { return borsh.SomeOf([32]byte{b}) }
	routers = cc.EnrollRemoteRouters(solana.Context{}, routers, []cc.RemoteRouterConfig{{Domain: 5, Router: r(1)}, {Domain: 1, Router: r(2)}, {Domain: 9, Router: r(3)}, {Domain: 5, Router: r(4)}, {Domain: 1}, {Domain: 7}})
	if len(routers) != 2 || routers[0].Key != 5 || routers[0].Value[0] != 4 || routers[1].Key != 9 {
		t.Fatalf("routers %v", routers)
	}
	if !cc.IsRemoteRouter(routers, 9, &[32]byte{3}) || cc.IsRemoteRouter(routers, 9, &[32]byte{4}) || cc.IsRemoteRouter(routers, 1, &[32]byte{}) {
		t.Fatal("is_remote_router")
	}
}

// The HLSVM-2026Q2-010 shapes: a shrunk store leaves stale router bytes after
// plugin_data; they are not a FeeConfig.
func TestStaleTailIsNotFeeConfig(t *testing.T) {
	tok := new(tokenlib.HyperlaneToken[plugin, *plugin])
	tok.RemoteRouters = cc.Routers{{Key: 0}}
	tok.PluginData.A = 0x02020202
	w := borsh.NewWriter(0)
	tok.EncodeBorsh(&w)
	keep := w.Bytes()
	if len(keep) != tok.Size()-(1+32)*2-(1+32+1+32)+3 {
		t.Fatalf("size %d vs %d", len(keep), tok.Size())
	}
	for _, tail := range [][]byte{bytes.Repeat([]byte{2}, 40), bytes.Repeat([]byte{1}, 72), []byte("TOKFEEV1")} {
		data := append(append([]byte{1}, keep...), tail...)
		got := new(tokenlib.HyperlaneToken[plugin, *plugin])
		c := solana.Context{Accounts: []solana.Account{{Data: data}}}
		code := tokenlib.FetchToken(c, 0, got)
		if string(tail) == "TOKFEEV1" {
			if code != svm.BorshIoError {
				t.Errorf("discriminator without payload: %#x", code)
			}
			continue
		}
		if code != 0 || got.FeeConfig.Some || got.PluginData.A != 0x02020202 {
			t.Errorf("tail %x: %#x %+v", tail[:1], code, got.FeeConfig)
		}
	}
}
