// Package fixture writes local SVM test fixtures (the gosvm-svm-fixtures-v1
// format read by gosvm test --svm) from ordinary Go.
//
// It is host-side Go for a project's fixture generator, such as cmd/fixtures;
// never import it from on-chain code. Instructions come from the generated
// client (client.XInstruction returns this package's Instruction type) and
// account data from its encoders, so fixtures use the same layouts as the
// program:
//
//	f := fixture.New("counter")
//	owner := f.Signer("owner", 1_000_000_000)
//	counter := f.PDA("counter", []byte("counter"), owner.Key[:])
//	f.Scenario("create").
//		Step(client.CreateInstruction(client.CreateKeys{Counter: counter.Key, Owner: owner.Key}, model.CreateArgs{Limit: 10, Bump: counter.Bump})).
//		ExpectCreated(counter, client.EncodeAccountCounter(model.Counter{Owner: owner.Key, Limit: 10, Bump: counter.Bump}), owner)
//	b, err := f.JSON()
//
// Keys and signing seeds derive from the namespace and each name, so the file
// is stable and reviewable. They are local test identities only.
//
// Each scenario tracks every declared account's expected state. A step's
// expectations change that state; every other account keeps its previous
// state, and a failing step keeps all of them, as the runtime rolls back. Every
// step asserts every declared account, in declaration order.
package fixture

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
)

// Format is the fixture format this package writes.
const Format = "gosvm-svm-fixtures-v1"

// Key is a 32-byte address. It is an alias, so a Key assigns directly to a
// model's [32]byte key types.
type Key = [32]byte

// AccountMeta is one account reference of an instruction. It is the same type
// as the generated client's AccountMeta.
type AccountMeta = struct {
	Key      [32]byte
	Signer   bool
	Writable bool
}

// Instruction is an instruction's ordered accounts and data, without its
// program. It is the same type as the generated client's Instruction.
type Instruction = struct {
	Accounts []AccountMeta
	Data     []byte
}

// Native program and sysvar addresses. An instruction that references one is
// given the alias shown, without a declaration.
var (
	SystemProgram        Key // "system"
	ComputeBudgetProgram = MustParseKey("ComputeBudget111111111111111111111111111111")
	ClockSysvar          = MustParseKey("SysvarC1ock11111111111111111111111111111111")
	RentSysvar           = MustParseKey("SysvarRent111111111111111111111111111111111")
)

var builtins = []struct {
	name   string
	key    Key
	native bool
}{
	{"system", SystemProgram, true},
	{"compute-budget", ComputeBudgetProgram, true},
	{"clock-sysvar", ClockSysvar, false},
	{"rent-sysvar", RentSysvar, false},
}

// RequestHeapFrame is the ComputeBudget instruction that requests a larger
// heap; invoke it on ComputeBudgetProgram.
func RequestHeapFrame(bytes uint32) Instruction {
	data := []byte{1, 0, 0, 0, 0}
	binary.LittleEndian.PutUint32(data[1:], bytes)
	return Instruction{Data: data}
}

// State is a complete account state.
type State struct {
	Data       []byte
	Owner      Key
	Lamports   uint64
	Executable bool
	RentEpoch  uint64
}

// Wallet is a System-owned account with no data.
func Wallet(lamports uint64) State { return State{Owner: SystemProgram, Lamports: lamports} }

// Rent is the Rent sysvar.
type Rent struct {
	LamportsPerByteYear uint64
	ExemptionThreshold  float64
	BurnPercent         uint8
}

// DefaultRent is the runner's default Rent, which New pins explicitly.
var DefaultRent = Rent{LamportsPerByteYear: 3480, ExemptionThreshold: 2, BurnPercent: 50}

// MinimumBalance is the rent-exempt balance for size bytes of data, computed as
// the runtime does: ((128 + size) * rate) as f64 * threshold, saturating.
func (r Rent) MinimumBalance(size int) uint64 {
	v := float64(uint64(128+size)*r.LamportsPerByteYear) * r.ExemptionThreshold
	if v >= math.MaxUint64 {
		return math.MaxUint64
	}
	if v <= 0 || v != v {
		return 0
	}
	return uint64(v)
}

// Clock is the Clock sysvar.
type Clock struct {
	Slot                uint64
	EpochStartTimestamp int64
	Epoch               uint64
	LeaderScheduleEpoch uint64
	UnixTimestamp       int64
}

// Account is a declared account: its alias in the fixture file, its address
// and, for a PDA, its bump.
type Account struct {
	Name string
	Key  Key
	Bump byte
}

// String returns the base58 address.
func (a Account) String() string { return Base58(a.Key[:]) }

type declared struct {
	name    string
	key     Key
	initial *State
	seed    []byte // signing seed, for signers
	watched bool
}

type program struct {
	name, address, elf, sha256 string
}

// Fixture is a fixture file under construction. Methods record the first
// error, which JSON returns.
type Fixture struct {
	namespace string
	program   Key
	payer     []byte
	rent      Rent
	clock     *Clock
	accounts  []*declared
	byName    map[string]*declared
	byKey     map[Key]*declared
	programs  []program
	scenarios []*Scenario
	used      bool // the program ID is in a PDA or state
	err       error
}

// New starts a fixture whose program address, fee payer and test keys derive
// from namespace. The suite pins DefaultRent.
func New(namespace string) *Fixture {
	f := &Fixture{namespace: namespace, rent: DefaultRent, byName: map[string]*declared{}, byKey: map[Key]*declared{}}
	f.program = f.KeyFor("program")
	f.payer = f.Seed("fee payer")
	return f
}

func (f *Fixture) fail(format string, args ...any) {
	if f.err == nil {
		f.err = fmt.Errorf("fixture: "+format, args...)
	}
}

// Seed returns the deterministic local test signing seed for name.
func (f *Fixture) Seed(name string) []byte {
	s := sha256.Sum256([]byte(f.namespace + " " + name + "; local tests only"))
	return s[:]
}

// KeyFor returns the public key of name's test seed.
func (f *Fixture) KeyFor(name string) Key {
	var k Key
	copy(k[:], ed25519.NewKeyFromSeed(f.Seed(name)).Public().(ed25519.PublicKey))
	return k
}

// ProgramID returns the address the program under test is loaded at.
func (f *Fixture) ProgramID() Key { return f.program }

// SetProgramID replaces the derived program address. Call it before PDA,
// Owned or any declaration.
func (f *Fixture) SetProgramID(k Key) {
	if f.used || len(f.accounts) != 0 {
		f.fail("SetProgramID after the previous address was used")
	}
	f.program = k
}

// Payer returns the runner's fee payer, alias "payer". It starts every scenario
// with the runner's test balance and is not asserted.
func (f *Fixture) Payer() Account {
	var k Key
	copy(k[:], ed25519.NewKeyFromSeed(f.payer).Public().(ed25519.PublicKey))
	return Account{Name: "payer", Key: k}
}

// SetRent pins the suite's Rent sysvar, used for every rent-exempt balance.
func (f *Fixture) SetRent(r Rent) { f.rent = r }

// SetClock pins the suite's initial Clock sysvar.
func (f *Fixture) SetClock(c Clock) { f.clock = &c }

// MinimumBalance is the rent-exempt balance for size bytes under the suite rent.
func (f *Fixture) MinimumBalance(size int) uint64 { return f.rent.MinimumBalance(size) }

// Owned is a program-owned, rent-exempt state holding data.
func (f *Fixture) Owned(data []byte) State {
	f.used = true
	return State{Data: data, Owner: f.program, Lamports: f.MinimumBalance(len(data))}
}

var aliasRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)

func (f *Fixture) declare(name string, key Key, initial *State, seed []byte, watched bool) Account {
	switch {
	case !aliasRE.MatchString(name):
		f.fail("invalid alias %q: use letters, digits, _ and -, starting with a letter", name)
	case name == "program" || name == "payer" || f.byName[name] != nil:
		f.fail("alias %q is reserved or already declared", name)
	case key == f.program || key == f.Payer().Key:
		f.fail("%s: address is the program or the fee payer", name)
	case f.byKey[key] != nil:
		f.fail("%s: address already declared as %q", name, f.byKey[key].name)
	default:
		for _, b := range builtins {
			if b.name == name || b.key == key {
				f.fail("%s: %s is a builtin alias/address", name, b.name)
				return Account{Name: name, Key: key}
			}
		}
		d := &declared{name: name, key: key, initial: initial, seed: seed, watched: watched}
		f.accounts = append(f.accounts, d)
		f.byName[name] = d
		f.byKey[key] = d
	}
	return Account{Name: name, Key: key}
}

// Signer declares a test signer whose key derives from name, with a
// System-owned account holding lamports (none when lamports is zero).
func (f *Fixture) Signer(name string, lamports uint64) Account {
	var initial *State
	if lamports != 0 {
		w := Wallet(lamports)
		initial = &w
	}
	return f.declare(name, f.KeyFor(name), initial, f.Seed(name), true)
}

// PDA declares the program-derived address of seeds under the program ID,
// absent until a transaction creates it. Account.Bump holds the bump.
func (f *Fixture) PDA(name string, seeds ...[]byte) Account {
	f.used = true
	k, bump, err := FindProgramAddress(f.program, seeds...)
	if err != nil {
		f.fail("%s: %v", name, err)
	}
	a := f.declare(name, k, nil, nil, true)
	a.Bump = bump
	return a
}

// Account declares an account with an initial state, at the address derived
// from name.
func (f *Fixture) Account(name string, s State) Account {
	return f.AccountAt(name, f.KeyFor(name), &s)
}

// AccountAt declares an account at key, with an initial state or, for nil,
// none: an address a transaction may create.
func (f *Fixture) AccountAt(name string, key Key, s *State) Account {
	if s != nil {
		if s.Executable {
			f.fail("%s: executable images belong in Program", name)
		}
		copied := *s
		s = &copied
	}
	return f.declare(name, key, s, nil, true)
}

// Program declares another SBF program image, loaded from elf (relative to the
// fixture file's directory) and checked against its hex SHA-256. Invoke it with
// Step.Invoke.
func (f *Fixture) Program(name string, key Key, elf, sha256Hex string) Account {
	a := f.declare(name, key, nil, nil, false)
	if f.err == nil {
		f.accounts = f.accounts[:len(f.accounts)-1] // programs are not accounts
		f.programs = append(f.programs, program{name, Base58(key[:]), elf, sha256Hex})
	}
	return a
}

// Scenario adds a scenario. Each starts from the declared initial states.
func (f *Fixture) Scenario(name string) *Scenario {
	s := &Scenario{f: f, name: name}
	f.scenarios = append(f.scenarios, s)
	return s
}

// Scenario is an ordered list of transactions.
type Scenario struct {
	f         *Fixture
	name      string
	overrides []override
	steps     []*Step
}

type override struct {
	account Account
	state   State
}

// Override starts this scenario with s for a declared account.
func (s *Scenario) Override(a Account, st State) *Scenario {
	if len(s.steps) != 0 {
		s.f.fail("%s: Override after Step", s.name)
	}
	s.overrides = append(s.overrides, override{a, st})
	return s
}

// Step adds a transaction of instructions to the program under test.
func (s *Scenario) Step(ixs ...Instruction) *Step {
	t := &Step{s: s}
	for _, ix := range ixs {
		t.Call(ix)
	}
	s.steps = append(s.steps, t)
	return t
}

type call struct {
	program Key
	main    bool
	ix      Instruction
}

// Step is one transaction and its expectations.
type Step struct {
	s         *Scenario
	calls     []call
	ops       []func(*world) error
	err       any
	failing   bool
	failIndex int
	failCode  *uint64
	cu        *uint64
	logs      map[string]int
	sim       []check
	fresh     bool
	clock     *Clock
	rent      *Rent
}

// Call appends an instruction to the program under test.
func (t *Step) Call(ix Instruction) *Step {
	t.calls = append(t.calls, call{main: true, ix: ix})
	return t
}

// Invoke appends an instruction to another program: a native program, a
// declared Program, or the program under test by its ID.
func (t *Step) Invoke(programID Key, ix Instruction) *Step {
	t.calls = append(t.calls, call{program: programID, main: programID == t.s.f.program, ix: ix})
	return t
}

func (t *Step) op(fn func(*world) error) *Step {
	t.ops = append(t.ops, fn)
	return t
}

// Expect sets an account's complete expected state after this step.
func (t *Step) Expect(a Account, st State) *Step {
	return t.op(func(w *world) error { return w.set(a, &st) })
}

// ExpectAbsent expects that the account does not exist after this step.
func (t *Step) ExpectAbsent(a Account) *Step {
	return t.op(func(w *world) error { return w.set(a, nil) })
}

// ExpectData expects new data in an existing account, with the same owner and
// lamports.
func (t *Step) ExpectData(a Account, data []byte) *Step {
	return t.op(func(w *world) error {
		st, err := w.existing(a)
		if err == nil {
			st.Data = data
			err = w.set(a, &st)
		}
		return err
	})
}

// ExpectLamports expects a new balance in an existing account.
func (t *Step) ExpectLamports(a Account, lamports uint64) *Step {
	return t.op(func(w *world) error {
		st, err := w.existing(a)
		if err == nil {
			st.Lamports = lamports
			err = w.set(a, &st)
		}
		return err
	})
}

// ExpectCreated expects that the program created the absent account a, owned
// by the program, holding data and the rent-exempt balance for it, paid by
// payer, as a generated init does.
func (t *Step) ExpectCreated(a Account, data []byte, payer Account) *Step {
	return t.op(func(w *world) error {
		if st, err := w.state(a); err != nil {
			return err
		} else if st != nil {
			return fmt.Errorf("ExpectCreated: %s already exists", a.Name)
		}
		p, err := w.existing(payer)
		if err != nil {
			return err
		}
		rent := w.rent.MinimumBalance(len(data))
		if p.Lamports < rent {
			return fmt.Errorf("ExpectCreated: %s holds %d lamports, below the %d rent", payer.Name, p.Lamports, rent)
		}
		p.Lamports -= rent
		if err = w.set(payer, &p); err != nil {
			return err
		}
		return w.set(a, &State{Data: data, Owner: w.f.program, Lamports: rent})
	})
}

// ExpectClosed expects that the program closed a, moving its lamports to to:
// committed state has no account, and simulation shows an empty System-owned
// record, as the runtime reports a closed account.
func (t *Step) ExpectClosed(a, to Account) *Step {
	return t.op(func(w *world) error {
		st, err := w.existing(a)
		if err != nil {
			return err
		}
		dst, err := w.existing(to)
		if err != nil {
			return err
		}
		if dst.Lamports+st.Lamports < dst.Lamports {
			return fmt.Errorf("ExpectClosed: %s balance overflows", to.Name)
		}
		dst.Lamports += st.Lamports
		if err = w.set(to, &dst); err != nil {
			return err
		}
		if err = w.set(a, nil); err != nil {
			return err
		}
		t.sim = append(t.sim, check{Account: a.Name, State: stateJSON(Wallet(0))})
		return nil
	})
}

// Fails expects that the step's only instruction fails with a custom error
// code. Every account keeps its state from before the step.
func (t *Step) Fails(code uint64) *Step {
	t.failing, t.failIndex, t.failCode = true, -1, &code
	return t
}

// FailsAt expects that instruction index (from 0) fails with a custom code.
func (t *Step) FailsAt(index int, code uint64) *Step {
	t.failing, t.failIndex, t.failCode = true, index, &code
	return t
}

// FailsWith expects an exact transaction error, as JSON-marshalable data, such
// as InstructionError(0, "MissingRequiredSignature").
func (t *Step) FailsWith(err any) *Step {
	if err == nil {
		t.s.f.fail("FailsWith(nil): a step without Fails succeeds")
	}
	t.failing, t.err, t.failCode = true, err, nil
	return t
}

// InstructionError is the transaction error for instruction index failing with
// err: Custom(code), or a string such as "MissingRequiredSignature".
func InstructionError(index int, err any) any {
	return map[string]any{"InstructionError": []any{index, err}}
}

// Custom is a custom program error, for InstructionError.
func Custom(code uint64) any { return map[string]uint64{"Custom": code} }

// ExpectLog expects exactly n log lines containing substring.
func (t *Step) ExpectLog(substring string, n int) *Step {
	if substring == "" || n < 0 {
		t.s.f.fail("ExpectLog requires a substring and a nonnegative count")
	}
	if t.logs == nil {
		t.logs = map[string]int{}
	}
	t.logs[substring] = n
	return t
}

// ExpectInvocations expects n invocations of a program, counting nested
// (CPI) invocations.
func (t *Step) ExpectInvocations(programID Key, n int) *Step {
	return t.ExpectLog(Base58(programID[:])+" invoke", n)
}

// ExpectReturn expects that the program under test sets data as its return
// data. Empty return data is not logged, so it expects no return log.
func (t *Step) ExpectReturn(data []byte) *Step {
	prefix := "Program return: " + Base58(t.s.f.program[:]) + " "
	if len(data) == 0 {
		return t.ExpectLog(prefix, 0)
	}
	return t.ExpectLog(prefix+base64.StdEncoding.EncodeToString(data), 1)
}

// CU expects exactly n compute units in simulation (0 for a failure before
// execution). Without it the runner requires nonzero compute.
func (t *Step) CU(n uint64) *Step {
	t.cu = &n
	return t
}

// FreshBlockhash expires the blockhash before this step, so an identical
// transaction gets a new signature.
func (t *Step) FreshBlockhash() *Step {
	t.fresh = true
	return t
}

// Clock sets the Clock sysvar before this step; later steps keep it.
func (t *Step) Clock(c Clock) *Step {
	t.clock = &c
	return t
}

// Rent sets the Rent sysvar before this step; later steps keep it, and it sets
// the rent for later ExpectCreated balances in this scenario.
func (t *Step) Rent(r Rent) *Step {
	t.rent = &r
	return t
}

// world is a scenario's expected account states.
type world struct {
	f      *Fixture
	states map[string]*State
	rent   Rent
}

func (w *world) state(a Account) (*State, error) {
	d := w.f.byName[a.Name]
	if d == nil || d.key != a.Key || !d.watched {
		return nil, fmt.Errorf("%s is not a declared account", a.Name)
	}
	return w.states[a.Name], nil
}

func (w *world) existing(a Account) (State, error) {
	st, err := w.state(a)
	if err != nil {
		return State{}, err
	}
	if st == nil {
		return State{}, fmt.Errorf("%s does not exist before this expectation", a.Name)
	}
	out := *st
	return out, nil
}

func (w *world) set(a Account, st *State) error {
	if _, err := w.state(a); err != nil {
		return err
	}
	if st != nil && st.Executable {
		return fmt.Errorf("%s: executable accounts are not supported", a.Name)
	}
	w.states[a.Name] = st
	return nil
}

// JSON fields are listed in sorted order, so the file matches a sorted-map
// encoding and diffs stay small.
type stateDoc struct {
	Data       string `json:"data"`
	Executable bool   `json:"executable"`
	Lamports   uint64 `json:"lamports"`
	Owner      string `json:"owner"`
	RentEpoch  uint64 `json:"rent_epoch"`
}

func stateJSON(s State) *stateDoc {
	return &stateDoc{hex.EncodeToString(s.Data), s.Executable, s.Lamports, Base58(s.Owner[:]), s.RentEpoch}
}

type check struct {
	Absent  bool      `json:"absent,omitempty"`
	Account string    `json:"account"`
	State   *stateDoc `json:"state,omitempty"`
}

type metaDoc struct {
	Account  string `json:"account"`
	Signer   bool   `json:"signer"`
	Writable bool   `json:"writable"`
}

type instructionDoc struct {
	Accounts []metaDoc `json:"accounts"`
	Data     string    `json:"data"`
	Program  string    `json:"program"`
}

type expectDoc struct {
	Accounts           []check        `json:"accounts"`
	CU                 *uint64        `json:"cu,omitempty"`
	Error              any            `json:"error"`
	LogCounts          map[string]int `json:"log_counts,omitempty"`
	SimulationAccounts []check        `json:"simulation_accounts,omitempty"`
}

type rentDoc struct {
	BurnPercent         uint8   `json:"burn_percent"`
	ExemptionThreshold  float64 `json:"exemption_threshold"`
	LamportsPerByteYear uint64  `json:"lamports_per_byte_year"`
}

type clockDoc struct {
	Epoch               uint64 `json:"epoch"`
	EpochStartTimestamp int64  `json:"epoch_start_timestamp"`
	LeaderScheduleEpoch uint64 `json:"leader_schedule_epoch"`
	Slot                uint64 `json:"slot"`
	UnixTimestamp       int64  `json:"unix_timestamp"`
}

type sysvarsDoc struct {
	Clock *clockDoc `json:"clock,omitempty"`
	Rent  *rentDoc  `json:"rent,omitempty"`
}

func sysvars(c *Clock, r *Rent) *sysvarsDoc {
	if c == nil && r == nil {
		return nil
	}
	out := &sysvarsDoc{}
	if c != nil {
		out.Clock = &clockDoc{c.Epoch, c.EpochStartTimestamp, c.LeaderScheduleEpoch, c.Slot, c.UnixTimestamp}
	}
	if r != nil {
		if r.ExemptionThreshold != r.ExemptionThreshold || math.IsInf(r.ExemptionThreshold, 0) || r.ExemptionThreshold < 0 || r.BurnPercent > 100 {
			return nil
		}
		out.Rent = &rentDoc{r.BurnPercent, r.ExemptionThreshold, r.LamportsPerByteYear}
	}
	return out
}

type stepDoc struct {
	Expect         expectDoc        `json:"expect"`
	FreshBlockhash bool             `json:"fresh_blockhash,omitempty"`
	Instructions   []instructionDoc `json:"instructions"`
	Sysvars        *sysvarsDoc      `json:"sysvars,omitempty"`
}

type overrideDoc struct {
	Name  string    `json:"name"`
	State *stateDoc `json:"state"`
}

type caseDoc struct {
	Name      string        `json:"name"`
	Overrides []overrideDoc `json:"overrides,omitempty"`
	Steps     []stepDoc     `json:"steps"`
}

type namedDoc struct {
	Address string `json:"address"`
	Name    string `json:"name"`
}

type seedDoc struct {
	Name string `json:"name"`
	Seed string `json:"seed"`
}

type programDoc struct {
	Address string `json:"address"`
	ELF     string `json:"elf"`
	Name    string `json:"name"`
	SHA256  string `json:"sha256"`
}

type accountDoc struct {
	Address string    `json:"address"`
	Initial *stateDoc `json:"initial,omitempty"`
	Name    string    `json:"name"`
}

type suiteDoc struct {
	Format         string       `json:"format"`
	ProgramID      string       `json:"program_id"`
	PayerSeed      string       `json:"payer_seed"`
	Sysvars        *sysvarsDoc  `json:"sysvars,omitempty"`
	Signers        []seedDoc    `json:"signers,omitempty"`
	Programs       []programDoc `json:"programs,omitempty"`
	NativePrograms []namedDoc   `json:"native_programs,omitempty"`
	Accounts       []accountDoc `json:"accounts"`
	Cases          []caseDoc    `json:"cases"`
}

// JSON returns the fixture file, indented and newline-terminated, or the first
// error in the fixture's construction.
func (f *Fixture) JSON() ([]byte, error) {
	if f.err != nil {
		return nil, f.err
	}
	if len(f.scenarios) == 0 {
		return nil, errors.New("fixture: no scenarios")
	}
	doc := suiteDoc{Format: Format, ProgramID: Base58(f.program[:]), PayerSeed: hex.EncodeToString(f.payer), Sysvars: sysvars(f.clock, &f.rent)}
	if doc.Sysvars == nil {
		return nil, errors.New("fixture: rent requires a finite nonnegative threshold and burn percent <= 100")
	}
	// Aliases for every key an instruction may reference.
	aliases := map[Key]string{f.program: "program", f.Payer().Key: "payer"}
	signers := map[Key]bool{f.Payer().Key: true}
	watched := []*declared{}
	for _, d := range f.accounts {
		aliases[d.key] = d.name
		if d.seed != nil {
			signers[d.key] = true
			doc.Signers = append(doc.Signers, seedDoc{d.name, hex.EncodeToString(d.seed)})
		}
		a := accountDoc{Address: Base58(d.key[:]), Name: d.name}
		if d.initial != nil {
			a.Initial = stateJSON(*d.initial)
		}
		doc.Accounts = append(doc.Accounts, a)
		watched = append(watched, d)
	}
	if len(watched) > 64 {
		return nil, fmt.Errorf("fixture: %d declared accounts; each step asserts every one and the runner allows 64", len(watched))
	}
	programs := map[Key]bool{f.program: true}
	for _, p := range f.programs {
		k, _ := ParseKey(p.address)
		aliases[k] = p.name
		programs[k] = true
		doc.Programs = append(doc.Programs, programDoc{p.address, p.elf, p.name, p.sha256})
	}
	builtin := func(k Key, asProgram bool) (string, bool) {
		for _, b := range builtins {
			if b.key != k || b.native != asProgram {
				continue
			}
			if _, ok := aliases[k]; !ok {
				aliases[k] = b.name
				if b.native {
					programs[k] = true
					doc.NativePrograms = append(doc.NativePrograms, namedDoc{Base58(k[:]), b.name})
				} else {
					doc.Accounts = append(doc.Accounts, accountDoc{Address: Base58(k[:]), Name: b.name})
				}
			}
			return b.name, true
		}
		return "", false
	}
	seen := map[string]bool{}
	for _, s := range f.scenarios {
		if s.name == "" || seen[s.name] {
			return nil, fmt.Errorf("fixture: scenario names must be unique and nonempty: %q", s.name)
		}
		seen[s.name] = true
		if len(s.steps) == 0 {
			return nil, fmt.Errorf("fixture: %s has no steps", s.name)
		}
		w := &world{f: f, states: map[string]*State{}, rent: f.rent}
		for _, d := range watched {
			w.states[d.name] = d.initial
		}
		c := caseDoc{Name: s.name}
		for _, o := range s.overrides {
			st := o.state
			if err := w.set(o.account, &st); err != nil {
				return nil, fmt.Errorf("fixture: %s override: %w", s.name, err)
			}
			if st.Executable {
				return nil, fmt.Errorf("fixture: %s override: executable state", s.name)
			}
			c.Overrides = append(c.Overrides, overrideDoc{o.account.Name, stateJSON(st)})
		}
		for i, t := range s.steps {
			where := fmt.Sprintf("fixture: %s step %d", s.name, i+1)
			if len(t.calls) == 0 {
				return nil, fmt.Errorf("%s: no instructions", where)
			}
			step := stepDoc{FreshBlockhash: t.fresh, Expect: expectDoc{CU: t.cu, Error: nil, LogCounts: t.logs}}
			if t.clock != nil || t.rent != nil {
				if step.Sysvars = sysvars(t.clock, t.rent); step.Sysvars == nil {
					return nil, fmt.Errorf("%s: invalid rent", where)
				}
				if t.rent != nil {
					w.rent = *t.rent
				}
			}
			for _, cl := range t.calls {
				ix := instructionDoc{Data: hex.EncodeToString(cl.ix.Data), Accounts: []metaDoc{}}
				if cl.main {
					ix.Program = "program"
				} else if name, ok := builtin(cl.program, true); ok {
					ix.Program = name
				} else if programs[cl.program] {
					ix.Program = aliases[cl.program]
				} else {
					return nil, fmt.Errorf("%s: program %s is not declared", where, Base58(cl.program[:]))
				}
				for _, m := range cl.ix.Accounts {
					name, ok := aliases[m.Key]
					if !ok {
						if name, ok = builtin(m.Key, false); !ok {
							if name, ok = builtin(m.Key, true); !ok {
								return nil, fmt.Errorf("%s: account %s is not declared", where, Base58(m.Key[:]))
							}
						}
					}
					if m.Signer && !signers[m.Key] {
						return nil, fmt.Errorf("%s: %s signs but has no test seed; declare it with Signer", where, name)
					}
					ix.Accounts = append(ix.Accounts, metaDoc{name, m.Signer, m.Writable})
				}
				step.Instructions = append(step.Instructions, ix)
			}
			if t.failing {
				if t.failCode != nil {
					index := t.failIndex
					if index < 0 {
						if len(t.calls) != 1 {
							return nil, fmt.Errorf("%s: Fails needs FailsAt with %d instructions", where, len(t.calls))
						}
						index = 0
					}
					if index >= len(t.calls) {
						return nil, fmt.Errorf("%s: FailsAt index %d out of range", where, index)
					}
					step.Expect.Error = InstructionError(index, Custom(*t.failCode))
				} else {
					step.Expect.Error = t.err
				}
				if len(t.ops) != 0 {
					return nil, fmt.Errorf("%s: a failing step rolls back, so it cannot expect state changes", where)
				}
			} else {
				t.sim = nil
				for _, op := range t.ops {
					if err := op(w); err != nil {
						return nil, fmt.Errorf("%s: %w", where, err)
					}
				}
				step.Expect.SimulationAccounts = t.sim
			}
			for _, d := range watched {
				if st := w.states[d.name]; st == nil {
					step.Expect.Accounts = append(step.Expect.Accounts, check{Absent: true, Account: d.name})
				} else {
					step.Expect.Accounts = append(step.Expect.Accounts, check{Account: d.name, State: stateJSON(*st)})
				}
			}
			if len(step.Expect.Accounts) == 0 {
				return nil, fmt.Errorf("%s: the runner requires an asserted account; declare one", where)
			}
			c.Steps = append(c.Steps, step)
		}
		doc.Cases = append(doc.Cases, c)
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// Base58 encodes bytes with the alphabet Solana addresses use.
func Base58(b []byte) string {
	n := new(big.Int).SetBytes(b)
	var out []byte
	for mod := new(big.Int); n.Sign() > 0; {
		n.DivMod(n, big.NewInt(58), mod)
		out = append(out, alphabet[mod.Int64()])
	}
	for _, c := range b {
		if c != 0 {
			break
		}
		out = append(out, '1')
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

// ParseKey decodes a canonical base58 address.
func ParseKey(s string) (Key, error) {
	var k Key
	n := new(big.Int)
	for _, c := range []byte(s) {
		i := bytes.IndexByte([]byte(alphabet), c)
		if i < 0 {
			return k, fmt.Errorf("invalid base58 address %q", s)
		}
		n.Mul(n, big.NewInt(58)).Add(n, big.NewInt(int64(i)))
	}
	zeros := 0
	for zeros < len(s) && s[zeros] == '1' {
		zeros++
	}
	b := append(make([]byte, zeros), n.Bytes()...)
	if len(b) != 32 {
		return k, fmt.Errorf("address %q is not 32 bytes", s)
	}
	copy(k[:], b)
	return k, nil
}

// MustParseKey is ParseKey for constants; it panics on an invalid address.
func MustParseKey(s string) Key {
	k, err := ParseKey(s)
	if err != nil {
		panic(err)
	}
	return k
}

// FindProgramAddress returns the first off-curve address for seeds plus a bump
// byte, counting down from 255 to 1, as Solana's find_program_address does
// (it never tries 0).
func FindProgramAddress(programID Key, seeds ...[]byte) (Key, byte, error) {
	if len(seeds) > 15 {
		return Key{}, 0, errors.New("at most 15 seeds plus the bump")
	}
	for _, s := range seeds {
		if len(s) > 32 {
			return Key{}, 0, errors.New("a seed exceeds 32 bytes")
		}
	}
	for bump := 255; bump > 0; bump-- {
		h := sha256.New()
		for _, s := range seeds {
			h.Write(s)
		}
		h.Write([]byte{byte(bump)})
		h.Write(programID[:])
		h.Write([]byte("ProgramDerivedAddress"))
		var k Key
		copy(k[:], h.Sum(nil))
		if !OnCurve(k) {
			return k, byte(bump), nil
		}
	}
	return Key{}, 0, errors.New("no program address found")
}

var (
	fieldP = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))
	curveD = func() *big.Int {
		inv := new(big.Int).ModInverse(big.NewInt(121666), fieldP)
		return new(big.Int).Mod(new(big.Int).Mul(big.NewInt(-121665), inv), fieldP)
	}()
	halfP = new(big.Int).Rsh(new(big.Int).Sub(fieldP, big.NewInt(1)), 1)
)

// OnCurve reports whether k decompresses to an Ed25519 point, as
// curve25519-dalek's decompress does: y is reduced mod p, and x exists when
// (y²-1)/(dy²+1) is a square.
func OnCurve(k Key) bool {
	le := k
	le[31] &= 0x7f
	for i, j := 0, 31; i < j; i, j = i+1, j-1 {
		le[i], le[j] = le[j], le[i]
	}
	y := new(big.Int).Mod(new(big.Int).SetBytes(le[:]), fieldP)
	yy := new(big.Int).Mod(new(big.Int).Mul(y, y), fieldP)
	u := new(big.Int).Mod(new(big.Int).Sub(yy, big.NewInt(1)), fieldP)
	v := new(big.Int).Mod(new(big.Int).Add(new(big.Int).Mul(curveD, yy), big.NewInt(1)), fieldP)
	if u.Sign() == 0 {
		return true
	}
	// v is never zero: -1/d is not a square.
	x2 := new(big.Int).Mod(new(big.Int).Mul(u, new(big.Int).ModInverse(v, fieldP)), fieldP)
	return new(big.Int).Exp(x2, halfP, fieldP).Cmp(big.NewInt(1)) == 0
}
