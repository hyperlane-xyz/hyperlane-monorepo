package compositeism

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

type specContext struct {
	programID svm.Pubkey
	message   *hyperlanecore.HyperlaneMessage
	encoded   []byte
	count     uint64
}

// sframe is one active spec_and_accounts_for_node call.
type sframe struct {
	node *IsmNode
	// next is the next sub-ISM (Aggregation) or 1 once a pass-through node
	// (AmountRouting, Routing domain override) has pushed its child.
	next int
	subs []ism.MetadataSpec
}

// specResult is the outcome of one call: an error (Error variant), a
// resolved spec, or spec None with the accounts still needed.
type specResult struct {
	code     uint64
	resolved bool
	spec     ism.MetadataSpec
	accounts [][32]byte
}

// getMetadataSpec is processor::get_metadata_spec, returned as
// SimulationReturnData<MetadataSpecResult>.
//
// Accounts:
// 0. `[]` The storage PDA.
// 1..N. Accounts from the previous pass of the fixpoint loop.
func getMetadataSpec(c solana.Context, encoded []byte, message *hyperlanecore.HyperlaneMessage) uint64 {
	s := new(specContext)
	s.programID = svm.ProgramID(c)
	s.message = message
	s.encoded = encoded
	s.count = solana.Count(c)
	it := svm.NewAccountIter(c)
	storageAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	storage, code := loadStorage(c, storageAcct, &s.programID)
	if code != svm.Success {
		return code
	}
	if !storage.Root.Some {
		return ErrConfigNotSet
	}
	res := s.run(c, &storage.Root.Value)
	if res.code != svm.Success {
		return res.code
	}
	out := new(ism.MetadataSpecResult)
	if res.resolved {
		out.Spec = borsh.SomeOf(res.spec)
		out.Accounts = [][32]byte{}
	} else {
		// The storage PDA (same seeds), verified by loadStorage above.
		vamPDA := svm.Key(c, storageAcct)
		out.Accounts = make([][32]byte, 0, 1+len(res.accounts))
		out.Accounts = append(out.Accounts, vamPDA)
		out.Accounts = append(out.Accounts, res.accounts...)
	}
	return solana.SetReturnData(c, ism.EncodeMetadataSpecReturnData(out))
}

// catchable reports the errors an Aggregation turns into CannotVerify.
func catchable(code uint64) bool {
	return code == ErrNoRouteForDomain || code == ErrInvalidMessageBody ||
		code == ErrThresholdNotMet || code == ErrFallbackIsmCallFailed
}

// run is spec_and_accounts_for_node(root) as an explicit-stack loop. A
// finished call hands its result to its parent: an Aggregation collects
// resolved specs and catches the errors in catchable; every other node passes
// its child's result through. An unresolved result (spec None) always
// propagates to the root, as in Rust.
func (s *specContext) run(c solana.Context, root *IsmNode) specResult {
	frames := make([]sframe, 0, 8)
	frames = append(frames, sframe{node: root})
	var res specResult
	for len(frames) > 0 {
		top := len(frames) - 1
		f := &frames[top]
		n := f.node
		switch n.Kind {
		case NodeAggregation:
			if f.next < len(n.Subs) {
				if f.subs == nil {
					f.subs = make([]ism.MetadataSpec, 0, len(n.Subs))
				}
				i := f.next
				f.next++
				frames = append(frames, sframe{node: &n.Subs[i]})
				continue
			}
			viable := 0
			for i := range f.subs {
				if f.subs[i].Kind != ism.SpecCannotVerify {
					viable++
				}
			}
			if viable < int(n.Threshold) {
				res = specResult{code: ErrThresholdNotMet}
			} else {
				if f.subs == nil {
					f.subs = []ism.MetadataSpec{}
				}
				res = specResult{resolved: true, spec: ism.MetadataSpec{Kind: ism.SpecAggregation, Threshold: n.Threshold, SubSpecs: f.subs}}
			}
		case NodeAmountRouting:
			if f.next == 0 {
				f.next = 1
				upper, ok := amountAtLeast(s.message.Body, &n.Amount)
				if !ok {
					res = specResult{code: ErrInvalidMessageBody}
					break
				}
				sub := n.Lower()
				if upper {
					sub = n.Upper()
				}
				frames = append(frames, sframe{node: sub})
				continue
			}
		case NodeRouting, NodeFallbackRouting:
			if f.next == 0 {
				f.next = 1
				var domainISM *IsmNode
				domainISM, res = s.routing(c, n)
				if domainISM != nil {
					frames = append(frames, sframe{node: domainISM})
					continue
				}
				break
			}
		default:
			res = s.leaf(c, n)
		}
		// Deliver res to the callers, popping finished frames.
		frames = frames[:top]
		for len(frames) > 0 {
			p := &frames[len(frames)-1]
			if p.node.Kind != NodeAggregation {
				// Pass-through: the parent call returns the child's result.
				frames = frames[:len(frames)-1]
				continue
			}
			if res.code != svm.Success {
				if !catchable(res.code) {
					return res
				}
				p.subs = append(p.subs, ism.MetadataSpec{Kind: ism.SpecCannotVerify})
			} else if !res.resolved {
				return res
			} else {
				p.subs = append(p.subs, res.spec)
			}
			break
		}
	}
	return res
}

// leaf resolves a node without children.
func (s *specContext) leaf(c solana.Context, n *IsmNode) specResult {
	switch n.Kind {
	case NodeMultisigMessageID:
		return specResult{resolved: true, spec: ism.MetadataSpec{Kind: ism.SpecMultisigMessageID, Validators: n.Validators, Threshold: n.Threshold}}
	case NodeTrustedRelayer:
		return specResult{resolved: true, spec: ism.MetadataSpec{Kind: ism.SpecTrustedRelayer, Relayer: n.Key}}
	case NodeTest:
		return nullOr(n.Accept)
	case NodePausable:
		return nullOr(!n.Paused)
	case NodeRateLimited:
		return nullOr(s.rateLimitedPasses(c, n))
	}
	return specResult{code: ErrInvalidConfig}
}

func nullOr(ok bool) specResult {
	if ok {
		return specResult{resolved: true, spec: ism.MetadataSpec{Kind: ism.SpecNull}}
	}
	return specResult{resolved: true, spec: ism.MetadataSpec{Kind: ism.SpecCannotVerify}}
}

// rateLimitedPasses is rate_limited_spec == Null.
func (s *specContext) rateLimitedPasses(c solana.Context, n *IsmNode) bool {
	if n.Recipient.Some && s.message.Recipient != n.Recipient.Value {
		return false
	}
	amount, code := rateLimitedAmount(s.message.Body)
	if code != svm.Success {
		return false
	}
	now, code := clockNow(c)
	if code != svm.Success {
		return false
	}
	return amount <= currentLevel(n.FilledLevel, n.LastUpdated, now, n.MaxCapacity)
}

func unresolved(accounts ...[32]byte) specResult {
	return specResult{accounts: accounts}
}

// routing is the Routing/FallbackRouting arm. extra_accounts[k] is
// instruction account k+1. It returns the domain override's ISM when there
// is one (its result passes through), else the arm's own result.
func (s *specContext) routing(c solana.Context, n *IsmNode) (*IsmNode, specResult) {
	domainKey, code := deriveDomainPDA(c, &s.programID, s.message.Origin)
	if code != svm.Success {
		return nil, specResult{code: code}
	}
	if !(s.count > 1 && svm.KeyIs(c, 1, domainKey)) {
		return nil, unresolved(domainKey)
	}
	ds, code := loadDomainStorage(c, &s.programID, s.message.Origin, 1)
	if code != svm.Success {
		return nil, specResult{code: ErrInvalidConfig}
	}
	if ds != nil && ds.Ism.Some {
		return &ds.Ism.Value, specResult{}
	}
	if n.Kind == NodeRouting {
		return nil, specResult{code: ErrNoRouteForDomain}
	}
	return nil, s.fallbackSpec(c, &n.Key, domainKey)
}

// fallbackSpec resolves the FallbackRouting fallback path by CPI.
func (s *specContext) fallbackSpec(c solana.Context, fallback *svm.Pubkey, domainKey svm.Pubkey) specResult {
	fallbackVAM, _, code := svm.FindProgramAddress(c, ism.VerifyAccountMetasPDASeeds, *fallback)
	if code != svm.Success {
		return specResult{code: code}
	}
	if !(s.count > 2 && svm.KeyIs(c, 2, fallbackVAM)) {
		return unresolved(domainKey, fallbackVAM, *fallback)
	}

	// Type first, so legacy ISMs without VerifyMetadataSpec still resolve.
	typeIx := ism.Instruction{Kind: ism.KindType}
	if invokeOne(c, fallback, 2, typeIx.Encode()) != svm.Success {
		return specResult{code: ErrFallbackIsmCallFailed}
	}
	data, ok := returnData(c)
	if !ok || len(data) != 5 {
		return specResult{code: ErrFallbackIsmCallFailed}
	}
	fallbackType := uint32(data[0]) | uint32(data[1])<<8 | uint32(data[2])<<16 | uint32(data[3])<<24

	switch fallbackType {
	case hyperlanecore.ModuleTypeMessageIDMultisig:
		return s.legacyMultisigSpec(c, fallback, domainKey, fallbackVAM)
	case hyperlanecore.ModuleTypeUnused:
		return specResult{resolved: true, spec: ism.MetadataSpec{Kind: ism.SpecNull}}
	}

	ix := ism.Instruction{Kind: ism.KindVerifyMetadataSpec, Message: s.encoded}
	if invokeRange(c, fallback, 2, s.count, ix.Encode()) != svm.Success {
		return specResult{code: ErrFallbackIsmCallFailed}
	}
	data, ok = returnData(c)
	if !ok {
		return specResult{code: ErrFallbackIsmCallFailed}
	}
	r := borsh.NewReader(data)
	inner := new(ism.MetadataSpecResult)
	inner.DecodeBorsh(&r)
	r.U8()
	if !r.Done() {
		return specResult{code: ErrFallbackIsmCallFailed}
	}
	if inner.Spec.Some {
		return specResult{resolved: true, spec: inner.Spec.Value}
	}
	accounts := make([][32]byte, 0, len(inner.Accounts)+2)
	accounts = append(accounts, domainKey)
	accounts = append(accounts, inner.Accounts...)
	accounts = append(accounts, *fallback)
	return specResult{accounts: accounts}
}
