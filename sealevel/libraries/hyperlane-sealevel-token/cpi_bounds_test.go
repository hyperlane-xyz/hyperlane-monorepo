package tokenlib

import (
	"bytes"
	"crypto/sha256"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// boundsPlugin is a minimal plugin whose fee beneficiary is the owner key
// itself (like the native plugin).
type boundsPlugin struct{}

func (*boundsPlugin) EncodeBorsh(*borsh.Writer) {}
func (*boundsPlugin) DecodeBorsh(*borsh.Reader) {}
func (*boundsPlugin) Size() int                 { return 0 }
func (*boundsPlugin) Initialize(solana.Context, *svm.Pubkey, *svm.AccountIter, uint64, uint64, uint64) uint64 {
	return 0
}
func (*boundsPlugin) TransferIn(solana.Context, *svm.Pubkey, uint8, uint64, *svm.AccountIter, uint64, Fee) uint64 {
	return 0
}
func (*boundsPlugin) FeeBeneficiary(_ solana.Context, owner *svm.Pubkey) (svm.Pubkey, uint64) {
	return *owner, 0
}
func (*boundsPlugin) TransferOut(solana.Context, *svm.Pubkey, uint8, uint64, uint64, *svm.AccountIter, uint64) uint64 {
	return 0
}
func (*boundsPlugin) TransferOutAccountMetas(solana.Context, *svm.Pubkey, *hyperlanecore.H256) ([]accountmeta.SerializableAccountMeta, bool, uint64) {
	return nil, false, 0
}

func boundsKey(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

// fakeDerive is a deterministic stand-in for create_program_address: never
// on-curve, so every PDA search stops at bump 255.
func fakeDerive(seeds, program, output []byte) uint64 {
	h := sha256.Sum256(append(append([]byte{}, seeds...), program...))
	copy(output, h[:])
	return 0
}

type cpiRecord struct {
	program uint64
	metas   []byte
}

func boundsContext(accounts []solana.Account, ret []byte, setter []byte, cpis *[]cpiRecord) solana.Context {
	return solana.Context{
		Accounts:      accounts,
		DeriveAddress: fakeDerive,
		InvokeInstruction: func(program uint64, metas, data, signerSeeds []byte) uint64 {
			*cpis = append(*cpis, cpiRecord{program, append([]byte{}, metas...)})
			return 0
		},
		ReadReturnData: func() ([]byte, []byte) { return ret, setter },
	}
}

func metaFlags(metas []byte) []byte {
	var out []byte
	for off := 0; off < len(metas); off += 9 {
		out = append(out, metas[off+8])
	}
	return out
}

// QuoteFee carries the fee account, the sender and up to
// MaxFeeVariableAccounts (15) variable accounts: 17 metas, over goSVM
// integration 1's 16-meta CPI limit.
func TestQuoteFeeAtMaxVariableAccounts(t *testing.T) {
	for _, variable := range []int{MaxFeeVariableAccounts, MaxFeeVariableAccounts + 1} {
		feeProgram, feeAccount, beneficiary := boundsKey(0xf0), boundsKey(0xfa), boundsKey(0xbe)
		feeData := append([]byte{1}, feeAccountDiscriminator[:]...)
		feeData = append(feeData, 0, 0) // bump, owner None
		feeData = append(feeData, beneficiary...)
		feeData = append(feeData, 7, 0, 0, 0) // domain_id
		accounts := []solana.Account{
			{Key: boundsKey(1), Owner: make([]byte, 32), Signer: true, Writable: true},
			{Key: feeProgram, Owner: make([]byte, 32), Executable: true},
			{Key: feeAccount, Owner: feeProgram, Data: feeData},
		}
		for j := 0; j < variable; j++ {
			accounts = append(accounts, solana.Account{Key: boundsKey(byte(0x10 + j)), Owner: make([]byte, 32), Writable: j%2 == 0})
		}
		accounts = append(accounts, solana.Account{Key: beneficiary, Owner: make([]byte, 32), Writable: true})
		var cpis []cpiRecord
		c := boundsContext(accounts, []byte{42, 0, 0, 0, 0, 0, 0, 0}, feeProgram, &cpis)

		tok := new(HyperlaneToken[boundsPlugin, *boundsPlugin])
		tok.FeeConfig = borsh.SomeOf(FeeConfig{FeeProgram: svm.Pubkey(feeProgram), FeeAccount: svm.Pubkey(feeAccount)})
		it := svm.NewAccountIter(c)
		it.Next() // sender
		var recipient, router hyperlanecore.H256
		fee, code := ParseFeeSectionAndQuote(c, tok, 0, &it, 9, &recipient, 1000, &router)
		if variable > MaxFeeVariableAccounts {
			if code != ErrFeeBeneficiaryNotFound {
				t.Fatalf("%d variable accounts: code %#x", variable, code)
			}
			continue
		}
		if code != 0 || !fee.Some || fee.Amount != 42 || fee.Beneficiary != uint64(len(accounts)-1) {
			t.Fatalf("code %#x fee %+v", code, fee)
		}
		if len(cpis) != 1 || cpis[0].program != 1 {
			t.Fatalf("cpis %+v", cpis)
		}
		flags := metaFlags(cpis[0].metas)
		if len(flags) != 2+MaxFeeVariableAccounts {
			t.Fatalf("QuoteFee has %d metas, want 17", len(flags))
		}
		if flags[0] != 0 || flags[1] != 3 {
			t.Fatalf("fee account / sender flags %v", flags[:2])
		}
		for j := 0; j < variable; j++ {
			want := byte(0)
			if j%2 == 0 {
				want = 1
			}
			if flags[2+j] != want {
				t.Fatalf("variable %d flags %d, want %d", j, flags[2+j], want)
			}
		}
	}
}

// A quoted PayForGas through an overhead IGP carries 6 fixed metas, up to
// MaxIgpVariableAccounts (15) quote accounts and the configured overhead
// IGP: 22 metas.
func TestQuotedOverheadPayForGasAtMaxVariableAccounts(t *testing.T) {
	programID := svm.Pubkey(boundsKey(0x77))
	igpProgram, overhead := boundsKey(0x11), boundsKey(0x0e)
	cfg := &cc.IGPConfig{Program: svm.Pubkey(igpProgram), Type: cc.InterchainGasPaymasterType{Kind: cc.IGPTypeOverheadIgp, Key: svm.Pubkey(overhead)}}

	var authority svm.Pubkey
	c0 := solana.Context{DeriveAddress: fakeDerive}
	authority, _, code := IgpQuoteAuthorityPDA.Find(c0, &programID)
	if code != 0 {
		t.Fatal(code)
	}

	// Inner IGP: initialized Igp with an IgpFeeConfig, so the flow is quoted.
	igp := append([]byte{1}, igpDiscriminator[:]...)
	igp = append(igp, 0)                   // bump
	igp = append(igp, make([]byte, 32)...) // salt
	igp = append(igp, 0)                   // owner None
	igp = append(igp, make([]byte, 32)...) // beneficiary
	igp = append(igp, 0, 0, 0, 0)          // no gas oracles
	igp = append(igp, igpFeeConfigDiscriminator[:]...)
	igp = append(igp, 0, 0, 0, 0)         // no signers
	igp = append(igp, 7, 0, 0, 0)         // domain_id
	igp = append(igp, make([]byte, 8)...) // min_issued_at

	none := make([]byte, 32)
	accounts := []solana.Account{
		{Key: none, Owner: none, Executable: true},                     // 0 system program
		{Key: boundsKey(1), Owner: none, Signer: true, Writable: true}, // 1 sender
		{Key: boundsKey(2), Owner: none, Signer: true},                 // 2 unique message
		{Key: igpProgram, Owner: none, Executable: true},               // 3 IGP program
		{Key: boundsKey(4), Owner: igpProgram, Writable: true},         // 4 program data
		{Key: boundsKey(5), Owner: none, Writable: true},               // 5 gas payment PDA
		{Key: authority[:], Owner: none},                               // pre[0] quote authority
		{Key: programID[:], Owner: none, Executable: true},             // pre[1] quoting program
	}
	for j := 2; j < MaxIgpVariableAccounts; j++ {
		accounts = append(accounts, solana.Account{Key: boundsKey(byte(0x20 + j)), Owner: none, Writable: j%2 == 0})
	}
	accounts = append(accounts,
		solana.Account{Key: overhead, Owner: igpProgram},                                   // configured overhead IGP
		solana.Account{Key: boundsKey(0x1a), Owner: igpProgram, Data: igp, Writable: true}, // inner IGP
	)
	var cpis []cpiRecord
	c := boundsContext(accounts, nil, nil, &cpis)
	c.DeriveAddress = fakeDerive
	it := svm.NewAccountIter(c)
	for j := 0; j < 3; j++ {
		it.Next()
	}
	p, code := parseIGPAccounts(c, &programID, cfg, 0, 1, 2, &it)
	if code != 0 {
		t.Fatalf("code %#x", code)
	}
	if !p.quoted || p.program != 3 {
		t.Fatalf("payment %+v", p)
	}
	if n := len(p.metas.Bytes()) / 9; n != 6+MaxIgpVariableAccounts+1 {
		t.Fatalf("PayForGas has %d metas, want 22", n)
	}
	// Too many variable accounts is ExtraneousAccount, as in Rust.
	accounts = append(accounts[:6+MaxIgpVariableAccounts], append([]solana.Account{{Key: boundsKey(0x55), Owner: none}}, accounts[6+MaxIgpVariableAccounts:]...)...)
	c.Accounts = accounts
	it = svm.NewAccountIter(c)
	for j := 0; j < 3; j++ {
		it.Next()
	}
	if _, code := parseIGPAccounts(c, &programID, cfg, 0, 1, 2, &it); code != ErrExtraneousAccount {
		t.Fatalf("16 variable accounts: code %#x", code)
	}
}

// svm.Metas holds goSVM's 64-meta CPI maximum.
func TestMetasHoldMaxCPIMetas(t *testing.T) {
	m := new(svm.Metas)
	for i := 0; i < svm.MaxCPIMetas; i++ {
		m.Add(uint64(i), i%2 == 0, i%3 == 0)
	}
	if len(m.Bytes()) != 9*svm.MaxCPIMetas {
		t.Fatal(len(m.Bytes()))
	}
}
