package accountutils_test

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

type storage struct{ Accept bool }

func (s *storage) EncodeBorsh(w *borsh.Writer) { w.Bool(s.Accept) }
func (s *storage) DecodeBorsh(r *borsh.Reader) { s.Accept = r.Bool() }
func (s *storage) Size() int                   { return 1 }

// foo mirrors the generator's Foo { a: u64 } with discriminator [2; 8].
type foo struct{ A uint64 }

var fooDiscriminator = accountutils.Discriminator{2, 2, 2, 2, 2, 2, 2, 2}

func (f *foo) EncodeBorsh(w *borsh.Writer) { w.U64(f.A) }
func (f *foo) DecodeBorsh(r *borsh.Reader) { f.A = r.U64() }

// withTail mirrors WithTail { a: u32, tail: OptionalDiscriminatedData<Foo> }.
type withTail struct {
	A    uint32
	Tail borsh.Option[foo]
}

func (v *withTail) EncodeBorsh(w *borsh.Writer) {
	w.U32(v.A)
	accountutils.WriteOptionalDiscriminated(w, fooDiscriminator, &v.Tail)
}

func (v *withTail) DecodeBorsh(r *borsh.Reader) {
	v.A = r.U32()
	v.Tail = accountutils.ReadOptionalDiscriminated[foo](r, fooDiscriminator)
}

func encode(e accountutils.Encoder) []byte {
	w := borsh.NewWriter(0)
	e.EncodeBorsh(&w)
	return w.Bytes()
}

func TestRustVectors(t *testing.T) {
	v := testvectors.Rust(t, "account-utils")

	buf := bytes.Repeat([]byte{0xff}, 4)
	if !accountutils.StoreInSlice(buf, &storage{Accept: true}) || !bytes.Equal(buf, v["account_data_store_in_slice_zeroes_tail"].Bytes(t)) {
		t.Errorf("store_in_slice = %x", buf)
	}
	buf = make([]byte, 2)
	accountutils.StoreInSlice(buf, &storage{})
	if !bytes.Equal(buf, v["account_data_test_ism_rejecting"].Bytes(t)) {
		t.Errorf("rejecting storage = %x", buf)
	}

	w := borsh.NewWriter(0)
	accountutils.WriteDiscriminator(&w, fooDiscriminator)
	(&foo{A: 1}).EncodeBorsh(&w)
	if want := v["discriminator_prefixed_foo"].Bytes(t); !bytes.Equal(w.Bytes(), want) {
		t.Errorf("DiscriminatorPrefixed = %x, Rust %x", w.Bytes(), want)
	}
	r := borsh.NewReader(v["reject_discriminator_mismatch"].Bytes(t))
	accountutils.ReadDiscriminator(&r, fooDiscriminator)
	if r.Ok() {
		t.Error("discriminator mismatch accepted")
	}

	for name, want := range map[string]withTail{
		"optional_discriminated_some":       {A: 5, Tail: borsh.SomeOf(foo{A: 7})},
		"optional_discriminated_none":       {A: 5},
		"optional_discriminated_stale_tail": {A: 5},
		"optional_discriminated_short_tail": {A: 5},
	} {
		b := v[name].Bytes(t)
		r := borsh.NewReader(b)
		var got withTail
		got.DecodeBorsh(&r)
		if !r.Ok() || got != want {
			t.Errorf("%s: decoded %+v ok=%v", name, got, r.Ok())
		}
		if name == "optional_discriminated_some" || name == "optional_discriminated_none" {
			if enc := encode(&want); !bytes.Equal(enc, b) {
				t.Errorf("%s: encode %x, Rust %x", name, enc, b)
			}
		}
	}
}

func TestFetch(t *testing.T) {
	for _, tc := range []struct {
		data        []byte
		accept, ini bool
		code        uint64
	}{
		{nil, false, false, 0},
		{[]byte{0, 1}, false, false, 0},
		{[]byte{1, 1}, true, true, 0},
		{[]byte{1, 1, 9, 9}, true, true, 0},
		{[]byte{1, 0}, false, true, 0},
		{[]byte{2, 1}, false, false, svm.BorshIoError},
		{[]byte{1, 2}, false, false, svm.BorshIoError},
		{[]byte{1}, false, false, svm.BorshIoError},
	} {
		s, ini, code := accountutils.Fetch[storage](tc.data)
		if s.Accept != tc.accept || ini != tc.ini || code != tc.code {
			t.Errorf("Fetch(%x) = %v %v %#x", tc.data, s.Accept, ini, code)
		}
	}
}

func TestDiscriminatorDecode(t *testing.T) {
	for n := 0; n < 8; n++ {
		if _, code := accountutils.DiscriminatorDecode[foo](fooDiscriminator, bytes.Repeat([]byte{3}, n)); code != svm.InvalidInstructionData {
			t.Errorf("len %d: code %#x", n, code)
		}
	}
	data := accountutils.DiscriminatorEncode(fooDiscriminator, &foo{A: 9})
	if f, code := accountutils.DiscriminatorDecode[foo](fooDiscriminator, data); code != 0 || f.A != 9 {
		t.Errorf("round trip %v %#x", f, code)
	}
	if _, code := accountutils.DiscriminatorDecode[foo](fooDiscriminator, append(data, 0)); code != svm.InvalidInstructionData {
		t.Errorf("trailing byte accepted")
	}
}

var programID = bytes.Repeat([]byte{7}, 32)

// rentBytes is the default Rent sysvar: 3480 lamports/byte-year, 2.0 years, 50%.
func rentBytes(out []byte) uint64 {
	binary.LittleEndian.PutUint64(out[0:8], 3480)
	binary.LittleEndian.PutUint64(out[8:16], 0x4000000000000000)
	out[16] = 50
	return 0
}

func TestStore(t *testing.T) {
	acct := solana.Account{Key: bytes.Repeat([]byte{1}, 32), Owner: programID, Data: make([]byte, 2), Writable: true, OriginalDataLen: 2}
	c := solana.Context{ID: programID, Accounts: []solana.Account{acct}}
	if code := accountutils.Store(c, 0, &storage{Accept: true}, false); code != 0 || !bytes.Equal(c.Accounts[0].Data, []byte{1, 1}) {
		t.Fatalf("store %#x %x", code, c.Accounts[0].Data)
	}
	c.Accounts[0].Writable = false
	if code := accountutils.Store(c, 0, &storage{}, false); code != svm.InvalidAccountData {
		t.Fatalf("readonly store %#x", code)
	}
	c.Accounts[0].Writable = true
	c.Accounts[0].Data = nil
	c.Accounts[0].OriginalDataLen = 0
	if code := accountutils.Store(c, 0, &storage{}, false); code != svm.BorshIoError {
		t.Fatalf("short store %#x", code)
	}
	if code := accountutils.Store(c, 0, &storage{Accept: true}, true); code != 0 || len(c.Accounts[0].Data) != 1024 || c.Accounts[0].Data[0] != 1 || c.Accounts[0].Data[1] != 1 {
		t.Fatalf("realloc store %#x len %d", code, len(c.Accounts[0].Data))
	}
}

type invocation struct {
	program uint64
	metas   []byte
	data    []byte
	signers []byte
}

func pdaContext(lamports uint64, calls *[]invocation) solana.Context {
	return solana.Context{
		ID: programID,
		Accounts: []solana.Account{
			{Key: make([]byte, 32), Owner: make([]byte, 32), Executable: true},
			{Key: bytes.Repeat([]byte{2}, 32), Owner: make([]byte, 32), Signer: true, Writable: true, Lamports: 1e9},
			{Key: bytes.Repeat([]byte{3}, 32), Owner: make([]byte, 32), Writable: true, Lamports: lamports},
		},
		ReadRent: rentBytes,
		InvokeInstruction: func(program uint64, metas, data, signers []byte) uint64 {
			*calls = append(*calls, invocation{program, bytes.Clone(metas), bytes.Clone(data), bytes.Clone(signers)})
			return 0
		},
	}
}

func meta(index uint64, flags byte) []byte {
	b := make([]byte, 9)
	binary.LittleEndian.PutUint64(b, index)
	b[8] = flags
	return b
}

func TestCreatePDAAccount(t *testing.T) {
	seeds, code := svm.NewSeeds([][]byte{[]byte("test_ism"), []byte("-"), []byte("storage")}, 255)
	if code != 0 {
		t.Fatal(code)
	}
	var owner [32]byte
	copy(owner[:], programID)
	// Rent::default().minimum_balance(2) = (128 + 2) * 3480 * 2.
	const rent = 904_800

	var calls []invocation
	if code := accountutils.CreatePDAAccount(pdaContext(0, &calls), 1, 2, owner, 0, 2, &seeds); code != 0 || len(calls) != 1 {
		t.Fatalf("create %#x, %d calls", code, len(calls))
	}
	want := svm.CreateAccountData(rent, 2, owner)
	if !bytes.Equal(calls[0].data, want[:]) || !bytes.Equal(calls[0].metas, append(meta(1, 3), meta(2, 3)...)) {
		t.Fatalf("create_account data %x metas %x", calls[0].data, calls[0].metas)
	}
	if !bytes.Equal(calls[0].signers, append([]byte{1, 4, 8}, []byte("test_ism\x01-\x07storage\x01\xff")...)) {
		t.Fatalf("signers %x", calls[0].signers)
	}

	// Pre-funded: top up, allocate, assign.
	calls = nil
	if code := accountutils.CreatePDAAccount(pdaContext(1000, &calls), 1, 2, owner, 0, 2, &seeds); code != 0 || len(calls) != 3 {
		t.Fatalf("prefunded %#x, %d calls", code, len(calls))
	}
	transfer, allocate, assign := svm.TransferData(rent-1000), svm.AllocateData(2), svm.AssignData(owner)
	if !bytes.Equal(calls[0].data, transfer[:]) || calls[0].signers != nil && len(calls[0].signers) != 0 {
		t.Errorf("transfer %x signers %x", calls[0].data, calls[0].signers)
	}
	if !bytes.Equal(calls[1].data, allocate[:]) || !bytes.Equal(calls[1].metas, meta(2, 3)) {
		t.Errorf("allocate %x %x", calls[1].data, calls[1].metas)
	}
	if !bytes.Equal(calls[2].data, assign[:]) {
		t.Errorf("assign %x", calls[2].data)
	}

	// Already rent-exempt: no transfer.
	calls = nil
	if code := accountutils.CreatePDAAccount(pdaContext(rent, &calls), 1, 2, owner, 0, 2, &seeds); code != 0 || len(calls) != 2 {
		t.Fatalf("exempt %#x, %d calls", code, len(calls))
	}
}

func TestStoreWithRentExemptRealloc(t *testing.T) {
	var calls []invocation
	c := pdaContext(1000, &calls)
	c.Accounts[2].Owner = programID
	c.Accounts[2].Data = []byte{}
	if code := accountutils.StoreWithRentExemptRealloc(c, 2, &storage{Accept: true}, 1, 0); code != 0 {
		t.Fatalf("code %#x", code)
	}
	transfer := svm.TransferData(904_800 - 1000)
	if len(calls) != 1 || !bytes.Equal(calls[0].data, transfer[:]) || !bytes.Equal(c.Accounts[2].Data, []byte{1, 1}) {
		t.Fatalf("calls %+v data %x", calls, c.Accounts[2].Data)
	}
}

func TestVerifyAccountUninitialized(t *testing.T) {
	c := solana.Context{ID: programID, Accounts: []solana.Account{
		{Key: make([]byte, 32), Owner: make([]byte, 32)},
		{Key: make([]byte, 32), Owner: programID},
		{Key: make([]byte, 32), Owner: make([]byte, 32), Data: []byte{0}},
	}}
	if accountutils.VerifyAccountUninitialized(c, 0) != 0 ||
		accountutils.VerifyAccountUninitialized(c, 1) != svm.AccountAlreadyInitialized ||
		accountutils.VerifyAccountUninitialized(c, 2) != svm.AccountAlreadyInitialized {
		t.Fatal("verify_account_uninitialized")
	}
	var owner [32]byte
	copy(owner[:], programID)
	if accountutils.InitState(c, 0, owner) != accountutils.Uninitialized ||
		accountutils.InitState(c, 1, owner) != accountutils.Initialized ||
		accountutils.InitState(c, 2, owner) != accountutils.OwnerMismatch {
		t.Fatal("init_state")
	}
}

func TestGoldenConstants(t *testing.T) {
	g := testvectors.LoadGolden(t, "interfaces")
	for _, c := range g.Constants {
		switch c.Name {
		case "account_utils.PROGRAM_INSTRUCTION_DISCRIMINATOR":
			if !bytes.Equal(testvectors.MustHex(t, c.Value), accountutils.ProgramInstructionDiscriminator[:]) {
				t.Errorf("%s = %s", c.Name, c.Value)
			}
		case "account_utils.SPL_NOOP_PROGRAM_ID":
			if testvectors.Base58Key(t, c.Value) != accountutils.SPLNoopProgramID {
				t.Errorf("%s = %s", c.Name, c.Value)
			}
		}
	}
	for _, e := range g.Errors {
		if e.Name == "AccountError.ExtraneousAccount" && e.Code != accountutils.ErrExtraneousAccount {
			t.Errorf("%s = %d", e.Name, e.Code)
		}
	}
}
