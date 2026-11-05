// Package tokentest renders the token programs' Go values in the shared
// golden `fields` JSON format, for native tests only (never on chain).
package tokentest

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
	"reflect"
	"strconv"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
)

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// B58 encodes a public key in base58.
func B58(k [32]byte) string {
	n := new(big.Int).SetBytes(k[:])
	var out []byte
	mod := new(big.Int)
	base := big.NewInt(58)
	for n.Sign() > 0 {
		n.DivMod(n, base, mod)
		out = append([]byte{alphabet[mod.Int64()]}, out...)
	}
	for i := 0; i < 32 && k[i] == 0; i++ {
		out = append([]byte{'1'}, out...)
	}
	return string(out)
}

// Hex is 0x-prefixed hex.
func Hex(b []byte) string { return "0x" + hex.EncodeToString(b) }

// U64 is a decimal string.
func U64(v uint64) string { return strconv.FormatUint(v, 10) }

// U256 is a decimal string.
func U256(v borsh.U256) string {
	n := new(big.Int)
	for i := 3; i >= 0; i-- {
		n.Lsh(n, 64)
		n.Or(n, new(big.Int).SetUint64(v[i]))
	}
	return n.String()
}

// OptKey renders Option<Pubkey>.
func OptKey(o borsh.Option[[32]byte]) any {
	if !o.Some {
		return nil
	}
	return B58(o.Value)
}

// IGPType renders InterchainGasPaymasterType.
func IGPType(t cc.InterchainGasPaymasterType) any {
	name := "Igp"
	if t.Kind == cc.IGPTypeOverheadIgp {
		name = "OverheadIgp"
	}
	return map[string]any{name: B58(t.Key)}
}

// OptIGP renders Option<(Pubkey, InterchainGasPaymasterType)>.
func OptIGP(o borsh.Option[cc.IGPConfig]) any {
	if !o.Some {
		return nil
	}
	return []any{B58(o.Value.Program), IGPType(o.Value.Type)}
}

// FeeConfig renders Option<FeeConfig>.
func FeeConfig(o borsh.Option[tokenlib.FeeConfig]) any {
	if !o.Some {
		return nil
	}
	return map[string]any{"fee_program": B58(o.Value.FeeProgram), "fee_account": B58(o.Value.FeeAccount)}
}

// Token renders HyperlaneToken with the plugin's own fields.
func Token[T any, P tokenlib.PluginData[T]](tok *tokenlib.HyperlaneToken[T, P], plugin any) map[string]any {
	gas := []any{}
	for _, p := range tok.DestinationGas {
		gas = append(gas, []any{p.Key, U64(p.Value)})
	}
	routers := []any{}
	for _, p := range tok.RemoteRouters {
		routers = append(routers, []any{p.Key, Hex(p.Value[:])})
	}
	return map[string]any{
		"bump":                       tok.Bump,
		"mailbox":                    B58(tok.Mailbox),
		"mailbox_process_authority":  B58(tok.MailboxProcessAuthority),
		"dispatch_authority_bump":    tok.DispatchAuthorityBump,
		"decimals":                   tok.Decimals,
		"remote_decimals":            tok.RemoteDecimals,
		"owner":                      OptKey(tok.Owner),
		"interchain_security_module": OptKey(tok.InterchainSecurityModule),
		"interchain_gas_paymaster":   OptIGP(tok.InterchainGasPaymaster),
		"destination_gas":            gas,
		"remote_routers":             routers,
		"plugin_data":                plugin,
		"fee_config":                 FeeConfig(tok.FeeConfig),
	}
}

// LoadGolden loads a shared Sealevel golden.
func LoadGolden(t *testing.T, name string) testvectors.Golden {
	t.Helper()
	return testvectors.LoadGolden(t, name)
}

// SameJSON fails unless got marshals to the same JSON value as want.
func SameJSON(t *testing.T, what string, got any, want json.RawMessage) {
	t.Helper()
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	if err := json.Unmarshal(raw, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &b); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Errorf("%s fields:\n got %s\nwant %s", what, raw, want)
	}
}
