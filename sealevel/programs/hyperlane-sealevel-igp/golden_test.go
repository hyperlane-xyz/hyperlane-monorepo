package igp_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"reflect"
	"strconv"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	igp "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/programs/hyperlane-sealevel-igp"
)

// Field decoders for the golden JSON conventions (see the golden README).

func jsonStr(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return s
}

func isNull(raw json.RawMessage) bool { return string(raw) == "null" }

func pubkey(t *testing.T, raw json.RawMessage) igp.Pubkey {
	return testvectors.Base58Key(t, jsonStr(t, raw))
}

func optPubkey(t *testing.T, raw json.RawMessage) borsh.Option[igp.Pubkey] {
	if isNull(raw) {
		return borsh.Option[igp.Pubkey]{}
	}
	return borsh.SomeOf(pubkey(t, raw))
}

func h256(t *testing.T, raw json.RawMessage) (h igp.H256) {
	copy(h[:], testvectors.MustHex(t, jsonStr(t, raw)))
	return
}

func h160(t *testing.T, raw json.RawMessage) (h igp.H160) {
	copy(h[:], testvectors.MustHex(t, jsonStr(t, raw)))
	return
}

func num(t *testing.T, raw json.RawMessage) *big.Int {
	t.Helper()
	s := string(raw)
	if len(s) > 0 && s[0] == '"' {
		s = jsonStr(t, raw)
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		t.Fatalf("bad number %s", raw)
	}
	return v
}

func u32(t *testing.T, raw json.RawMessage) uint32 { return uint32(num(t, raw).Uint64()) }
func u64(t *testing.T, raw json.RawMessage) uint64 { return num(t, raw).Uint64() }
func i64(t *testing.T, raw json.RawMessage) int64  { return num(t, raw).Int64() }

func u128(t *testing.T, raw json.RawMessage) borsh.U128 {
	v := num(t, raw)
	lo := new(big.Int).And(v, new(big.Int).SetUint64(^uint64(0))).Uint64()
	hi := new(big.Int).Rsh(v, 64).Uint64()
	return borsh.U128{Lo: lo, Hi: hi}
}

func obj(t *testing.T, raw json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return m
}

func arr(t *testing.T, raw json.RawMessage) []json.RawMessage {
	t.Helper()
	var a []json.RawMessage
	if err := json.Unmarshal(raw, &a); err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return a
}

func gasOracle(t *testing.T, raw json.RawMessage) igp.GasOracle {
	d := obj(t, obj(t, raw)["RemoteGasData"])
	return igp.GasOracle{RemoteGasData: igp.RemoteGasData{
		TokenExchangeRate: u128(t, d["token_exchange_rate"]),
		GasPrice:          u128(t, d["gas_price"]),
		TokenDecimals:     uint8(u32(t, d["token_decimals"])),
	}}
}

func feeConfig(t *testing.T, raw json.RawMessage) borsh.Option[igp.IgpFeeConfig] {
	if isNull(raw) {
		return borsh.Option[igp.IgpFeeConfig]{}
	}
	f := obj(t, raw)
	cfg := igp.IgpFeeConfig{DomainID: u32(t, f["domain_id"]), MinIssuedAt: i64(t, f["min_issued_at"])}
	cfg.Signers = []igp.H160{}
	for _, s := range arr(t, f["signers"]) {
		cfg.Signers = append(cfg.Signers, h160(t, s))
	}
	return borsh.SomeOf(cfg)
}

// expectedInstruction builds the decoded Instruction for a golden value.
func expectedInstruction(t *testing.T, variant string, raw json.RawMessage) *igp.Instruction {
	ix := &igp.Instruction{}
	switch variant {
	case "Init":
		ix.Kind = igp.IxInit
	case "Claim":
		ix.Kind = igp.IxClaim
	case "CloseIgpTransientQuote":
		ix.Kind = igp.IxCloseIgpTransientQuote
	case "CloseIgpStandingQuote":
		ix.Kind = igp.IxCloseIgpStandingQuote
	case "InitIgp", "InitOverheadIgp":
		ix.Kind = igp.IxInitIgp
		key := "beneficiary"
		if variant == "InitOverheadIgp" {
			ix.Kind, key = igp.IxInitOverheadIgp, "inner"
		}
		f := obj(t, raw)
		ix.Salt, ix.Owner, ix.Key = h256(t, f["salt"]), optPubkey(t, f["owner"]), pubkey(t, f[key])
	case "PayForGas":
		f := obj(t, raw)
		ix.Kind = igp.IxPayForGas
		ix.MessageID, ix.DestinationDomain, ix.GasAmount = h256(t, f["message_id"]), u32(t, f["destination_domain"]), u64(t, f["gas_amount"])
	case "QuoteGasPayment":
		f := obj(t, raw)
		ix.Kind = igp.IxQuoteGasPayment
		ix.DestinationDomain, ix.GasAmount = u32(t, f["destination_domain"]), u64(t, f["gas_amount"])
	case "TransferIgpOwnership":
		ix.Kind, ix.NewOwner = igp.IxTransferIgpOwnership, optPubkey(t, raw)
	case "TransferOverheadIgpOwnership":
		ix.Kind, ix.NewOwner = igp.IxTransferOverheadIgpOwnership, optPubkey(t, raw)
	case "SetIgpBeneficiary":
		ix.Kind, ix.Key = igp.IxSetIgpBeneficiary, pubkey(t, raw)
	case "SetDestinationGasOverheads":
		ix.Kind = igp.IxSetDestinationGasOverheads
		ix.GasOverheads = []igp.GasOverheadConfig{}
		for _, e := range arr(t, raw) {
			f := obj(t, e)
			cfg := igp.GasOverheadConfig{DestinationDomain: u32(t, f["destination_domain"])}
			if !isNull(f["gas_overhead"]) {
				cfg.GasOverhead = borsh.SomeOf(u64(t, f["gas_overhead"]))
			}
			ix.GasOverheads = append(ix.GasOverheads, cfg)
		}
	case "SetGasOracleConfigs":
		ix.Kind = igp.IxSetGasOracleConfigs
		ix.GasOracles = []igp.GasOracleConfig{}
		for _, e := range arr(t, raw) {
			f := obj(t, e)
			cfg := igp.GasOracleConfig{Domain: u32(t, f["domain"])}
			if !isNull(f["gas_oracle"]) {
				cfg.GasOracle = borsh.SomeOf(gasOracle(t, f["gas_oracle"]))
			}
			ix.GasOracles = append(ix.GasOracles, cfg)
		}
	case "SetIgpQuoteConfig":
		ix.Kind, ix.FeeConfig = igp.IxSetIgpQuoteConfig, feeConfig(t, raw)
	case "SetIgpQuoteSigner":
		ix.Kind = igp.IxSetIgpQuoteSigner
		f := obj(t, raw)
		if s, ok := f["Add"]; ok {
			ix.SignerOp, ix.Signer = igp.SignerAdd, h160(t, s)
		} else {
			ix.SignerOp, ix.Signer = igp.SignerRemove, h160(t, f["Remove"])
		}
	case "SetIgpMinIssuedAt":
		ix.Kind, ix.MinIssuedAt = igp.IxSetIgpMinIssuedAt, i64(t, raw)
	case "GetIgpQuoteAccountMetas":
		f := obj(t, raw)
		ix.Kind = igp.IxGetIgpQuoteAccountMetas
		ix.DestinationDomain, ix.Sender = u32(t, f["destination_domain"]), pubkey(t, f["sender"])
		if !isNull(f["scoped_salt"]) {
			ix.ScopedSalt = borsh.SomeOf(h256(t, f["scoped_salt"]))
		}
	case "SubmitIgpQuote":
		f := obj(t, raw)
		ix.Kind = igp.IxSubmitIgpQuote
		q := &ix.Quote
		q.Context, q.Data = testvectors.MustHex(t, jsonStr(t, f["context"])), testvectors.MustHex(t, jsonStr(t, f["data"]))
		copy(q.IssuedAt[:], testvectors.MustHex(t, jsonStr(t, f["issued_at"])))
		copy(q.Expiry[:], testvectors.MustHex(t, jsonStr(t, f["expiry"])))
		q.ClientSalt = h256(t, f["client_salt"])
		copy(q.Signature[:], testvectors.MustHex(t, jsonStr(t, f["signature"])))
	default:
		return nil
	}
	return ix
}

func TestGoldenInstructions(t *testing.T) {
	g := testvectors.LoadGolden(t, "igp")
	seen := 0
	for _, v := range g.Values {
		if v.Type != "igp.Instruction" {
			continue
		}
		variant := *v.Variant
		data := testvectors.MustHex(t, v.Hex)
		want := expectedInstruction(t, variant, v.Fields)
		if want == nil {
			t.Errorf("unhandled variant %s", variant)
			continue
		}
		seen++
		got := &igp.Instruction{}
		if !igp.DecodeInstruction(data, got) {
			t.Errorf("%s: decode failed", variant)
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\n got %+v\nwant %+v", variant, got, want)
		}
		// try_from_slice: a trailing byte or a truncation fails.
		if igp.DecodeInstruction(append(append([]byte{}, data...), 0), &igp.Instruction{}) {
			t.Errorf("%s: trailing byte accepted", variant)
		}
		if len(data) > 1 && igp.DecodeInstruction(data[:len(data)-1], &igp.Instruction{}) {
			t.Errorf("%s: truncation accepted", variant)
		}
	}
	if seen != 20 {
		t.Errorf("checked %d instruction vectors", seen)
	}
	for _, bad := range [][]byte{nil, {18}, {0xff}, {12, 2}, {11, 2}, {5, 2}, {9, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1}} {
		if igp.DecodeInstruction(bad, &igp.Instruction{}) {
			t.Errorf("%x accepted", bad)
		}
	}
}

// accountCase decodes a golden account value with T and checks it against
// want, its re-encoding against the bytes and Size against the length.
func accountCase[T any, P interface {
	*T
	accountutils.Sized
	DecodeBorsh(*borsh.Reader)
}](t *testing.T, name string, data []byte, want *T) {
	t.Helper()
	got, initialized, code := accountutils.Fetch[T, P](data)
	if code != 0 || !initialized {
		t.Fatalf("%s: fetch %#x %v", name, code, initialized)
	}
	if !reflect.DeepEqual(&got, want) {
		t.Errorf("%s:\n got %+v\nwant %+v", name, got, *want)
	}
	if n := accountutils.AccountDataSize(P(want)); n != uint64(len(data)) {
		t.Errorf("%s: size %d, encoded %d", name, n, len(data))
	}
	buf := make([]byte, len(data))
	if !accountutils.StoreInSlice(buf, P(want)) || !bytes.Equal(buf, data) {
		t.Errorf("%s: encode\n got %x\nwant %x", name, buf, data)
	}
}

func TestGoldenAccounts(t *testing.T) {
	g := testvectors.LoadGolden(t, "igp")
	seen := 0
	for _, v := range g.Values {
		data := testvectors.MustHex(t, v.Hex)
		f := map[string]json.RawMessage{}
		if len(v.Fields) > 0 && v.Fields[0] == '{' {
			f = obj(t, v.Fields)
		}
		name := v.Type
		if v.Name != nil {
			name += "." + *v.Name
		}
		switch v.Type {
		case "igp.ProgramData":
			accountCase(t, name, data, &igp.ProgramData{BumpSeed: uint8(u32(t, f["bump_seed"])), PaymentCount: u64(t, f["payment_count"])})
		case "igp.OverheadIgp":
			want := &igp.OverheadIgp{
				BumpSeed: uint8(u32(t, f["bump_seed"])), Salt: h256(t, f["salt"]), Owner: optPubkey(t, f["owner"]),
				Inner: pubkey(t, f["inner"]), GasOverheads: []igp.GasOverhead{},
			}
			for _, e := range arr(t, f["gas_overheads"]) {
				kv := arr(t, e)
				want.GasOverheads = append(want.GasOverheads, igp.GasOverhead{Key: u32(t, kv[0]), Value: u64(t, kv[1])})
			}
			accountCase(t, name, data, want)
		case "igp.Igp":
			want := &igp.Igp{
				BumpSeed: uint8(u32(t, f["bump_seed"])), Salt: h256(t, f["salt"]), Owner: optPubkey(t, f["owner"]),
				Beneficiary: pubkey(t, f["beneficiary"]), GasOracles: []igp.GasOracleEntry{}, FeeConfig: feeConfig(t, f["fee_config"]),
			}
			for _, e := range arr(t, f["gas_oracles"]) {
				kv := arr(t, e)
				want.GasOracles = append(want.GasOracles, igp.GasOracleEntry{Key: u32(t, kv[0]), Value: gasOracle(t, kv[1])})
			}
			accountCase(t, name, data, want)
		case "igp.GasPaymentData":
			accountCase(t, name, data, &igp.GasPaymentData{
				SequenceNumber: u64(t, f["sequence_number"]), Igp: pubkey(t, f["igp"]), DestinationDomain: u32(t, f["destination_domain"]),
				MessageID: h256(t, f["message_id"]), GasAmount: u64(t, f["gas_amount"]), Payment: u64(t, f["payment"]),
				UniqueGasPaymentPubkey: pubkey(t, f["unique_gas_payment_pubkey"]), Slot: u64(t, f["slot"]),
			})
		case "igp.IgpStandingQuote":
			accountCase(t, name, data, &igp.IgpStandingQuote{
				BumpSeed: uint8(u32(t, f["bump_seed"])), FeeTokenMint: pubkey(t, f["fee_token_mint"]),
				DestinationDomain: u32(t, f["destination_domain"]), Sender: pubkey(t, f["sender"]),
				TokenExchangeRate: u128(t, f["token_exchange_rate"]), GasPrice: u128(t, f["gas_price"]),
				TokenDecimals: uint8(u32(t, f["token_decimals"])), IssuedAt: i64(t, f["issued_at"]), Expiry: i64(t, f["expiry"]),
			})
		case "igp.IgpTransientQuote":
			accountCase(t, name, data, &igp.IgpTransientQuote{
				BumpSeed: uint8(u32(t, f["bump_seed"])), Payer: pubkey(t, f["payer"]), ScopedSalt: h256(t, f["scoped_salt"]),
				FeeTokenMint: pubkey(t, f["fee_token_mint"]), DestinationDomain: u32(t, f["destination_domain"]),
				Sender: pubkey(t, f["sender"]), TokenExchangeRate: u128(t, f["token_exchange_rate"]),
				GasPrice: u128(t, f["gas_price"]), TokenDecimals: uint8(u32(t, f["token_decimals"])), Expiry: i64(t, f["expiry"]),
			})
		case "igp.IgpQuoteContext":
			got, code := igp.ParseIgpQuoteContext(data)
			want := igp.IgpQuoteContext{FeeTokenMint: pubkey(t, f["fee_token_mint"]), DestinationDomain: u32(t, f["destination_domain"]), Sender: pubkey(t, f["sender"])}
			if code != 0 || got != want {
				t.Errorf("%s: %+v %#x", name, got, code)
			}
			if _, code := igp.ParseIgpQuoteContext(data[1:]); code != igp.ErrInvalidIgpQuoteContext {
				t.Errorf("%s short: %#x", name, code)
			}
		case "igp.IgpQuoteData":
			got, code := igp.ParseIgpQuoteData(data)
			want := igp.IgpQuoteData{TokenExchangeRate: u128(t, f["token_exchange_rate"]), GasPrice: u128(t, f["gas_price"]), TokenDecimals: uint8(u32(t, f["token_decimals"]))}
			if code != 0 || got != want {
				t.Errorf("%s: %+v %#x", name, got, code)
			}
			if _, code := igp.ParseIgpQuoteData(append(data, 0)); code != igp.ErrInvalidIgpQuoteData {
				t.Errorf("%s long: %#x", name, code)
			}
		case "igp.InterchainGasPaymasterType", "igp.Instruction":
			continue
		default:
			t.Errorf("unhandled golden type %s", v.Type)
			continue
		}
		seen++
	}
	if seen != 9 {
		t.Errorf("checked %d account vectors", seen)
	}
}

func TestGoldenPDASeedsErrorsConstants(t *testing.T) {
	g := testvectors.LoadGolden(t, "igp")
	for _, p := range g.PDAs {
		var seeds [][]byte
		switch p.Name {
		case "program_data":
			seeds = igp.ProgramDataPDASeeds
		case "igp", "overhead_igp", "gas_payment", "transient_quote", "standing_quote":
			// The key segments come from the golden itself; the fixed segments
			// are what this checks.
			var keys [][32]byte
			for _, s := range p.Seeds {
				if len(s) == 64 {
					var k [32]byte
					copy(k[:], testvectors.MustHex(t, s))
					keys = append(keys, k)
				}
			}
			switch p.Name {
			case "igp":
				seeds = igp.IgpPDASeeds(&keys[0])
			case "overhead_igp":
				seeds = igp.OverheadIgpPDASeeds(&keys[0])
			case "gas_payment":
				seeds = igp.GasPaymentPDASeeds(&keys[0])
			case "transient_quote":
				seeds = igp.TransientQuotePDASeeds(&keys[0], &keys[1])
			case "standing_quote":
				seeds = igp.StandingQuotePDASeeds(&keys[0], &keys[1], testvectors.MustHex(t, p.Seeds[8]), &keys[2])
			}
		default:
			if p.Name[:15] == "quote_authority" {
				seeds = igp.QuoteAuthorityPDASeeds
			} else {
				t.Errorf("unhandled PDA %s", p.Name)
				continue
			}
		}
		if len(seeds) != len(p.Seeds) {
			t.Errorf("%s: %d seeds, golden %d", p.Name, len(seeds), len(p.Seeds))
			continue
		}
		for i := range seeds {
			if hex.EncodeToString(seeds[i]) != p.Seeds[i] {
				t.Errorf("%s seed %d: %x, golden %s", p.Name, i, seeds[i], p.Seeds[i])
			}
		}
	}

	errs := map[string]uint64{
		"Error.NoGasOracleSetForDestinationDomain": igp.ErrNoGasOracleSetForDestinationDomain,
		"Error.QuoteConfigNotSet":                  igp.ErrQuoteConfigNotSet,
		"Error.InvalidIgpQuoteContext":             igp.ErrInvalidIgpQuoteContext,
		"Error.InvalidIgpQuoteData":                igp.ErrInvalidIgpQuoteData,
		"Error.NonDefaultFeeTokenMint":             igp.ErrNonDefaultFeeTokenMint,
		"Error.StandingQuoteNotExpired":            igp.ErrStandingQuoteNotExpired,
		"Error.BeneficiaryMismatch":                igp.ErrBeneficiaryMismatch,
	}
	for _, e := range g.Errors {
		if code, ok := errs[e.Name]; !ok || code != e.Code {
			t.Errorf("%s = %d, Go %d (%v)", e.Name, e.Code, code, ok)
		}
	}
	if len(g.Errors) != len(errs) {
		t.Errorf("golden has %d errors", len(g.Errors))
	}

	disc := func(d accountutils.Discriminator) string { return "0x" + hex.EncodeToString(d[:]) }
	consts := map[string]string{
		"TOKEN_EXCHANGE_RATE_SCALE":               strconv.FormatUint(igp.TokenExchangeRateScale, 10),
		"SOL_DECIMALS":                            strconv.Itoa(igp.SolDecimals),
		"GAS_PAYMENT_DISCRIMINATOR":               disc(igp.GasPaymentDiscriminator),
		"ProgramData.DISCRIMINATOR":               disc(igp.ProgramDataDiscriminator),
		"OverheadIgp.DISCRIMINATOR":               disc(igp.OverheadIgpDiscriminator),
		"Igp.DISCRIMINATOR":                       disc(igp.IgpDiscriminator),
		"IgpFeeConfig.DISCRIMINATOR":              disc(igp.IgpFeeConfigDiscriminator),
		"IgpStandingQuote.DISCRIMINATOR":          disc(igp.IgpStandingQuoteDiscriminator),
		"IgpTransientQuote.DISCRIMINATOR":         disc(igp.IgpTransientQuoteDiscriminator),
		"WILDCARD_DOMAIN":                         strconv.FormatUint(uint64(igp.WildcardDomain), 10),
		"IGP_QUOTE_CONTEXT_SIZE":                  strconv.Itoa(igp.IgpQuoteContextSize),
		"IGP_QUOTE_DATA_SIZE":                     strconv.Itoa(igp.IgpQuoteDataSize),
		"pay_for_gas_instruction.gas_payment_pda": "", // a PDA address, checked by conformance
	}
	for _, c := range g.Constants {
		if c.Name == "WILDCARD_SENDER" {
			if testvectors.Base58Key(t, c.Value) != igp.WildcardSender {
				t.Errorf("WILDCARD_SENDER %s", c.Value)
			}
			continue
		}
		want, ok := consts[c.Name]
		if !ok {
			t.Errorf("unchecked constant %s", c.Name)
			continue
		}
		if want != "" && want != c.Value {
			t.Errorf("%s = %s, Go %s", c.Name, c.Value, want)
		}
	}
}
