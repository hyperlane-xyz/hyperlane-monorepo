// Command mailbox-fixtures writes the mailbox SVM fixtures (stdout; see
// programs/mailbox/run-svm-fixtures.sh, which writes target/mailbox-svm.json):
// gosvm-svm-fixtures-v1 scenarios with exact expected account bytes,
// lamports, errors and return data. The same file runs against the Go and the
// Rust mailbox ELF, so passing both shows byte-identical behavior for these
// scenarios. The test ISM and recipient (internal/testprograms) must be built
// first; see programs/mailbox/run-svm-fixtures.sh.
package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"gosvm/sdk/fixture"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/keccaktest"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core/merkle"
)

const (
	localDomain = 1399811149
	slot        = 4242
	bigBalance  = 100_000_000_000
)

var noop = fixture.MustParseKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV")

type mailbox struct {
	f                       *fixture.Fixture
	payer, owner, noop      fixture.Account
	inbox, outbox           fixture.Account
	defaultISM, beneficiary fixture.Key
	maxFee, fee             uint64
	tree                    []byte
	hasOwner                bool
	ownerKey                fixture.Key
	processed               uint64
}

func u32(v uint32) []byte { b := make([]byte, 4); binary.LittleEndian.PutUint32(b, v); return b }
func u64(v uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, v); return b }

func cat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func (m *mailbox) inboxData() []byte {
	return cat([]byte{1}, u32(localDomain), []byte{m.inbox.Bump}, m.defaultISM[:], u64(m.processed))
}

func (m *mailbox) outboxData() []byte {
	owner := []byte{0}
	if m.hasOwner {
		owner = cat([]byte{1}, m.ownerKey[:])
	}
	d := cat([]byte{1}, u32(localDomain), []byte{m.outbox.Bump}, owner, m.tree, u64(m.maxFee), u64(m.fee), m.beneficiary[:])
	return append(d, make([]byte, 1119-len(d))...)
}

func (m *mailbox) initIx() fixture.Instruction {
	data := cat([]byte{0}, u32(localDomain), m.defaultISM[:], u64(m.maxFee), u64(m.fee), m.beneficiary[:])
	return fixture.Instruction{Data: data, Accounts: []fixture.AccountMeta{
		{Key: fixture.SystemProgram}, {Key: m.payer.Key, Signer: true, Writable: true},
		{Key: m.inbox.Key, Writable: true}, {Key: m.outbox.Key, Writable: true}}}
}

func newMailbox(f *fixture.Fixture, fee, maxFee uint64) *mailbox {
	m := &mailbox{f: f, fee: fee, maxFee: maxFee}
	m.payer = f.Signer("mailbox-payer", bigBalance)
	m.owner = m.payer
	m.noop = f.AccountAt("spl-noop", noop, nil)
	m.inbox = f.PDA("inbox", []byte("hyperlane"), []byte("-"), []byte("inbox"))
	m.outbox = f.PDA("outbox", []byte("hyperlane"), []byte("-"), []byte("outbox"))
	m.defaultISM = f.KeyFor("default-ism")
	m.beneficiary = f.AccountAt("beneficiary", f.KeyFor("beneficiary"), nil).Key
	return m
}

func (m *mailbox) reset() {
	m.tree = make([]byte, merkle.Size)
	merkle.Init(m.tree)
	m.hasOwner, m.ownerKey, m.processed = true, m.payer.Key, 0
}

// initStep adds Init and its expected accounts.
func (m *mailbox) initStep(s *fixture.Scenario) *fixture.Step {
	m.reset()
	return s.Step(m.initIx()).ExpectCreated(m.inbox, m.inboxData(), m.payer).ExpectCreated(m.outbox, m.outboxData(), m.payer)
}

// dispatch returns the instruction and records the expected effects.
func (m *mailbox) dispatch(s *fixture.Scenario, snd fixture.Account, unique fixture.Account, msgPDA fixture.Account, body []byte, outboxLamports *uint64, payerLamports *uint64) *fixture.Step {
	recipient := m.f.KeyFor("recipient")
	data := cat([]byte{4}, snd.Key[:], u32(1), recipient[:], u32(uint32(len(body))), body)
	ix := fixture.Instruction{Data: data, Accounts: []fixture.AccountMeta{
		{Key: m.outbox.Key, Writable: true}, {Key: snd.Key, Signer: true}, {Key: fixture.SystemProgram},
		{Key: noop}, {Key: m.payer.Key, Signer: true, Writable: true}, {Key: unique.Key, Signer: true},
		{Key: msgPDA.Key, Writable: true}}}
	nonce := uint32(merkle.Count(m.tree))
	encoded := (&hyperlanecore.HyperlaneMessage{Version: 3, Nonce: nonce, Origin: localDomain, Sender: snd.Key,
		Destination: 1, Recipient: recipient, Body: body}).Encode()
	id := keccaktest.Keccak256(encoded)
	merkle.Ingest(keccaktest.Context(), m.tree, id)
	stored := cat([]byte{1}, []byte("DISPATCH"), u32(nonce), u64(slot), unique.Key[:], encoded)
	*outboxLamports += m.fee
	rent := m.f.MinimumBalance(len(stored))
	*payerLamports -= m.fee + rent
	return s.Step(ix).Expect(msgPDA, fixture.State{Data: stored, Owner: m.f.ProgramID(), Lamports: rent}).
		Expect(m.outbox, fixture.State{Data: m.outboxData(), Owner: m.f.ProgramID(), Lamports: *outboxLamports}).
		ExpectLamports(m.payer, *payerLamports).ExpectReturn(id)
}

func main() {
	program := os.Getenv("MAILBOX_PROGRAM_ID")
	f := fixture.New("hyperlane mailbox pilot")
	if program != "" {
		f.SetProgramID(fixture.MustParseKey(program))
	}
	f.SetClock(fixture.Clock{Slot: slot, UnixTimestamp: 1_700_000_000})
	m := newMailbox(f, 0, 0)
	snd := f.Signer("sender", 0)
	var uniques, pdas []fixture.Account
	for i := 0; i < 9; i++ {
		u := f.Signer(fmt.Sprintf("unique-%d", i), 0)
		uniques = append(uniques, u)
		pdas = append(pdas, f.PDA(fmt.Sprintf("dispatched-%d", i), []byte("hyperlane"), []byte("-"), []byte("dispatched_message"), []byte("-"), u.Key[:]))
	}
	initRent := f.MinimumBalance(46) + f.MinimumBalance(1119)

	s := f.Scenario("init")
	m.initStep(s)

	for _, n := range []int{0, 32, 256, 512} {
		s = f.Scenario(fmt.Sprintf("dispatch-body-%d", n))
		m.initStep(s)
		body := make([]byte, n)
		for i := range body {
			body[i] = byte(i*7 + 1)
		}
		outboxLamports, payerLamports := f.MinimumBalance(1119), bigBalance-initRent
		m.dispatch(s, snd, uniques[0], pdas[0], body, &outboxLamports, &payerLamports)
	}

	// Nine sequential dispatches: insertion cost depends on the count's
	// trailing ones (the 8th hashes three levels, the 9th none).
	s = f.Scenario("dispatch-sequence")
	m.initStep(s)
	outboxLamports, payerLamports := f.MinimumBalance(1119), bigBalance-initRent
	for i := 0; i < 9; i++ {
		m.dispatch(s, snd, uniques[i], pdas[i], []byte("hello hyperlane"), &outboxLamports, &payerLamports)
	}
	countRoot := func(kind byte) []byte {
		root := make([]byte, 32)
		merkle.Root(keccaktest.Context(), m.tree, root)
		switch kind {
		case 5:
			return cat(u32(uint32(merkle.Count(m.tree))), []byte{0xff})
		case 6:
			return cat(u32(36), root, u32(uint32(merkle.Count(m.tree))), []byte{0xff})
		case 7:
			return cat(root, []byte{0xff})
		}
		return cat([]byte{1}, m.ownerKey[:], []byte{0xff})
	}
	// Rust's software Keccak needs more than the default 200,000 CU for a
	// 32-level root, so the queries request the maximum limit.
	for _, kind := range []byte{5, 6, 7, 8} {
		s.Step(fixture.Instruction{Data: []byte{kind}, Accounts: []fixture.AccountMeta{{Key: m.outbox.Key}}}).
			Invoke(fixture.ComputeBudgetProgram, computeUnitLimit(1_400_000)).ExpectReturn(countRoot(kind))
	}

	// A protocol fee moves lamports from the payer to the outbox.
	feeBox := newMailboxShared(f, m, 1000, 5000)
	s = f.Scenario("dispatch-protocol-fee")
	feeBox.initStep(s)
	outboxLamports, payerLamports = f.MinimumBalance(1119), bigBalance-initRent
	feeBox.dispatch(s, snd, uniques[0], pdas[0], []byte("fee"), &outboxLamports, &payerLamports)

	// Failures roll back; each checks the Rust error.
	s = f.Scenario("init-twice")
	m.initStep(s)
	s.Step(m.initIx()).FreshBlockhash().FailsWith(fixture.InstructionError(0, "AccountAlreadyInitialized"))

	s = f.Scenario("init-fee-above-max")
	bad := newMailboxShared(f, m, 10, 5)
	s.Step(bad.initIx()).FailsWith(fixture.InstructionError(0, "InvalidArgument"))

	recipient := f.KeyFor("recipient")
	dispatchIx := func(snd fixture.Key, signer bool, unique, msgPDA fixture.Key, extra bool) fixture.Instruction {
		data := cat([]byte{4}, snd[:], u32(1), recipient[:], u32(2), []byte{1, 2})
		metas := []fixture.AccountMeta{
			{Key: m.outbox.Key, Writable: true}, {Key: snd, Signer: signer}, {Key: fixture.SystemProgram},
			{Key: noop}, {Key: m.payer.Key, Signer: true, Writable: true}, {Key: unique, Signer: true},
			{Key: msgPDA, Writable: true}}
		if extra {
			metas = append(metas, fixture.AccountMeta{Key: m.beneficiary})
		}
		return fixture.Instruction{Data: data, Accounts: metas}
	}
	s = f.Scenario("dispatch-wrong-pda")
	m.initStep(s)
	s.Step(dispatchIx(snd.Key, true, uniques[0].Key, pdas[1].Key, false)).FailsWith(fixture.InstructionError(0, "InvalidArgument"))
	s = f.Scenario("dispatch-impersonated-sender")
	m.initStep(s)
	other := f.KeyFor("someone-else")
	ix := dispatchIx(other, false, uniques[0].Key, pdas[0].Key, false)
	ix.Accounts[1] = fixture.AccountMeta{Key: snd.Key, Signer: true}
	s.Step(ix).FailsWith(fixture.InstructionError(0, "MissingRequiredSignature"))
	s = f.Scenario("dispatch-extraneous-account")
	m.initStep(s)
	s.Step(dispatchIx(snd.Key, true, uniques[0].Key, pdas[0].Key, true)).Fails(6)
	s = f.Scenario("dispatch-replayed-unique")
	m.initStep(s)
	outboxLamports, payerLamports = f.MinimumBalance(1119), bigBalance-initRent
	m.dispatch(s, snd, uniques[0], pdas[0], []byte{1, 2}, &outboxLamports, &payerLamports)
	s.Step(dispatchIx(snd.Key, true, uniques[0].Key, pdas[0].Key, false)).FreshBlockhash().FailsWith(fixture.InstructionError(0, "AccountAlreadyInitialized"))

	// Owner administration.
	s = f.Scenario("admin")
	m.initStep(s)
	newISM := f.KeyFor("new-ism")
	s.Step(fixture.Instruction{Data: cat([]byte{2}, newISM[:]), Accounts: []fixture.AccountMeta{
		{Key: m.inbox.Key, Writable: true}, {Key: m.outbox.Key}, {Key: m.payer.Key, Signer: true}}}).
		ExpectData(m.inbox, func() []byte { m.defaultISM = newISM; return m.inboxData() }())
	s.Step(fixture.Instruction{Data: cat([]byte{11}, u64(0), m.beneficiary[:]), Accounts: []fixture.AccountMeta{
		{Key: m.outbox.Key, Writable: true}, {Key: m.payer.Key, Signer: true}}}).ExpectData(m.outbox, m.outboxData())
	s.Step(fixture.Instruction{Data: cat([]byte{11}, u64(1), m.beneficiary[:]), Accounts: []fixture.AccountMeta{
		{Key: m.outbox.Key, Writable: true}, {Key: m.payer.Key, Signer: true}}}).FailsWith(fixture.InstructionError(0, "InvalidArgument"))
	newOwner := f.KeyFor("new-owner")
	s.Step(fixture.Instruction{Data: cat([]byte{9, 1}, newOwner[:]), Accounts: []fixture.AccountMeta{
		{Key: m.outbox.Key, Writable: true}, {Key: m.payer.Key, Signer: true}}}).
		ExpectData(m.outbox, func() []byte { m.ownerKey = newOwner; return m.outboxData() }())
	s.Step(fixture.Instruction{Data: []byte{9, 0}, Accounts: []fixture.AccountMeta{
		{Key: m.outbox.Key, Writable: true}, {Key: m.payer.Key, Signer: true}}}).FailsWith(fixture.InstructionError(0, "InvalidArgument"))
	s.Step(fixture.Instruction{Data: []byte{8}, Accounts: []fixture.AccountMeta{{Key: m.outbox.Key}}}).ExpectReturn(countRoot(8))
	// GetProgramVersion.
	s.Step(fixture.Instruction{Data: []byte{150, 230, 176, 162, 236, 96, 183, 171}}).ExpectReturn(cat(u32(5), []byte("1.0.0"), []byte{0xff}))
	// Malformed instruction data.
	s.Step(fixture.Instruction{Data: []byte{4, 1, 2}}).FailsWith(fixture.InstructionError(0, "InvalidInstructionData"))
	s.Step(fixture.Instruction{Data: []byte{42}}).FailsWith(fixture.InstructionError(0, "InvalidInstructionData"))

	// Renouncing ownership drops the Option payload and shifts the tree.
	s = f.Scenario("renounce-ownership")
	m.initStep(s)
	s.Step(fixture.Instruction{Data: []byte{9, 0}, Accounts: []fixture.AccountMeta{
		{Key: m.outbox.Key, Writable: true}, {Key: m.payer.Key, Signer: true}}}).
		ExpectData(m.outbox, func() []byte { m.hasOwner = false; return m.outboxData() }())
	s.Step(fixture.Instruction{Data: []byte{8}, Accounts: []fixture.AccountMeta{{Key: m.outbox.Key}}}).ExpectReturn([]byte{0, 0xff})
	outboxLamports, payerLamports = f.MinimumBalance(1119), bigBalance-initRent
	m.dispatch(s, snd, uniques[0], pdas[0], []byte("after renounce"), &outboxLamports, &payerLamports)
	s.Step(fixture.Instruction{Data: cat([]byte{9, 1}, m.payer.Key[:]), Accounts: []fixture.AccountMeta{
		{Key: m.outbox.Key, Writable: true}, {Key: m.payer.Key, Signer: true}}}).FailsWith(fixture.InstructionError(0, "InvalidArgument"))

	processScenarios(f, m)

	b, err := f.JSON()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Stdout.Write(b)
}

// computeUnitLimit is ComputeBudget's SetComputeUnitLimit.
func computeUnitLimit(units uint32) fixture.Instruction {
	return fixture.Instruction{Data: cat([]byte{2}, u32(units))}
}

// newMailboxShared reuses m's declared accounts with other fee settings.
func newMailboxShared(f *fixture.Fixture, m *mailbox, fee, maxFee uint64) *mailbox {
	c := *m
	c.fee, c.maxFee = fee, maxFee
	return &c
}

// testPrograms is where run-svm-fixtures.sh builds the helper programs,
// relative to the fixture file in target/.
const testPrograms = "fogo-v0/testprograms/"

func elfHash(name string) string {
	b, err := os.ReadFile(filepath.Join(os.Getenv("FIXTURE_DIR"), testPrograms, name))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// processScenarios cover InboxProcess with the Go test ISM and recipient
// (internal/testprograms), shared by the Go and Rust mailbox runs.
func processScenarios(f *fixture.Fixture, base *mailbox) {
	ism := f.Program("test-ism", f.KeyFor("test-ism-program"), testPrograms+"ism.so", elfHash("ism.so"))
	recipient := f.Program("test-recipient", f.KeyFor("test-recipient-program"), testPrograms+"recipient.so", elfHash("recipient.so"))
	m := newMailboxShared(f, base, 0, 0)
	m.defaultISM = ism.Key
	authority := f.PDA("process-authority", []byte("hyperlane"), []byte("-"), []byte("process_authority"), []byte("-"), recipient.Key[:])
	body := []byte("hello from goSVM")
	state := make([]byte, 4+32+4+len(body))
	stateAcct := f.Account("recipient-state", fixture.State{Data: state, Owner: recipient.Key, Lamports: f.MinimumBalance(len(state))})
	ismConfig := f.Account("recipient-ism-config", fixture.State{Data: cat([]byte{1}, ism.Key[:]), Owner: recipient.Key, Lamports: f.MinimumBalance(33)})
	sender := f.KeyFor("remote-sender")

	msg := func(version byte, nonce uint32, destination uint32) []byte {
		return (&hyperlanecore.HyperlaneMessage{Version: version, Nonce: nonce, Origin: 1, Sender: sender,
			Destination: destination, Recipient: recipient.Key, Body: body}).Encode()
	}
	pdas := map[string]fixture.Account{}
	processedPDA := func(name string, encoded []byte) fixture.Account {
		id := keccaktest.Keccak256(encoded)
		if a, ok := pdas[string(id)]; ok {
			return a
		}
		pdas[string(id)] = f.PDA(name, []byte("hyperlane"), []byte("-"), []byte("processed_message"), []byte("-"), id)
		return pdas[string(id)]
	}
	ix := func(metadata, encoded []byte, processed fixture.Account, withConfig bool, ismKey fixture.Key) fixture.Instruction {
		data := cat([]byte{1}, u32(uint32(len(metadata))), metadata, u32(uint32(len(encoded))), encoded)
		metas := []fixture.AccountMeta{
			{Key: m.payer.Key, Signer: true, Writable: true}, {Key: fixture.SystemProgram}, {Key: m.inbox.Key, Writable: true},
			{Key: authority.Key}, {Key: processed.Key, Writable: true}}
		if withConfig {
			metas = append(metas, fixture.AccountMeta{Key: ismConfig.Key})
		}
		metas = append(metas, fixture.AccountMeta{Key: noop}, fixture.AccountMeta{Key: ismKey},
			fixture.AccountMeta{Key: recipient.Key}, fixture.AccountMeta{Key: stateAcct.Key, Writable: true})
		return fixture.Instruction{Data: data, Accounts: metas}
	}
	handled := cat(u32(1), sender[:], u32(uint32(len(body))), body)
	expectProcessed := func(t *fixture.Step, processed fixture.Account, encoded []byte, payer *uint64) *fixture.Step {
		id := keccaktest.Keccak256(encoded)
		stored := cat([]byte{1}, []byte("PROCESSD"), u64(m.processed), id, u64(slot))
		m.processed++
		rent := f.MinimumBalance(len(stored))
		*payer -= rent
		return t.Expect(processed, fixture.State{Data: stored, Owner: f.ProgramID(), Lamports: rent}).
			ExpectData(m.inbox, m.inboxData()).ExpectData(stateAcct, handled).ExpectLamports(m.payer, *payer)
	}
	initRent := f.MinimumBalance(46) + f.MinimumBalance(1119)

	for _, withConfig := range []bool{false, true} {
		name := "process-default-ism"
		if withConfig {
			name = "process-recipient-ism"
		}
		s := f.Scenario(name)
		m.initStep(s)
		m.processed = 0
		payer := uint64(bigBalance) - initRent
		encoded := msg(3, 0, localDomain)
		processed := processedPDA(name+"-processed", encoded)
		expectProcessed(s.Step(ix([]byte{1}, encoded, processed, withConfig, ism.Key)), processed, encoded, &payer)
		if !withConfig {
			s.Step(ix([]byte{1}, encoded, processed, withConfig, ism.Key)).FreshBlockhash().Fails(5)
			second := msg(3, 1, localDomain)
			p2 := processedPDA(name+"-processed-2", second)
			expectProcessed(s.Step(ix(nil, second, p2, withConfig, ism.Key)), p2, second, &payer)
		}
	}
	s := f.Scenario("process-rejections")
	m.initStep(s)
	encoded := msg(3, 7, localDomain)
	processed := processedPDA("rejected-processed", encoded)
	s.Step(ix([]byte{0}, encoded, processed, false, ism.Key)).FailsWith(fixture.InstructionError(0, fixture.Custom(1)))
	s.Step(ix([]byte{1}, encoded, processed, false, recipient.Key)).FailsWith(fixture.InstructionError(0, "InvalidArgument"))
	wrongDomain := msg(3, 7, localDomain+1)
	s.Step(ix([]byte{1}, wrongDomain, processedPDA("wrong-domain-processed", wrongDomain), false, ism.Key)).Fails(4)
	wrongVersion := msg(2, 7, localDomain)
	s.Step(ix([]byte{1}, wrongVersion, processedPDA("wrong-version-processed", wrongVersion), false, ism.Key)).Fails(3)
	s.Step(ix([]byte{1}, encoded[:40], processed, false, ism.Key)).Fails(2)
}
