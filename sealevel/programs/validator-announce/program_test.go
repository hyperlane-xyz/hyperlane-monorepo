package validatorannounce_test

import (
	"bytes"
	"fmt"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/svmtest"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	program "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/programs/validator-announce"
	"gosvm/solana"
)

const group = "validator-announce"

// The goldens' program ID and its validator_announce bump.
var programID = testvectors.Base58Key(&testing.T{}, "BwsmtJXzMyPvADqhXXsWnQa9FGWDdvrcWmxYTxBWnMck")

const vaBump = 253

// Bump the Rust vectors' account_storage_locations uses.
const storageBump = 254

func vec(t *testing.T, name string) []byte {
	v, ok := testvectors.Rust(t, group)[name]
	if !ok {
		t.Fatalf("no vector %s", name)
	}
	return v.Bytes(t)
}

func decodeIx(t *testing.T, b []byte) program.Instruction {
	var ix program.Instruction
	r := borsh.NewReader(b)
	ix.DecodeBorsh(&r)
	if !r.Done() {
		t.Fatalf("decode %x", b)
	}
	return ix
}

func encode(ix *program.Instruction) []byte {
	w := borsh.NewWriter(0)
	ix.EncodeBorsh(&w)
	return w.Bytes()
}

func accountBytes(v accountutils.Encoder, size int) []byte {
	b := make([]byte, size)
	if !accountutils.StoreInSlice(b, v) {
		panic("too small")
	}
	return b
}

func payer(signer bool) solana.Account {
	return solana.Account{Key: bytes.Repeat([]byte{7}, 32), Owner: make([]byte, 32), Signer: signer, Writable: true, Lamports: 1e12}
}

// setup is an initialized program (mailbox/domain from the init vector)
// with accounts payer, system, VA PDA, storage PDA and replay PDA for
// announcement i.
func setup(t *testing.T, i int) (*svmtest.Runtime, []byte) {
	r := svmtest.New(t, programID, group)
	vaKey := r.Bump(program.ValidatorAnnouncePDASeeds, vaBump)
	init := decodeIx(t, vec(t, "ix_init"))
	va := program.ValidatorAnnounce{BumpSeed: vaBump, Mailbox: init.Mailbox, LocalDomain: init.LocalDomain}
	data := vec(t, fmt.Sprintf("ix_announce_%d", i))
	ix := decodeIx(t, data)
	storage := r.Bump(program.StorageLocationsPDASeeds(&ix.Validator), storageBump)
	replayID := vec(t, fmt.Sprintf("announcement_%d_replay_id", i))
	var id [32]byte
	copy(id[:], replayID)
	replay := svmtest.PDA(program.ReplayProtectionPDASeeds(&id), 255, programID)
	r.Account(payer(true))
	r.Account(svmtest.SystemProgram())
	r.Account(solana.Account{Key: vaKey[:], Owner: programID[:], Data: accountBytes(&va, 38), Lamports: svmtest.MinimumBalance(38)})
	r.Account(solana.Account{Key: storage[:], Owner: make([]byte, 32), Writable: true})
	r.Account(solana.Account{Key: replay[:], Owner: make([]byte, 32), Writable: true})
	return r, data
}

func TestRustVectors(t *testing.T) {
	for _, name := range []string{"ix_init", "ix_announce_0", "ix_announce_1", "ix_announce_2"} {
		b := vec(t, name)
		ix := decodeIx(t, b)
		if !bytes.Equal(encode(&ix), b) {
			t.Errorf("%s re-encode", name)
		}
	}
	for _, name := range []string{"ix_reject_tag_2", "ix_reject_trailing", "ix_reject_bad_utf8"} {
		if code := svmtest.New(t, programID).Run(program.Process, vec(t, name)); code != svm.InvalidInstructionData {
			t.Errorf("%s: %#x", name, code)
		}
	}
	b := vec(t, "account_validator_announce")
	va, ok, code := accountutils.Fetch[program.ValidatorAnnounce](b)
	if !ok || code != 0 || !bytes.Equal(accountBytes(&va, len(b)), b) || accountutils.AccountDataSize(&va) != uint64(len(b)) {
		t.Errorf("account_validator_announce")
	}
	b = vec(t, "account_storage_locations")
	sl, ok, code := accountutils.Fetch[program.StorageLocations](b)
	if !ok || code != 0 || !bytes.Equal(accountBytes(&sl, len(b)), b) || accountutils.AccountDataSize(&sl) != uint64(len(b)) {
		t.Errorf("account_storage_locations")
	}
	var rp program.ReplayProtection
	if !bytes.Equal(accountBytes(&rp, 1), vec(t, "account_replay_protection")) {
		t.Errorf("account_replay_protection")
	}
	for i := 0; i < 3; i++ {
		ix := decodeIx(t, vec(t, fmt.Sprintf("ix_announce_%d", i)))
		r := svmtest.New(t, programID)
		var got [32]byte
		code := r.Run(func(c solana.Context) uint64 {
			var s uint64
			got, s = program.ReplayID(c, &ix.Validator, ix.StorageLocation)
			return s
		}, nil)
		if code != 0 || !bytes.Equal(got[:], vec(t, fmt.Sprintf("announcement_%d_replay_id", i))) {
			t.Errorf("replay id %d: %x", i, got)
		}
	}
}

func TestGoldens(t *testing.T) {
	g := testvectors.LoadGolden(t, "validator_announce")
	for _, v := range g.Values {
		b := testvectors.MustHex(t, v.Hex)
		var out []byte
		switch v.Type {
		case "validator_announce.Instruction":
			ix := decodeIx(t, b)
			want := map[string]uint8{"Init": 0, "Announce": 1}[*v.Variant]
			if ix.Kind != want {
				t.Errorf("%s kind %d", *v.Variant, ix.Kind)
			}
			out = encode(&ix)
		case "validator_announce.ValidatorAnnounce":
			x, ok, _ := accountutils.Fetch[program.ValidatorAnnounce](b)
			if !ok {
				t.Errorf("%s", v.Type)
			}
			out = accountBytes(&x, len(b))
		case "validator_announce.ValidatorStorageLocations":
			x, ok, _ := accountutils.Fetch[program.StorageLocations](b)
			if !ok || accountutils.AccountDataSize(&x) != uint64(len(b)) {
				t.Errorf("%s %s", v.Type, *v.Name)
			}
			out = accountBytes(&x, len(b))
		case "validator_announce.ReplayProtection":
			var x program.ReplayProtection
			out = accountBytes(&x, 1)
		default:
			t.Errorf("unhandled golden %s", v.Type)
		}
		if !bytes.Equal(out, b) {
			t.Errorf("%s: %x, Rust %x", v.Type, out, b)
		}
	}
	for _, p := range g.PDAs {
		seeds := make([][]byte, len(p.Seeds))
		for i, s := range p.Seeds {
			seeds[i] = testvectors.MustHex(t, s)
		}
		var want [][]byte
		switch p.Name {
		case "validator_announce":
			want = program.ValidatorAnnouncePDASeeds
		case "validator_storage_locations":
			var v [20]byte
			copy(v[:], seeds[4])
			want = program.StorageLocationsPDASeeds(&v)
		case "replay_protection":
			var id [32]byte
			copy(id[:], seeds[4])
			want = program.ReplayProtectionPDASeeds(&id)
		default:
			t.Fatalf("unhandled PDA %s", p.Name)
		}
		if fmt.Sprint(seeds) != fmt.Sprint(want) {
			t.Errorf("%s seeds", p.Name)
		}
		if svmtest.PDA(want, p.Bump, testvectors.Base58Key(t, p.ProgramID)) != testvectors.Base58Key(t, p.Address) {
			t.Errorf("%s address", p.Name)
		}
	}
	for _, e := range g.Errors {
		want := map[string]uint64{"Error.SignatureError": program.ErrSignatureError, "Error.SignerMismatch": program.ErrSignerMismatch}[e.Name]
		if want != e.Code {
			t.Errorf("%s = %d", e.Name, e.Code)
		}
	}
	// replay_id constant: the Announce value's replay ID.
	for _, cst := range g.Constants {
		if cst.Name != "AnnounceInstruction.replay_id" {
			continue
		}
		for _, v := range g.Values {
			if v.Type == "validator_announce.Instruction" && *v.Variant == "Announce" {
				ix := decodeIx(t, testvectors.MustHex(t, v.Hex))
				var got [32]byte
				svmtest.New(t, programID).Run(func(c solana.Context) uint64 {
					got, _ = program.ReplayID(c, &ix.Validator, ix.StorageLocation)
					return 0
				}, nil)
				if !bytes.Equal(got[:], testvectors.MustHex(t, cst.Value)) {
					t.Errorf("replay_id %x", got)
				}
			}
		}
	}
	vaKey := svmtest.PDA(program.ValidatorAnnouncePDASeeds, vaBump, programID)
	for _, ix := range testvectors.GoldenInstructions(t, "validator_announce") {
		if ix.Name != "init_instruction" {
			t.Fatalf("unhandled golden instruction %s", ix.Name)
		}
		want := []testvectors.GoldenMeta{
			{Pubkey: ix.Accounts[0].Pubkey, IsSigner: true},
			{Pubkey: testvectors.Base58([32]byte{})},
			{Pubkey: testvectors.Base58(vaKey), IsWritable: true},
		}
		if fmt.Sprint(ix.Accounts) != fmt.Sprint(want) {
			t.Errorf("init accounts %v", ix.Accounts)
		}
		decodeIx(t, testvectors.MustHex(t, ix.Hex))
	}
}

func TestInit(t *testing.T) {
	data := vec(t, "ix_init")
	ix := decodeIx(t, data)
	newRT := func() (*svmtest.Runtime, [32]byte) {
		r := svmtest.New(t, programID)
		return r, r.Bump(program.ValidatorAnnouncePDASeeds, vaBump)
	}
	r, vaKey := newRT()
	r.Account(payer(true))
	r.Account(svmtest.SystemProgram())
	r.Account(solana.Account{Key: vaKey[:], Owner: make([]byte, 32), Writable: true})
	if code := r.Run(program.Process, data); code != 0 {
		t.Fatalf("init: %#x", code)
	}
	want := program.ValidatorAnnounce{BumpSeed: vaBump, Mailbox: ix.Mailbox, LocalDomain: ix.LocalDomain}
	if !bytes.Equal(r.Accounts[2].Data, accountBytes(&want, 38)) || len(r.CPIs) != 1 || r.CPIs[0].Space != 38 {
		t.Fatalf("va account %x, CPIs %+v", r.Accounts[2].Data, r.CPIs)
	}
	if code := r.Run(program.Process, data); code != svm.AccountAlreadyInitialized {
		t.Fatalf("second init: %#x", code)
	}
	empty := solana.Account{Key: vaKey[:], Owner: make([]byte, 32), Writable: true}
	other := payer(false)
	other.Key = bytes.Repeat([]byte{9}, 32)
	withData := empty
	withData.Data = []byte{0}
	readonly := empty
	readonly.Writable = false
	for _, tc := range []struct {
		name     string
		accounts []solana.Account
		code     uint64
	}{
		{"no accounts", nil, svm.NotEnoughAccountKeys},
		{"not signer", []solana.Account{payer(false)}, svm.MissingRequiredSignature},
		{"no system", []solana.Account{payer(true)}, svm.NotEnoughAccountKeys},
		{"wrong system", []solana.Account{payer(true), other}, svm.IncorrectProgramID},
		{"no va", []solana.Account{payer(true), svmtest.SystemProgram()}, svm.NotEnoughAccountKeys},
		{"va readonly", []solana.Account{payer(true), svmtest.SystemProgram(), readonly}, svm.InvalidAccountData},
		{"va has data", []solana.Account{payer(true), svmtest.SystemProgram(), withData}, svm.AccountAlreadyInitialized},
		{"wrong va", []solana.Account{payer(true), svmtest.SystemProgram(), func() solana.Account { a := empty; a.Key = other.Key; return a }()}, svm.IncorrectProgramID},
	} {
		r, _ := newRT()
		for _, a := range tc.accounts {
			r.Account(a)
		}
		if code := r.Run(program.Process, data); code != tc.code {
			t.Errorf("%s: %#x, want %#x", tc.name, code, tc.code)
		}
	}
}

func TestAnnounce(t *testing.T) {
	r, data0 := setup(t, 0)
	ix0 := decodeIx(t, data0)
	if code := r.Run(program.Process, data0); code != 0 {
		t.Fatalf("announce 0: %#x", code)
	}
	first := program.StorageLocations{BumpSeed: storageBump, StorageLocations: []string{ix0.StorageLocation}}
	size := int(accountutils.AccountDataSize(&first))
	if !bytes.Equal(r.Accounts[3].Data, accountBytes(&first, size)) || !bytes.Equal(r.Accounts[3].Owner, programID[:]) {
		t.Fatalf("storage locations %x", r.Accounts[3].Data)
	}
	if !bytes.Equal(r.Accounts[4].Data, []byte{0}) || !bytes.Equal(r.Accounts[4].Owner, programID[:]) {
		t.Fatalf("replay protection %x", r.Accounts[4].Data)
	}
	if len(r.CPIs) != 2 || r.CPIs[0].Space != uint64(size) || r.CPIs[1].Space != 1 {
		t.Fatalf("CPIs %+v", r.CPIs)
	}
	if code := r.Run(program.Process, data0); code != svm.AccountAlreadyInitialized {
		t.Fatalf("replayed announce: %#x", code)
	}

	// Second location for the same validator: append, top up rent, grow.
	r1, data1 := setup(t, 1)
	r1.Accounts[3] = r.Accounts[3]
	before := r1.Accounts[3].Lamports
	if code := r1.Run(program.Process, data1); code != 0 {
		t.Fatalf("announce 1: %#x", code)
	}
	if !bytes.Equal(r1.Accounts[3].Data, vec(t, "account_storage_locations")) {
		t.Fatalf("storage locations %x", r1.Accounts[3].Data)
	}
	grown := uint64(len(r1.Accounts[3].Data))
	if len(r1.CPIs) != 2 || r1.CPIs[0].Instruction != 2 || r1.CPIs[0].Lamports != svmtest.MinimumBalance(grown)-before {
		t.Fatalf("CPIs %+v", r1.CPIs)
	}
}

func TestAnnounceErrors(t *testing.T) {
	_, data2 := setup(t, 2)
	ix2 := decodeIx(t, data2)
	withSig := func(sig []byte) []byte {
		ix := ix2
		ix.Signature = sig
		return encode(&ix)
	}
	highS := append([]byte(nil), ix2.Signature...)
	for i := 32; i < 64; i++ {
		highS[i] = 0xff
	}
	unrecoverable := append([]byte(nil), ix2.Signature...)
	unrecoverable[0] ^= 1
	otherValidator := ix2
	otherValidator.Validator[0] ^= 1
	for _, tc := range []struct {
		name string
		edit func(r *svmtest.Runtime)
		data []byte
		code uint64
	}{
		{"ok", nil, data2, 0},
		{"payer not signer", func(r *svmtest.Runtime) { r.Accounts[0].Signer = false }, data2, svm.MissingRequiredSignature},
		{"wrong system", func(r *svmtest.Runtime) { r.Accounts[1] = payer(false) }, data2, svm.IncorrectProgramID},
		{"no va", func(r *svmtest.Runtime) { r.Accounts = r.Accounts[:2] }, data2, svm.NotEnoughAccountKeys},
		{"va corrupt", func(r *svmtest.Runtime) { r.Accounts[2].Data = []byte{1, 1} }, data2, svm.BorshIoError},
		{"va wrong owner", func(r *svmtest.Runtime) { r.Accounts[2].Owner = make([]byte, 32) }, data2, svm.InvalidAccountData},
		{"va wrong key", func(r *svmtest.Runtime) { r.Accounts[2].Key = bytes.Repeat([]byte{3}, 32) }, data2, svm.InvalidAccountData},
		{"no storage", func(r *svmtest.Runtime) { r.Accounts = r.Accounts[:3] }, data2, svm.NotEnoughAccountKeys},
		{"no replay", func(r *svmtest.Runtime) { r.Accounts = r.Accounts[:4] }, data2, svm.NotEnoughAccountKeys},
		{"wrong replay", func(r *svmtest.Runtime) { r.Accounts[4].Key = bytes.Repeat([]byte{3}, 32) }, data2, svm.IncorrectProgramID},
		{"replay readonly", func(r *svmtest.Runtime) { r.Accounts[4].Writable = false }, data2, svm.InvalidAccountData},
		{"replay has data", func(r *svmtest.Runtime) { r.Accounts[4].Data = []byte{0} }, data2, svm.AccountAlreadyInitialized},
		{"short signature", nil, withSig(ix2.Signature[:64]), program.ErrSignatureError},
		{"high s", nil, withSig(highS), program.ErrSignatureError},
		{"unrecoverable", nil, withSig(unrecoverable), program.ErrSignatureError},
		{"wrong domain", func(r *svmtest.Runtime) {
			va, _, _ := accountutils.Fetch[program.ValidatorAnnounce](r.Accounts[2].Data)
			va.LocalDomain = 2
			r.Accounts[2].Data = accountBytes(&va, 38)
		}, data2, svm.InvalidAccountData},
		{"wrong storage key", func(r *svmtest.Runtime) { r.Accounts[3].Key = bytes.Repeat([]byte{3}, 32) }, data2, svm.IncorrectProgramID},
		{"wrong existing storage key", func(r *svmtest.Runtime) {
			sl := program.StorageLocations{BumpSeed: storageBump}
			r.Accounts[3] = solana.Account{Key: bytes.Repeat([]byte{3}, 32), Owner: programID[:], Writable: true, Data: accountBytes(&sl, 6), Lamports: 1}
		}, data2, svm.IncorrectProgramID},
		{"existing storage corrupt", func(r *svmtest.Runtime) {
			r.Accounts[3] = solana.Account{Key: r.Accounts[3].Key, Owner: programID[:], Writable: true, Data: []byte{1, 254, 5}, Lamports: 1}
		}, data2, svm.BorshIoError},
	} {
		r, _ := setup(t, 2)
		if tc.edit != nil {
			tc.edit(r)
		}
		if code := r.Run(program.Process, tc.data); code != tc.code {
			t.Errorf("%s: %#x, want %#x", tc.name, code, tc.code)
		}
	}
	// A different claimed validator: the replay PDA changes first.
	r, _ := setup(t, 2)
	if code := r.Run(program.Process, encode(&otherValidator)); code != svm.IncorrectProgramID {
		t.Errorf("other validator: %#x", code)
	}
}

func TestGetProgramVersion(t *testing.T) {
	r := svmtest.New(t, programID)
	if code := r.Run(program.Process, packageversioned.GetProgramVersionDiscriminator[:]); code != 0 || !bytes.Equal(r.Return, []byte{5, 0, 0, 0, '1', '.', '0', '.', '0', 0xff}) {
		t.Fatalf("%#x %x", code, r.Return)
	}
	for _, data := range [][]byte{nil, {2}, {0}, {1}} {
		if code := r.Run(program.Process, data); code != svm.InvalidInstructionData {
			t.Errorf("%x: %#x", data, code)
		}
	}
}
