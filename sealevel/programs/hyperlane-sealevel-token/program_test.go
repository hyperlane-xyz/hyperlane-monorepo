package tokensynthetic_test

import (
	"bytes"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	tt "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/tokentest"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	tokensynthetic "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/programs/hyperlane-sealevel-token"
	"gosvm/solana"
)

// Every golden SyntheticPlugin account decodes, re-encodes byte-identically and
// matches the golden fields.
func TestGoldenAccounts(t *testing.T) {
	g := tt.LoadGolden(t, "token")
	n := 0
	for _, v := range g.Values {
		if v.Type != "token.HyperlaneToken<SyntheticPlugin>" {
			continue
		}
		n++
		data := testvectors.MustHex(t, v.Hex)
		tok := new(tokensynthetic.Token)
		c := solana.Context{Accounts: []solana.Account{{Data: data}}}
		if code := tokenlib.FetchToken(c, 0, tok); code != 0 {
			t.Fatalf("%s: fetch %#x", *v.Name, code)
		}
		buf := make([]byte, len(data))
		if !accountutils.StoreInSlice(buf, tok) || !bytes.Equal(buf, data) {
			t.Errorf("%s: store %x\nRust %x", *v.Name, buf, data)
		}
		if got := accountutils.AccountDataSize(tok); got < uint64(len(data)) {
			t.Errorf("%s: size %d < %d", *v.Name, got, len(data))
		}
		p := &tok.PluginData
		tt.SameJSON(t, *v.Name, tt.Token(tok, map[string]any{"mint": tt.B58(p.Mint), "mint_bump": p.MintBump, "ata_payer_bump": p.ATAPayerBump}), v.Fields)
	}
	if n != 1 {
		t.Errorf("%d vectors", n)
	}
	seeds := map[string][][]byte{"mint": tokensynthetic.MintPDASeeds, "ata_payer (synthetic program macro)": tokensynthetic.ATAPayerPDASeeds}
	for _, p := range g.PDAs {
		want, ok := seeds[p.Name]
		if !ok {
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
}
