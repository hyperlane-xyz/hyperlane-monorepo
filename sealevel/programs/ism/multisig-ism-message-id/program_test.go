package multisigismmessageid_test

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strings"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/svmtest"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	ecdsa "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/ecdsa-signature"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	multisigism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/multisig-ism"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	program "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/programs/ism/multisig-ism-message-id"
	"gosvm/solana"
)

// The goldens' program ID and canonical bumps (find_program_address).
var programID = testvectors.Base58Key(&testing.T{}, "C1o52bzzxGh9JK6CxqCS5HLuVRiRJzYS5BdCXLE7XgwT")

const (
	accessControlBump = 250
	goldenDomain      = 1399811149
	goldenDomainBump  = 255
)

func newRuntime(t *testing.T) *svmtest.Runtime {
	r := svmtest.New(t, programID, "multisig-ism")
	r.Bump(program.AccessControlPDASeeds, accessControlBump)
	r.Bump(program.DomainDataPDASeeds(goldenDomain), goldenDomainBump)
	return r
}

func vec(t *testing.T, group, name string) []byte {
	v, ok := testvectors.Rust(t, group)[name]
	if !ok {
		t.Fatalf("no vector %s/%s", group, name)
	}
	return v.Bytes(t)
}

func programIx(t *testing.T, ix program.Instruction) []byte {
	return accountutils.DiscriminatorEncode(accountutils.ProgramInstructionDiscriminator, &ix)
}

func payer(key byte, signer bool) solana.Account {
	return solana.Account{Key: bytes.Repeat([]byte{key}, 32), Owner: make([]byte, 32), Signer: signer, Writable: true, Lamports: 1e12}
}

func pdaAccount(key [32]byte, owner [32]byte, data []byte, writable bool) solana.Account {
	return solana.Account{Key: key[:], Owner: owner[:], Data: data, Writable: writable, Lamports: svmtest.MinimumBalance(uint64(len(data)))}
}

func accountBytes(v accountutils.Encoder, size int) []byte {
	b := make([]byte, size)
	if !accountutils.StoreInSlice(b, v) {
		panic("too small")
	}
	return b
}

// initialized sets up an initialized access control PDA owned by owner.
func initialized(t *testing.T, owner byte) (*svmtest.Runtime, uint64, uint64) {
	r := newRuntime(t)
	o := r.Account(payer(owner, true))
	ac := program.AccessControlData{BumpSeed: accessControlBump, Owner: borsh.SomeOf(svm.Pubkey(bytes.Repeat([]byte{owner}, 32)))}
	acKey := svmtest.PDA(program.AccessControlPDASeeds, accessControlBump, programID)
	a := r.Account(pdaAccount(acKey, programID, accountBytes(&ac, 35), true))
	return r, o, a
}

func TestRustVectors(t *testing.T) {
	const g = "multisig-ism-message-id"
	for _, name := range []string{"ix_initialize", "ix_set_validators_and_threshold", "ix_get_owner", "ix_transfer_ownership_some", "ix_transfer_ownership_none"} {
		b := vec(t, g, name)
		ix, code := accountutils.DiscriminatorDecode[program.Instruction](accountutils.ProgramInstructionDiscriminator, b)
		if code != 0 || !bytes.Equal(programIx(t, ix), b) {
			t.Errorf("%s: %d", name, code)
		}
	}
	for _, tc := range []struct {
		name string
		v    interface {
			accountutils.Encoder
		}
	}{
		{"account_access_control", &program.AccessControlData{}},
		{"account_access_control_none", &program.AccessControlData{}},
		{"account_domain_data", &program.DomainData{}},
	} {
		b := vec(t, g, tc.name)
		var out []byte
		switch tc.v.(type) {
		case *program.AccessControlData:
			v, ok, code := accountutils.Fetch[program.AccessControlData](b)
			if !ok || code != 0 {
				t.Fatalf("%s: fetch", tc.name)
			}
			out = accountBytes(&v, len(b))
			if v.Size() != 34 {
				t.Fatal("AccessControlData size")
			}
		case *program.DomainData:
			v, ok, code := accountutils.Fetch[program.DomainData](b)
			if !ok || code != 0 {
				t.Fatalf("%s: fetch", tc.name)
			}
			out = accountBytes(&v, len(b))
		}
		if !bytes.Equal(out, b) {
			t.Errorf("%s: %x, Rust %x", tc.name, out, b)
		}
	}
	// ValidatorsAndThreshold::validate, through SetValidatorsAndThreshold
	// (validation runs before any account is read).
	for name, v := range testvectors.Rust(t, g) {
		if !strings.HasPrefix(name, "validate_") {
			continue
		}
		b := v.Bytes(t)
		var vt multisigism.ValidatorsAndThreshold
		rd := borsh.NewReader(b[:len(b)-1])
		vt.DecodeBorsh(&rd)
		ix := programIx(t, program.Instruction{Kind: program.InstructionSetValidatorsAndThreshold, Domain: 1, Config: vt})
		code := newRuntime(t).Run(program.Process, ix)
		want := program.ErrInvalidValidatorsAndThreshold
		if b[len(b)-1] == 1 {
			want = svm.NotEnoughAccountKeys
		}
		if code != want {
			t.Errorf("%s: %#x, want %#x", name, code, want)
		}
	}
}

func TestGoldens(t *testing.T) {
	g := testvectors.LoadGolden(t, "multisig_ism_message_id")
	for _, v := range g.Values {
		b := testvectors.MustHex(t, v.Hex)
		switch v.Type {
		case "multisig_ism_message_id.Instruction":
			ix, code := accountutils.DiscriminatorDecode[program.Instruction](accountutils.ProgramInstructionDiscriminator, b)
			if code != 0 || !bytes.Equal(programIx(t, ix), b) {
				t.Errorf("%s %s: %d", v.Type, *v.Variant, code)
			}
			want := map[string]uint8{"Initialize": 0, "SetValidatorsAndThreshold": 1, "GetOwner": 2, "TransferOwnership": 3}[*v.Variant]
			if ix.Kind != want {
				t.Errorf("%s: kind %d", *v.Variant, ix.Kind)
			}
		case "multisig_ism_message_id.DomainData":
			d, ok, code := accountutils.Fetch[program.DomainData](b)
			if !ok || code != 0 || !bytes.Equal(accountBytes(&d, len(b)), b) {
				t.Errorf("%s", v.Type)
			}
		case "multisig_ism_message_id.AccessControlData":
			a, ok, code := accountutils.Fetch[program.AccessControlData](b)
			if !ok || code != 0 || !bytes.Equal(accountBytes(&a, len(b)), b) {
				t.Errorf("%s %s", v.Type, *v.Name)
			}
		default:
			t.Errorf("unhandled golden %s", v.Type)
		}
	}
	pdas := map[string][][]byte{
		"access_control": program.AccessControlPDASeeds,
		"domain_data":    program.DomainDataPDASeeds(goldenDomain),
	}
	for _, p := range g.PDAs {
		seeds, ok := pdas[p.Name]
		if !ok {
			t.Fatalf("unhandled PDA %s", p.Name)
		}
		for i, s := range p.Seeds {
			if !bytes.Equal(testvectors.MustHex(t, s), seeds[i]) {
				t.Errorf("%s seed %d", p.Name, i)
			}
		}
		if p.ProgramID != "C1o52bzzxGh9JK6CxqCS5HLuVRiRJzYS5BdCXLE7XgwT" {
			t.Fatalf("golden program id %s", p.ProgramID)
		}
		if svmtest.PDA(seeds, p.Bump, programID) != testvectors.Base58Key(t, p.Address) {
			t.Errorf("%s address", p.Name)
		}
	}
	want := map[string]uint64{
		"Error.AccountOutOfOrder": program.ErrAccountOutOfOrder, "Error.AccountNotOwner": program.ErrAccountNotOwner,
		"Error.ProgramIdNotOwner": program.ErrProgramIDNotOwner, "Error.AccountNotInitialized": program.ErrAccountNotInitialized,
		"Error.InvalidSignatureRecoveryId": program.ErrInvalidSignatureRecoveryID, "Error.InvalidSignature": program.ErrInvalidSignature,
		"Error.ThresholdNotMet": program.ErrThresholdNotMet, "Error.InvalidValidatorsAndThreshold": program.ErrInvalidValidatorsAndThreshold,
		"Error.AlreadyInitialized": program.ErrAlreadyInitialized, "Error.InvalidMetadata": program.ErrInvalidMetadata,
	}
	for _, e := range g.Errors {
		if want[e.Name] != e.Code {
			t.Errorf("%s = %d", e.Name, e.Code)
		}
	}
	if len(g.Errors) != len(want) {
		t.Errorf("%d golden errors", len(g.Errors))
	}
	// Instruction builders: data and account order.
	acKey := svmtest.PDA(program.AccessControlPDASeeds, accessControlBump, programID)
	dKey := svmtest.PDA(program.DomainDataPDASeeds(goldenDomain), goldenDomainBump, programID)
	var sys [32]byte
	for _, ix := range testvectors.GoldenInstructions(t, "multisig_ism_message_id") {
		var want []testvectors.GoldenMeta
		switch ix.Name {
		case "init_instruction":
			want = []testvectors.GoldenMeta{meta(ix.Accounts[0].Pubkey, true, true), meta(b58(acKey), false, true), meta(b58(sys), false, false)}
		case "transfer_ownership_instruction":
			want = []testvectors.GoldenMeta{meta(ix.Accounts[0].Pubkey, true, true), meta(b58(acKey), false, true)}
		case "set_validators_and_threshold_instruction":
			want = []testvectors.GoldenMeta{meta(ix.Accounts[0].Pubkey, true, true), meta(b58(acKey), false, false), meta(b58(dKey), false, true), meta(b58(sys), false, false)}
		default:
			t.Fatalf("unhandled golden instruction %s", ix.Name)
		}
		if fmt.Sprint(ix.Accounts) != fmt.Sprint(want) {
			t.Errorf("%s accounts %v, want %v", ix.Name, ix.Accounts, want)
		}
		b := testvectors.MustHex(t, ix.Hex)
		if _, code := accountutils.DiscriminatorDecode[program.Instruction](accountutils.ProgramInstructionDiscriminator, b); code != 0 {
			t.Errorf("%s data: %#x", ix.Name, code)
		}
	}
}

func b58(k [32]byte) string { return testvectors.Base58(k) }

func meta(key string, signer, writable bool) testvectors.GoldenMeta {
	return testvectors.GoldenMeta{Pubkey: key, IsSigner: signer, IsWritable: writable}
}

func TestInitialize(t *testing.T) {
	r := newRuntime(t)
	o := r.Account(payer(7, true))
	acKey := svmtest.PDA(program.AccessControlPDASeeds, accessControlBump, programID)
	a := r.Account(solana.Account{Key: acKey[:], Owner: make([]byte, 32), Writable: true})
	r.Account(svmtest.SystemProgram())
	ix := programIx(t, program.Instruction{Kind: program.InstructionInitialize})
	if code := r.Run(program.Process, ix); code != 0 {
		t.Fatalf("initialize: %#x", code)
	}
	if len(r.CPIs) != 1 || r.CPIs[0].Instruction != 0 || r.CPIs[0].Space != 35 || r.CPIs[0].Lamports != svmtest.MinimumBalance(35) || r.CPIs[0].Owner != programID {
		t.Fatalf("CPIs %+v", r.CPIs)
	}
	want := append([]byte{1, accessControlBump, 1}, bytes.Repeat([]byte{7}, 32)...)
	if !bytes.Equal(r.Accounts[a].Data, want) || !bytes.Equal(r.Accounts[a].Owner, programID[:]) {
		t.Fatalf("access control %x", r.Accounts[a].Data)
	}
	if code := r.Run(program.Process, ix); code != program.ErrAlreadyInitialized {
		t.Fatalf("second initialize: %#x", code)
	}
	_ = o

	sys := svmtest.SystemProgram()
	wrong := payer(9, false)
	empty := solana.Account{Key: acKey[:], Owner: make([]byte, 32), Writable: true}
	for _, tc := range []struct {
		name     string
		accounts []solana.Account
		code     uint64
	}{
		{"no accounts", nil, svm.NotEnoughAccountKeys},
		{"not signer", []solana.Account{payer(7, false), empty, sys}, svm.MissingRequiredSignature},
		{"no pda", []solana.Account{payer(7, true)}, svm.NotEnoughAccountKeys},
		{"wrong pda", []solana.Account{payer(7, true), wrong, sys}, program.ErrAccountOutOfOrder},
		{"no system", []solana.Account{payer(7, true), empty}, svm.NotEnoughAccountKeys},
		{"wrong system", []solana.Account{payer(7, true), empty, wrong}, program.ErrAccountOutOfOrder},
	} {
		r := newRuntime(t)
		for _, a := range tc.accounts {
			r.Account(a)
		}
		if code := r.Run(program.Process, ix); code != tc.code {
			t.Errorf("%s: %#x, want %#x", tc.name, code, tc.code)
		}
	}
}

func TestSetValidatorsAndThreshold(t *testing.T) {
	r, _, a := initialized(t, 7)
	dKey := svmtest.PDA(program.DomainDataPDASeeds(goldenDomain), goldenDomainBump, programID)
	d := r.Account(solana.Account{Key: dKey[:], Owner: make([]byte, 32), Writable: true})
	r.Account(svmtest.SystemProgram())
	vt := multisigism.ValidatorsAndThreshold{Validators: [][20]byte{{1}, {2}, {3}}, Threshold: 2}
	ix := programIx(t, program.Instruction{Kind: program.InstructionSetValidatorsAndThreshold, Domain: goldenDomain, Config: vt})
	if code := r.Run(program.Process, ix); code != 0 {
		t.Fatalf("create: %#x", code)
	}
	if len(r.CPIs) != 1 || r.CPIs[0].Space != 1024 {
		t.Fatalf("CPIs %+v", r.CPIs)
	}
	want := program.DomainData{BumpSeed: goldenDomainBump, ValidatorsAndThreshold: vt}
	if !bytes.Equal(r.Accounts[d].Data, accountBytes(&want, 1024)) {
		t.Fatalf("domain data %x", r.Accounts[d].Data[:80])
	}
	// Update without the System program.
	r.Accounts = r.Accounts[:3]
	vt2 := multisigism.ValidatorsAndThreshold{Validators: [][20]byte{{4}}, Threshold: 1}
	ix2 := programIx(t, program.Instruction{Kind: program.InstructionSetValidatorsAndThreshold, Domain: goldenDomain, Config: vt2})
	if code := r.Run(program.Process, ix2); code != 0 {
		t.Fatalf("update: %#x", code)
	}
	want2 := program.DomainData{BumpSeed: goldenDomainBump, ValidatorsAndThreshold: vt2}
	if len(r.CPIs) != 0 || !bytes.Equal(r.Accounts[d].Data, accountBytes(&want2, 1024)) {
		t.Fatalf("updated domain data %x", r.Accounts[d].Data[:40])
	}
	// More than 1024 bytes of validators reallocates.
	big := multisigism.ValidatorsAndThreshold{Threshold: 1}
	for i := 0; i < 60; i++ {
		big.Validators = append(big.Validators, [20]byte{byte(i), 0xaa})
	}
	ix3 := programIx(t, program.Instruction{Kind: program.InstructionSetValidatorsAndThreshold, Domain: goldenDomain, Config: big})
	if code := r.Run(program.Process, ix3); code != 0 || len(r.Accounts[d].Data) != 2048 {
		t.Fatalf("realloc: %#x len %d", code, len(r.Accounts[d].Data))
	}

	// Error precedence.
	other := payer(8, true)
	for _, tc := range []struct {
		name string
		edit func(r *svmtest.Runtime)
		code uint64
	}{
		{"owner not signer", func(r *svmtest.Runtime) { r.Accounts[0].Signer = false }, svm.MissingRequiredSignature},
		{"not owner", func(r *svmtest.Runtime) { r.Accounts[0] = other }, svm.InvalidArgument},
		{"access control wrong owner", func(r *svmtest.Runtime) { r.Accounts[a].Owner = make([]byte, 32) }, program.ErrProgramIDNotOwner},
		{"access control uninitialized", func(r *svmtest.Runtime) { r.Accounts[a].Data = make([]byte, 35) }, program.ErrAccountNotInitialized},
		{"access control corrupt", func(r *svmtest.Runtime) { r.Accounts[a].Data = []byte{2} }, svm.BorshIoError},
		{"access control wrong key", func(r *svmtest.Runtime) { r.Accounts[a].Key = bytes.Repeat([]byte{5}, 32) }, program.ErrAccountOutOfOrder},
		{"no domain pda", func(r *svmtest.Runtime) { r.Accounts = r.Accounts[:2] }, svm.NotEnoughAccountKeys},
		{"wrong domain pda", func(r *svmtest.Runtime) { r.Accounts[d].Key = bytes.Repeat([]byte{5}, 32) }, program.ErrAccountOutOfOrder},
		{"domain pda wrong owner", func(r *svmtest.Runtime) { r.Accounts[d].Owner = make([]byte, 32) }, program.ErrProgramIDNotOwner},
		// Corrupt data falls into the create path, which needs the System program.
		{"domain pda corrupt", func(r *svmtest.Runtime) { r.Accounts[d].Data = []byte{1, 2} }, svm.NotEnoughAccountKeys},
	} {
		r, _, _ := initialized(t, 7)
		r.Account(solana.Account{Key: dKey[:], Owner: programID[:], Writable: true, Data: accountBytes(&want, 1024), Lamports: 1})
		tc.edit(r)
		if code := r.Run(program.Process, ix2); code != tc.code {
			t.Errorf("%s: %#x, want %#x", tc.name, code, tc.code)
		}
	}
	// Create path: the System program must follow.
	r2, _, _ := initialized(t, 7)
	r2.Account(solana.Account{Key: dKey[:], Owner: make([]byte, 32), Writable: true})
	r2.Account(payer(9, false))
	if code := r2.Run(program.Process, ix); code != program.ErrAccountOutOfOrder {
		t.Errorf("wrong system program: %#x", code)
	}
}

func signatures(t *testing.T, idx ...int) []ecdsa.EcdsaSignature {
	out := make([]ecdsa.EcdsaSignature, len(idx))
	for i, j := range idx {
		out[i], _ = ecdsa.FromBytes(vec(t, "multisig-ism", fmt.Sprintf("test_data_signature_%d", j)))
	}
	return out
}

// verifySetup returns a runtime with the multisig test data's domain
// configured (threshold 2 of the three validators).
func verifySetup(t *testing.T) (*svmtest.Runtime, []byte, multisigism.MessageIDMetadata) {
	r := newRuntime(t)
	msg := vec(t, "multisig-ism", "test_data_message")
	origin := binary.BigEndian.Uint32(msg[5:9])
	key := r.Bump(program.DomainDataPDASeeds(origin), 254)
	vals := vec(t, "multisig-ism", "test_data_validators")
	vt := multisigism.ValidatorsAndThreshold{Threshold: 2}
	for i := 0; i < 3; i++ {
		var v [20]byte
		copy(v[:], vals[20*i:])
		vt.Validators = append(vt.Validators, v)
	}
	dd := program.DomainData{BumpSeed: 254, ValidatorsAndThreshold: vt}
	r.Account(pdaAccount(key, programID, accountBytes(&dd, 2048), false))
	f := vec(t, "multisig-ism", "test_data_checkpoint_fields")
	var m multisigism.MessageIDMetadata
	copy(m.OriginMerkleTreeHook[:], f[:32])
	copy(m.MerkleRoot[:], f[36:68])
	m.MerkleIndex = binary.BigEndian.Uint32(f[68:])
	return r, msg, m
}

func verifyIx(metadata, message []byte) []byte {
	return (&ism.Instruction{Kind: ism.KindVerify, Metadata: metadata, Message: message}).Encode()
}

func TestVerify(t *testing.T) {
	r, msg, m := verifySetup(t)
	for _, tc := range []struct {
		name string
		sigs []int
		msg  []byte
		code uint64
	}{
		{"quorum", []int{0, 1}, msg, 0},
		{"quorum with non-validator", []int{0, 2, 3}, msg, 0},
		{"out of order", []int{1, 0}, msg, program.ErrThresholdNotMet},
		{"too few", []int{0}, msg, program.ErrThresholdNotMet},
		{"other message", []int{0, 1}, vec(t, "multisig-ism", "test_data_message_nonce_420"), program.ErrThresholdNotMet},
	} {
		m.Signatures = signatures(t, tc.sigs...)
		if code := r.Run(program.Process, verifyIx(m.Encode(), tc.msg)); code != tc.code {
			t.Errorf("%s: %#x, want %#x", tc.name, code, tc.code)
		}
	}
	m.Signatures = signatures(t, 0, 1)
	good := m.Encode()
	if !bytes.Equal(good, vec(t, "multisig-ism", "metadata_sigs_0_1")) {
		t.Fatal("metadata encoding")
	}
	// A signature that does not recover: zero r and s (status 3 on chain).
	bad := append([]byte(nil), good...)
	for i := 68; i < 68+64; i++ {
		bad[i] = 0
	}
	if code := r.Run(program.Process, verifyIx(bad, msg)); code != program.ErrInvalidSignature {
		t.Errorf("unrecoverable signature: %#x", code)
	}
	for name, v := range testvectors.Rust(t, "multisig-ism") {
		if strings.HasPrefix(name, "metadata_reject_") {
			if code := r.Run(program.Process, verifyIx(v.Bytes(t), msg)); code != program.ErrInvalidMetadata {
				t.Errorf("%s: %#x", name, code)
			}
		}
	}
	// Metadata is checked before the message, the message before accounts.
	if code := r.Run(program.Process, verifyIx(good, msg[:76])); code != svm.InvalidArgument {
		t.Errorf("short message: %#x", code)
	}
	for _, tc := range []struct {
		name string
		edit func(a *solana.Account)
		code uint64
	}{
		{"wrong owner", func(a *solana.Account) { a.Owner = make([]byte, 32) }, program.ErrProgramIDNotOwner},
		{"uninitialized", func(a *solana.Account) { a.Data = make([]byte, 8) }, program.ErrAccountNotInitialized},
		{"empty", func(a *solana.Account) { a.Data = nil }, program.ErrAccountNotInitialized},
		{"corrupt", func(a *solana.Account) { a.Data = []byte{1, 254, 9} }, svm.BorshIoError},
		{"wrong key", func(a *solana.Account) { a.Key = bytes.Repeat([]byte{3}, 32) }, program.ErrAccountOutOfOrder},
	} {
		r, msg, _ := verifySetup(t)
		tc.edit(&r.Accounts[0])
		if code := r.Run(program.Process, verifyIx(good, msg)); code != tc.code {
			t.Errorf("%s: %#x, want %#x", tc.name, code, tc.code)
		}
	}
	r.Accounts = nil
	if code := r.Run(program.Process, verifyIx(good, msg)); code != svm.NotEnoughAccountKeys {
		t.Errorf("no accounts: %#x", code)
	}
}

func TestReturnData(t *testing.T) {
	r, msg, _ := verifySetup(t)
	origin := binary.BigEndian.Uint32(msg[5:9])
	domainKey := svmtest.PDA(program.DomainDataPDASeeds(origin), 254, programID)
	vt := vec(t, "multisig-ism", "validators_and_threshold")

	check := func(name string, data []byte, want []byte) {
		t.Helper()
		if code := r.Run(program.Process, data); code != 0 || !bytes.Equal(r.Return, want) {
			t.Errorf("%s: %#x %x, want %x", name, code, r.Return, want)
		}
	}
	check("Type", (&ism.Instruction{Kind: ism.KindType}).Encode(), []byte{5, 0, 0, 0, 0xff})
	metas := accountmeta.EncodeMetasReturnData([]accountmeta.SerializableAccountMeta{accountmeta.Readonly(domainKey, false)})
	check("VerifyAccountMetas", (&ism.Instruction{Kind: ism.KindVerifyAccountMetas, Metadata: []byte{1}, Message: msg}).Encode(), metas)
	check("ValidatorsAndThresholdAccountMetas", (&multisigism.Instruction{Kind: multisigism.KindValidatorsAndThresholdAccountMetas, Message: msg}).Encode(), metas)
	check("ValidatorsAndThreshold", vec(t, "multisig-ism", "ix_validators_and_threshold"), append(append([]byte(nil), vt...), 0xff))
	check("GetProgramVersion", packageversioned.GetProgramVersionDiscriminator[:], []byte{5, 0, 0, 0, '1', '.', '0', '.', '0', 0xff})

	// VerifyMetadataSpec: without the domain PDA as account 1, spec None and
	// the accounts to retry with.
	vam := r.Bump(ism.VerifyAccountMetasPDASeeds, 254)
	spec := (&ism.Instruction{Kind: ism.KindVerifyMetadataSpec, Message: msg}).Encode()
	none := ism.MetadataSpecResult{Accounts: [][32]byte{vam, domainKey}}
	domain := r.Accounts[0]
	r.Accounts = []solana.Account{{Key: vam[:], Owner: make([]byte, 32)}}
	check("VerifyMetadataSpec without domain", spec, ism.EncodeMetadataSpecReturnData(&none))
	r.Accounts = []solana.Account{{Key: vam[:], Owner: make([]byte, 32)}, payer(4, false)}
	check("VerifyMetadataSpec wrong domain", spec, ism.EncodeMetadataSpecReturnData(&none))
	r.Accounts = []solana.Account{{Key: vam[:], Owner: make([]byte, 32)}, domain}
	var parsed multisigism.ValidatorsAndThreshold
	rd := borsh.NewReader(vt)
	parsed.DecodeBorsh(&rd)
	some := ism.MetadataSpecResult{Spec: borsh.SomeOf(ism.MetadataSpec{Kind: ism.SpecMultisigMessageID, Validators: parsed.Validators, Threshold: parsed.Threshold})}
	check("VerifyMetadataSpec", spec, ism.EncodeMetadataSpecReturnData(&some))

	for _, data := range [][]byte{
		(&ism.Instruction{Kind: ism.KindVerifyAccountMetas, Message: msg[:10]}).Encode(),
		(&ism.Instruction{Kind: ism.KindVerifyMetadataSpec, Message: msg[:76]}).Encode(),
		(&multisigism.Instruction{Kind: multisigism.KindValidatorsAndThreshold, Message: msg[:76]}).Encode(),
		(&multisigism.Instruction{Kind: multisigism.KindValidatorsAndThresholdAccountMetas}).Encode(),
	} {
		if code := r.Run(program.Process, data); code != svm.InvalidArgument {
			t.Errorf("%x: %#x", data[:8], code)
		}
	}
}

func TestGetOwnerAndTransferOwnership(t *testing.T) {
	r, _, a := initialized(t, 7)
	get := programIx(t, program.Instruction{Kind: program.InstructionGetOwner})
	accounts := r.Accounts
	r.Accounts = []solana.Account{accounts[a]}
	if code := r.Run(program.Process, get); code != 0 || !bytes.Equal(r.Return, append(append([]byte{1}, bytes.Repeat([]byte{7}, 32)...), 0xff)) {
		t.Fatalf("GetOwner %#x %x", code, r.Return)
	}
	r.Accounts = accounts
	newOwner := borsh.SomeOf(svm.Pubkey(bytes.Repeat([]byte{8}, 32)))
	transfer := programIx(t, program.Instruction{Kind: program.InstructionTransferOwnership, NewOwner: newOwner})
	r.Accounts[0].Signer = false
	if code := r.Run(program.Process, transfer); code != svm.MissingRequiredSignature {
		t.Fatalf("unsigned transfer: %#x", code)
	}
	r.Accounts[0].Signer = true
	if code := r.Run(program.Process, transfer); code != 0 {
		t.Fatalf("transfer: %#x", code)
	}
	want := append([]byte{1, accessControlBump, 1}, bytes.Repeat([]byte{8}, 32)...)
	if !bytes.Equal(r.Accounts[a].Data, want) {
		t.Fatalf("after transfer %x", r.Accounts[a].Data)
	}
	if code := r.Run(program.Process, transfer); code != svm.InvalidArgument {
		t.Fatalf("old owner transfer: %#x", code)
	}
	// Renounce, then nobody can transfer; GetOwner returns None.
	r.Accounts[0] = payer(8, true)
	renounce := programIx(t, program.Instruction{Kind: program.InstructionTransferOwnership})
	if code := r.Run(program.Process, renounce); code != 0 {
		t.Fatalf("renounce: %#x", code)
	}
	if !bytes.Equal(r.Accounts[a].Data, append([]byte{1, accessControlBump, 0}, make([]byte, 32)...)) {
		t.Fatalf("after renounce %x", r.Accounts[a].Data)
	}
	if code := r.Run(program.Process, transfer); code != svm.InvalidArgument {
		t.Fatalf("transfer after renounce: %#x", code)
	}
	r.Accounts = []solana.Account{r.Accounts[a]}
	if code := r.Run(program.Process, get); code != 0 || !bytes.Equal(r.Return, []byte{0, 0xff}) {
		t.Fatalf("GetOwner none %#x %x", code, r.Return)
	}
	// Read-only access control can't be stored.
	r2, _, a2 := initialized(t, 7)
	r2.Accounts[a2].Writable = false
	if code := r2.Run(program.Process, transfer); code != svm.InvalidAccountData {
		t.Fatalf("read-only transfer: %#x", code)
	}
}

func TestInvalidInstructionData(t *testing.T) {
	r, _, _ := initialized(t, 7)
	d := accountutils.ProgramInstructionDiscriminator
	verify := verifyIx([]byte{1}, []byte{2})
	for _, data := range [][]byte{
		nil, {1}, d[:], append(d[:8:8], 4), append(d[:8:8], 0, 0), append(d[:8:8], 3, 2),
		append(d[:8:8], 1, 1, 0, 0), verify[:len(verify)-1], packageversioned.GetProgramVersionDiscriminator[:7],
		append(packageversioned.GetProgramVersionDiscriminator[:8:8], 0),
		multisigism.ValidatorsAndThresholdDiscriminator[:7],
	} {
		if code := r.Run(program.Process, data); code != svm.InvalidInstructionData {
			t.Errorf("%x: %#x", data, code)
		}
	}
}
