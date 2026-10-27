package fee

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"math/rand"
	"strconv"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	quoteverifier "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/quote-verifier"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// --- JSON field helpers (golden README conventions) ---

func jhex(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("hex field %s: %v", raw, err)
	}
	return testvectors.MustHex(t, s)
}

func j32(t *testing.T, raw json.RawMessage) [32]byte {
	var v [32]byte
	b := jhex(t, raw)
	if len(b) != 32 {
		t.Fatalf("want 32 bytes: %s", raw)
	}
	copy(v[:], b)
	return v
}

func j20(t *testing.T, raw json.RawMessage) [20]byte {
	var v [20]byte
	b := jhex(t, raw)
	if len(b) != 20 {
		t.Fatalf("want 20 bytes: %s", raw)
	}
	copy(v[:], b)
	return v
}

func jkey(t *testing.T, raw json.RawMessage) [32]byte {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return testvectors.Base58Key(t, s)
}

func ju64(t *testing.T, raw json.RawMessage) uint64 {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		v, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	var n uint64
	if err := json.Unmarshal(raw, &n); err != nil {
		t.Fatalf("u64 %s: %v", raw, err)
	}
	return n
}

func ji64(t *testing.T, raw json.RawMessage) int64 {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func jobj(t *testing.T, raw json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("object %s: %v", raw, err)
	}
	return m
}

// jenum splits an externally tagged enum {"Name": value}.
func jenum(t *testing.T, raw json.RawMessage) (string, json.RawMessage) {
	t.Helper()
	m := jobj(t, raw)
	if len(m) != 1 {
		t.Fatalf("enum %s", raw)
	}
	for k, v := range m {
		return k, v
	}
	return "", nil
}

func isNull(raw json.RawMessage) bool { return string(raw) == "null" }

func jsigners(t *testing.T, raw json.RawMessage) Signers {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		t.Fatal(err)
	}
	s := Signers{}
	for _, it := range items {
		s = append(s, j20(t, it))
	}
	return s
}

func joptSigners(t *testing.T, raw json.RawMessage) OptionSigners {
	if isNull(raw) {
		return OptionSigners{}
	}
	return OptionSigners{Some: true, Value: jsigners(t, raw)}
}

func joptH256(t *testing.T, raw json.RawMessage) OptionH256 {
	if isNull(raw) {
		return OptionH256{}
	}
	return borsh.SomeOf(j32(t, raw))
}

func jparams(t *testing.T, raw json.RawMessage) FeeParams {
	m := jobj(t, raw)
	return FeeParams{MaxFee: ju64(t, m["max_fee"]), HalfAmount: ju64(t, m["half_amount"])}
}

func jstrategy(t *testing.T, raw json.RawMessage) FeeDataStrategy {
	name, v := jenum(t, raw)
	kinds := map[string]uint8{"Linear": StrategyLinear, "Regressive": StrategyRegressive, "Progressive": StrategyProgressive}
	k, ok := kinds[name]
	if !ok {
		t.Fatalf("strategy %s", name)
	}
	return FeeDataStrategy{Kind: k, Params: jparams(t, v)}
}

func jfeeData(t *testing.T, raw json.RawMessage) FeeData {
	name, v := jenum(t, raw)
	m := jobj(t, v)
	switch name {
	case "Leaf":
		return FeeData{Kind: FeeDataLeaf, Leaf: LeafFeeConfig{Strategy: jstrategy(t, m["strategy"]), Signers: joptSigners(t, m["signers"])}}
	case "Routing":
		return FeeData{Kind: FeeDataRouting, WildcardSigners: jsigners(t, m["wildcard_signers"])}
	case "CrossCollateralRouting":
		return FeeData{Kind: FeeDataCrossCollateralRouting, WildcardSigners: jsigners(t, m["wildcard_signers"])}
	}
	t.Fatalf("fee data %s", name)
	return FeeData{}
}

type encoder interface{ EncodeBorsh(w *borsh.Writer) }

func encode(e encoder) []byte {
	w := borsh.NewWriter(64)
	e.EncodeBorsh(&w)
	return w.Bytes()
}

// encodeInstruction builds Instruction::<variant>(fields) from golden fields.
func encodeInstruction(t *testing.T, variant string, raw json.RawMessage) []byte {
	t.Helper()
	w := borsh.NewWriter(64)
	f := map[string]json.RawMessage{}
	if !isNull(raw) && len(raw) > 0 && raw[0] == '{' {
		f = jobj(t, raw)
	}
	switch variant {
	case "InitFee":
		w.EnumTag(IxInitFee)
		ix := InitFee{Salt: j32(t, f["salt"]), Beneficiary: jkey(t, f["beneficiary"]), FeeData: jfeeData(t, f["fee_data"]), DomainID: uint32(ju64(t, f["domain_id"]))}
		ix.EncodeBorsh(&w)
	case "QuoteFee":
		w.EnumTag(IxQuoteFee)
		ix := QuoteFee{DestinationDomain: uint32(ju64(t, f["destination_domain"])), Recipient: j32(t, f["recipient"]), Amount: ju64(t, f["amount"]), TargetRouter: j32(t, f["target_router"])}
		ix.EncodeBorsh(&w)
	case "SetRemoteFeeRoute":
		w.EnumTag(IxSetRemoteFeeRoute)
		ix := SetRemoteFeeRoute{Domain: uint32(ju64(t, f["domain"])), TargetRouter: joptH256(t, f["target_router"]), FeeData: jstrategy(t, f["fee_data"]), Signers: joptSigners(t, f["signers"])}
		ix.EncodeBorsh(&w)
	case "RemoveRemoteFeeRoute", "PruneExpiredQuotes":
		if variant == "RemoveRemoteFeeRoute" {
			w.EnumTag(IxRemoveRemoteFeeRoute)
		} else {
			w.EnumTag(IxPruneExpiredQuotes)
		}
		ix := DomainRouter{Domain: uint32(ju64(t, f["domain"])), TargetRouter: joptH256(t, f["target_router"])}
		ix.EncodeBorsh(&w)
	case "UpdateFeeParams":
		w.EnumTag(IxUpdateFeeParams)
		p := jparams(t, raw)
		p.EncodeBorsh(&w)
	case "SetBeneficiary":
		w.EnumTag(IxSetBeneficiary)
		w.Bytes32(jkey(t, raw))
	case "TransferOwnership":
		w.EnumTag(IxTransferOwnership)
		w.OptionTag(!isNull(raw))
		if !isNull(raw) {
			w.Bytes32(jkey(t, raw))
		}
	case "SetQuoteSigner":
		w.EnumTag(IxSetQuoteSigner)
		op, signer := jenum(t, f["operation"])
		ix := SetQuoteSigner{Remove: op == "Remove", Signer: j20(t, signer)}
		if !isNull(f["route"]) {
			var unit string
			if json.Unmarshal(f["route"], &unit) == nil {
				t.Fatalf("route %s", f["route"])
			}
			name, v := jenum(t, f["route"])
			ix.Route.Some = true
			if name == "Domain" {
				ix.Route.Value = RouteKey{Kind: RouteKeyDomain, Domain: uint32(ju64(t, v))}
			} else {
				m := jobj(t, v)
				ix.Route.Value = RouteKey{Kind: RouteKeyCrossCollateral, Domain: uint32(ju64(t, m["destination"])), TargetRouter: j32(t, m["target_router"])}
			}
		}
		ix.EncodeBorsh(&w)
	case "SetMinIssuedAt":
		w.EnumTag(IxSetMinIssuedAt)
		w.I64(ji64(t, f["min_issued_at"]))
	case "SetWildcardQuoteSigners":
		w.EnumTag(IxSetWildcardQuoteSigners)
		writeSigners(&w, jsigners(t, f["signers"]))
	case "SubmitQuote":
		w.EnumTag(IxSubmitQuote)
		q := quoteverifier.SvmSignedQuote{Context: jhex(t, f["context"]), Data: jhex(t, f["data"]), ClientSalt: j32(t, f["client_salt"])}
		copy(q.IssuedAt[:], jhex(t, f["issued_at"]))
		copy(q.Expiry[:], jhex(t, f["expiry"]))
		copy(q.Signature[:], jhex(t, f["signature"]))
		q.EncodeBorsh(&w)
	case "CloseTransientQuote":
		w.EnumTag(IxCloseTransientQuote)
	case "GetQuoteAccountMetas", "GetSubmitQuoteAccountMetas":
		if variant == "GetQuoteAccountMetas" {
			w.EnumTag(IxGetQuoteAccountMetas)
		} else {
			w.EnumTag(IxGetSubmitQuoteAccountMetas)
		}
		ix := GetAccountMetas{DestinationDomain: uint32(ju64(t, f["destination_domain"])), TargetRouter: j32(t, f["target_router"]), ScopedSalt: joptH256(t, f["scoped_salt"])}
		ix.EncodeBorsh(&w)
	default:
		t.Fatalf("unknown instruction variant %s", variant)
	}
	return w.Bytes()
}

func accountEncoding(e encoder) []byte {
	w := borsh.NewWriter(64)
	w.Bool(true)
	e.EncodeBorsh(&w)
	return w.Bytes()
}

// goldenAccount builds the Go value for a golden account type and returns
// a fresh zero value of the same type for decoding.
func goldenAccount(t *testing.T, typ string, raw json.RawMessage) (accountutils.Sized, func([]byte) ([]byte, uint64)) {
	f := jobj(t, raw)
	switch typ {
	case "fee.FeeAccount":
		v := &FeeAccount{BumpSeed: uint8(ju64(t, f["bump_seed"])), Beneficiary: jkey(t, f["beneficiary"]), DomainID: uint32(ju64(t, f["domain_id"])), MinIssuedAt: ji64(t, f["min_issued_at"]), FeeData: jfeeData(t, f["fee_data"])}
		if !isNull(f["owner"]) {
			v.Owner = borsh.SomeOf(jkey(t, f["owner"]))
		}
		return v, roundTrip[FeeAccount]
	case "fee.RouteDomain":
		v := &RouteDomain{BumpSeed: uint8(ju64(t, f["bump_seed"])), FeeData: jstrategy(t, f["fee_data"]), Signers: joptSigners(t, f["signers"])}
		return v, roundTrip[RouteDomain]
	case "fee.CrossCollateralRoute":
		v := &CrossCollateralRoute{BumpSeed: uint8(ju64(t, f["bump_seed"])), FeeData: jstrategy(t, f["fee_data"]), Signers: joptSigners(t, f["signers"])}
		return v, roundTrip[CrossCollateralRoute]
	case "fee.TransientQuote":
		v := &TransientQuote{BumpSeed: uint8(ju64(t, f["bump_seed"])), Payer: jkey(t, f["payer"]), ScopedSalt: j32(t, f["scoped_salt"]), Context: jhex(t, f["context"]), Data: jhex(t, f["data"]), Expiry: ji64(t, f["expiry"])}
		return v, roundTrip[TransientQuote]
	case "fee.FeeStandingQuotePda":
		v := &FeeStandingQuotePda{BumpSeed: uint8(ju64(t, f["bump_seed"]))}
		var entries [][2]json.RawMessage
		if err := json.Unmarshal(f["quotes"], &entries); err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			m := jobj(t, e[1])
			v.Quotes = append(v.Quotes, StandingQuoteEntry{Key: j32(t, e[0]), Value: FeeStandingQuoteValue{IssuedAt: ji64(t, m["issued_at"]), Expiry: ji64(t, m["expiry"]), FeeData: jstrategy(t, m["fee_data"])}})
		}
		return v, roundTrip[FeeStandingQuotePda]
	}
	t.Fatalf("unknown account type %s", typ)
	return nil, nil
}

// roundTrip decodes account data as T (AccountData fetch) and re-encodes.
func roundTrip[T any, P interface {
	*T
	accountutils.Sized
	DecodeBorsh(r *borsh.Reader)
}](b []byte) ([]byte, uint64) {
	v, ok, code := accountutils.Fetch[T, P](b)
	if code != svm.Success || !ok {
		return nil, code | 1
	}
	return accountEncoding(P(&v)), svm.Success
}

func loadFeeGolden(t *testing.T) testvectors.Golden {
	return testvectors.LoadGolden(t, "fee")
}

func TestGoldenValues(t *testing.T) {
	g := loadFeeGolden(t)
	seen := map[string]bool{}
	for _, v := range g.Values {
		want := testvectors.MustHex(t, v.Hex)
		name := v.Type
		if v.Variant != nil {
			name += "." + *v.Variant
		}
		if v.Name != nil {
			name += "/" + *v.Name
		}
		switch {
		case v.Type == "fee.Instruction":
			seen[*v.Variant] = true
			if got := encodeInstruction(t, *v.Variant, v.Fields); !bytes.Equal(got, want) {
				t.Errorf("%s: Go %x\nRust %x", name, got, want)
			}
		case v.Type == "fee.FeeDataStrategy":
			s := FeeDataStrategy{Kind: map[string]uint8{"Linear": 0, "Regressive": 1, "Progressive": 2}[*v.Variant], Params: jparams(t, v.Fields)}
			if got := encode(&s); !bytes.Equal(got, want) {
				t.Errorf("%s: Go %x\nRust %x", name, got, want)
			}
			d, ok := DecodeStrategyBytes(want)
			if !ok || d != s {
				t.Errorf("%s: decode %+v %v", name, d, ok)
			}
		default:
			if v.Encoding != "account+discriminator" {
				t.Fatalf("%s: unexpected encoding %s", name, v.Encoding)
			}
			acct, rt := goldenAccount(t, v.Type, v.Fields)
			got := accountEncoding(acct)
			if !bytes.Equal(got, want) {
				t.Errorf("%s: Go %x\nRust %x", name, got, want)
			}
			if int(accountutils.AccountDataSize(acct)) != len(want) {
				t.Errorf("%s: size %d, want %d", name, accountutils.AccountDataSize(acct), len(want))
			}
			back, code := rt(want)
			if code != svm.Success || !bytes.Equal(back, want) {
				t.Errorf("%s: decode/encode %x (%#x)", name, back, code)
			}
		}
	}
	for _, variant := range []string{"InitFee", "QuoteFee", "SetRemoteFeeRoute", "RemoveRemoteFeeRoute", "UpdateFeeParams", "SetBeneficiary", "TransferOwnership", "SetQuoteSigner", "SetMinIssuedAt", "SetWildcardQuoteSigners", "SubmitQuote", "CloseTransientQuote", "PruneExpiredQuotes", "GetQuoteAccountMetas", "GetSubmitQuoteAccountMetas"} {
		if !seen[variant] {
			t.Errorf("golden has no %s", variant)
		}
	}
}

// run executes Process with no accounts: a well-formed instruction gets as
// far as account parsing (NotEnoughAccountKeys); a malformed one is
// InvalidInstructionData.
func run(data []byte, accounts ...solana.Account) (uint64, []byte) {
	var ret []byte
	program := testvectors.Base58Key(&testing.T{}, "Fee1111111111111111111111111111111111111111")
	c := solana.Context{
		ID:              program[:],
		InstructionData: data,
		Accounts:        accounts,
		WriteReturnData: func(b []byte) { ret = b },
	}
	return Process(c), ret
}

func TestGoldenInstructionsDecode(t *testing.T) {
	g := loadFeeGolden(t)
	var all []string
	for _, v := range g.Values {
		if v.Type == "fee.Instruction" {
			all = append(all, v.Hex)
		}
	}
	for _, h := range all {
		data := testvectors.MustHex(t, h)
		if code, _ := run(data); code != svm.NotEnoughAccountKeys {
			t.Errorf("%x: %#x, want NotEnoughAccountKeys", data, code)
		}
		if code, _ := run(append(append([]byte{}, data...), 0)); code != svm.InvalidInstructionData {
			t.Errorf("%x + trailing byte: %#x", data, code)
		}
		if len(data) > 1 {
			if code, _ := run(data[:len(data)-1]); code != svm.InvalidInstructionData {
				t.Errorf("%x truncated: %#x", data, code)
			}
		}
	}
	for _, data := range [][]byte{nil, {15}, {0xff}, {4, 1}} {
		if code, _ := run(data); code != svm.InvalidInstructionData {
			t.Errorf("%x: %#x", data, code)
		}
	}
}

func TestGetProgramVersion(t *testing.T) {
	code, ret := run(packageversioned.GetProgramVersionDiscriminator[:])
	if code != svm.Success || !bytes.Equal(ret, []byte{5, 0, 0, 0, '1', '.', '0', '.', '0', 0xff}) {
		t.Fatalf("%#x %x", code, ret)
	}
}

func TestGoldenPDAs(t *testing.T) {
	g := loadFeeGolden(t)
	var fee, salt, router H256
	for _, p := range g.PDAs {
		seeds := make([][]byte, len(p.Seeds))
		for i, s := range p.Seeds {
			seeds[i] = testvectors.MustHex(t, s)
		}
		var got [][]byte
		switch p.Name {
		case "fee_account":
			copy(salt[:], seeds[4])
			got = FeeAccountSeeds(&salt)
		case "route_domain":
			copy(fee[:], seeds[4])
			got = RouteDomainSeeds(&fee, le32(seeds[6]))
		case "cc_route":
			copy(fee[:], seeds[4])
			copy(router[:], seeds[8])
			got = CCRouteSeeds(&fee, le32(seeds[6]), &router)
		case "transient_quote":
			copy(fee[:], seeds[4])
			copy(salt[:], seeds[6])
			got = TransientQuoteSeeds(&fee, &salt)
		case "standing_quote":
			copy(fee[:], seeds[4])
			copy(router[:], seeds[8])
			got = StandingQuoteSeeds(&fee, le32(seeds[6]), &router)
		default:
			t.Fatalf("unknown PDA %s", p.Name)
		}
		if len(got) != len(seeds) {
			t.Fatalf("%s: %d seeds, want %d", p.Name, len(got), len(seeds))
		}
		for i := range got {
			if !bytes.Equal(got[i], seeds[i]) {
				t.Errorf("%s seed %d: %x, want %x", p.Name, i, got[i], seeds[i])
			}
		}
	}
}

func TestGoldenErrorsAndConstants(t *testing.T) {
	g := loadFeeGolden(t)
	errs := map[string]uint64{
		"Error.FeeComputationOverflow": ErrFeeComputationOverflow, "Error.NotLeafFeeData": ErrNotLeafFeeData,
		"Error.NotRoutingFeeData": ErrNotRoutingFeeData, "Error.NotCrossCollateralRoutingFeeData": ErrNotCrossCollateralRoutingFeeData,
		"Error.RouteNotFound": ErrRouteNotFound, "Error.TransientPdaMismatch": ErrTransientPdaMismatch,
		"Error.InvalidTransientData": ErrInvalidTransientData, "Error.StandingQuoteAmountNotWildcard": ErrStandingQuoteAmountNotWildcard,
		"Error.InvalidStandingQuoteContext": ErrInvalidStandingQuoteContext, "Error.InvalidStandingQuoteData": ErrInvalidStandingQuoteData,
		"Error.ZeroTargetRouterNotAllowed": ErrZeroTargetRouterNotAllowed, "Error.InvalidRouteDomain": ErrInvalidRouteDomain,
		"Error.OffchainQuotingNotConfigured": ErrOffchainQuotingNotConfigured, "Error.WildcardSignersNotApplicable": ErrWildcardSignersNotApplicable,
		"Error.MinIssuedAtMustBeMonotonic": ErrMinIssuedAtMustBeMonotonic, "Error.CurveVariantMismatch": ErrCurveVariantMismatch,
		"Error.ZeroFeeParams": ErrZeroFeeParams, "Error.InvalidTransientSlot": ErrInvalidTransientSlot,
	}
	if len(g.Errors) != len(errs) {
		t.Errorf("golden has %d errors, Go %d", len(g.Errors), len(errs))
	}
	for _, e := range g.Errors {
		if v, ok := errs[e.Name]; !ok || v != e.Code {
			t.Errorf("%s: Go %d, Rust %d", e.Name, v, e.Code)
		}
	}
	hexOf := func(b []byte) string { return "0x" + hex.EncodeToString(b) }
	consts := map[string]string{
		"FEE_ACCOUNT_DISCRIMINATOR":     hexOf(FeeAccountDiscriminator[:]),
		"ROUTE_DOMAIN_DISCRIMINATOR":    hexOf(RouteDomainDiscriminator[:]),
		"CC_ROUTE_DISCRIMINATOR":        hexOf(CCRouteDiscriminator[:]),
		"TRANSIENT_QUOTE_DISCRIMINATOR": hexOf(TransientQuoteDiscriminator[:]),
		"STANDING_QUOTE_DISCRIMINATOR":  hexOf(StandingQuoteDiscriminator[:]),
		"WILDCARD_RECIPIENT":            hexOf(WildcardRecipient[:]),
		"WILDCARD_DOMAIN":               strconv.FormatUint(uint64(WildcardDomain), 10),
		"WILDCARD_AMOUNT":               strconv.FormatUint(WildcardAmount, 10),
		"DEFAULT_ROUTER":                hexOf(DefaultRouter[:]),
	}
	for _, c := range g.Constants {
		if want, ok := consts[c.Name]; !ok || want != c.Value {
			t.Errorf("%s: Go %s, Rust %s", c.Name, want, c.Value)
		}
	}
}

// --- fee math ---

func TestFeeMathRustCases(t *testing.T) {
	for _, tc := range []struct {
		kind              uint8
		maxFee, half, amt uint64
		want              uint64
	}{
		{StrategyLinear, 1000, 500, 0, 0},
		{StrategyLinear, 1000, 500, 500, 500},
		{StrategyLinear, 1000, 500, 1000, 1000},
		{StrategyLinear, 1000, 500, 5000, 1000},
		{StrategyLinear, 1000, 500, ^uint64(0), 1000},
		{StrategyLinear, 1000, 500, 100, 100},
		{StrategyLinear, 1000, 3, 1, 166},
		{StrategyRegressive, 1000, 500, 0, 0},
		{StrategyRegressive, 1000, 500, 500, 500},
		{StrategyRegressive, 1000, 500, 1_000_000, 999},
		{StrategyRegressive, 1000, 500, ^uint64(0), 999},
		{StrategyRegressive, 1000, 500, 10, 19},
		{StrategyProgressive, 1000, 500, 0, 0},
		{StrategyProgressive, 1000, 500, 500, 500},
		{StrategyProgressive, 1000, 500, 10, 0},
		{StrategyProgressive, 1000, 500, ^uint64(0), 999},
		{StrategyProgressive, 1000, 500, 1000, 800},
		{StrategyProgressive, 10_000_000, 100_000_000_000, 50_000_000_000, 2_000_000},
		{StrategyProgressive, 1_000_000_000_000_000, 1_000_000_000_000_000_000, 1_000_000_000_000_000_000, 500_000_000_000_000},
		{StrategyLinear, 0, 500, 100, 0},
		{StrategyRegressive, 1000, 0, 100, 0},
		{StrategyProgressive, ^uint64(0), ^uint64(0), ^uint64(0), 1<<63 - 1},
	} {
		s := FeeDataStrategy{Kind: tc.kind, Params: FeeParams{tc.maxFee, tc.half}}
		if got, code := s.ComputeFee(tc.amt); code != svm.Success || got != tc.want {
			t.Errorf("%+v(%d) = %d %#x, want %d", s, tc.amt, got, code, tc.want)
		}
	}
}

func refFee(kind uint8, maxFee, half, amount uint64) uint64 {
	if maxFee == 0 || half == 0 {
		return 0
	}
	m, h, a := new(big.Int).SetUint64(maxFee), new(big.Int).SetUint64(half), new(big.Int).SetUint64(amount)
	var fee *big.Int
	switch kind {
	case StrategyLinear:
		fee = new(big.Int).Quo(new(big.Int).Mul(a, m), new(big.Int).Mul(big.NewInt(2), h))
		if fee.Cmp(m) > 0 {
			fee = m
		}
	case StrategyRegressive:
		fee = new(big.Int).Quo(new(big.Int).Mul(m, a), new(big.Int).Add(h, a))
	default:
		a2 := new(big.Int).Mul(a, a)
		fee = new(big.Int).Quo(new(big.Int).Mul(m, a2), new(big.Int).Add(new(big.Int).Mul(h, h), a2))
	}
	return fee.Uint64()
}

func TestFeeMathAgainstBig(t *testing.T) {
	r := rand.New(rand.NewSource(3))
	pick := func() uint64 {
		switch r.Intn(5) {
		case 0:
			return ^uint64(0) - uint64(r.Intn(3))
		case 1:
			return uint64(r.Intn(1000))
		case 2:
			return 1 << uint(r.Intn(64))
		}
		return r.Uint64() >> uint(r.Intn(64))
	}
	for n := 0; n < 100000; n++ {
		kind := uint8(r.Intn(3))
		maxFee, half, amt := pick(), pick(), pick()
		s := FeeDataStrategy{Kind: kind, Params: FeeParams{maxFee, half}}
		got, code := s.ComputeFee(amt)
		if want := refFee(kind, maxFee, half, amt); code != svm.Success || got != want {
			t.Fatalf("%+v(%d) = %d %#x, want %d", s, amt, got, code, want)
		}
	}
}

func TestStrategyDecodeStrict(t *testing.T) {
	ok := []byte{2, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0}
	if _, good := DecodeStrategyBytes(ok); !good {
		t.Fatal("valid strategy rejected")
	}
	for _, b := range [][]byte{nil, ok[:16], append(append([]byte{}, ok...), 0), {3, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0}} {
		if _, good := DecodeStrategyBytes(b); good {
			t.Errorf("%x accepted", b)
		}
	}
}

func TestQuoteContext(t *testing.T) {
	b := make([]byte, 76)
	for i := range b {
		b[i] = byte(i)
	}
	ctx, code := ParseQuoteContext(b, true)
	if code != svm.Success || ctx.DestinationDomain != 0x03020100 || ctx.Recipient[0] != 4 || ctx.Amount != le64(b[36:44]) || ctx.TargetRouter[31] != 75 {
		t.Fatalf("cc context %+v %#x", ctx, code)
	}
	if _, code := ParseQuoteContext(b, false); code != svm.InvalidInstructionData {
		t.Errorf("76 bytes as non-CC: %#x", code)
	}
	if _, code := ParseQuoteContext(b[:44], false); code != svm.Success {
		t.Errorf("44 bytes: %#x", code)
	}
	if _, code := ParseQuoteContext(b[:44], true); code != svm.InvalidInstructionData {
		t.Errorf("44 bytes as CC: %#x", code)
	}
}

func TestSignerSetOps(t *testing.T) {
	a, b, c := H160{1}, H160{2}, H160{3}
	s := Signers{}
	s = insertSigner(s, c)
	s = insertSigner(s, a)
	s = insertSigner(s, b)
	s = insertSigner(s, a)
	if len(s) != 3 || s[0] != a || s[1] != b || s[2] != c {
		t.Fatalf("insert: %x", s)
	}
	s = removeSigner(s, &b)
	s = removeSigner(s, &b)
	if len(s) != 2 || s[0] != a || s[1] != c {
		t.Fatalf("remove: %x", s)
	}
	o := OptionSigners{}
	ix := &SetQuoteSigner{Remove: true, Signer: a}
	applySignerOp(&o, ix)
	if o.Some {
		t.Fatal("remove on None created a set")
	}
	ix.Remove = false
	applySignerOp(&o, ix)
	ix.Remove = true
	applySignerOp(&o, ix)
	if !o.Some || len(o.Value) != 0 {
		t.Fatalf("remove last should leave Some(empty): %+v", o)
	}
}
