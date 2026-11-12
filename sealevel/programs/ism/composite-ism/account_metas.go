package compositeism

import (
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

type metaContext struct {
	programID svm.Pubkey
	message   *hyperlanecore.HyperlaneMessage
	encoded   []byte
	count     uint64
	out       []accountmeta.SerializableAccountMeta
}

// aframe is one active required_accounts_for_node call. Results are appended
// to metaContext.out in the order Rust concatenates them.
type aframe struct {
	node *IsmNode
	meta []byte
	// cursor is the instruction account index where this call's
	// extra_accounts slice starts.
	cursor uint64
	next   int
	// childStart is len(out) when the current Aggregation child started.
	childStart int
}

// verifyAccountMetas is processor::verify_account_metas, returned as
// SimulationReturnData<Vec<SerializableAccountMeta>>.
//
// Accounts:
// 0. `[]` The storage PDA.
// 1..N. Accounts from the previous pass (domain PDAs, fallback accounts).
func verifyAccountMetas(c solana.Context, metadata, encoded []byte, message *hyperlanecore.HyperlaneMessage) uint64 {
	m := new(metaContext)
	m.programID = svm.ProgramID(c)
	m.message = message
	m.encoded = encoded
	m.count = solana.Count(c)
	it := svm.NewAccountIter(c)
	storageAcct, code := it.Next()
	if code != svm.Success {
		return code
	}
	storage, code := loadStorage(c, storageAcct, &m.programID)
	if code != svm.Success {
		return code
	}
	if !storage.Root.Some {
		return ErrConfigNotSet
	}
	root := &storage.Root.Value
	// The VAM PDA is the storage PDA (same seeds), which loadStorage just
	// verified with its stored bump.
	vamPDA := svm.Key(c, storageAcct)
	m.out = make([]accountmeta.SerializableAccountMeta, 0, 8)
	if reachableRateLimited(root, metadata, message) {
		m.out = append(m.out, accountmeta.Writable(vamPDA, false))
	} else {
		m.out = append(m.out, accountmeta.Readonly(vamPDA, false))
	}
	if code := m.run(c, root, metadata, 1); code != svm.Success {
		return code
	}
	return solana.SetReturnData(c, accountmeta.EncodeMetasReturnData(m.out))
}

type rframe struct {
	node *IsmNode
	meta []byte
}

// reachableRateLimited is reachable_contains_rate_limited. It has no side
// effects, so the visiting order does not matter.
func reachableRateLimited(root *IsmNode, metadata []byte, message *hyperlanecore.HyperlaneMessage) bool {
	stack := make([]rframe, 0, 8)
	stack = append(stack, rframe{node: root, meta: metadata})
	for len(stack) > 0 {
		f := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n := f.node
		switch n.Kind {
		case NodeRateLimited:
			return true
		case NodeAggregation:
			for i := len(n.Subs) - 1; i >= 0; i-- {
				sub, ok, code := subMetadataAt(f.meta, i)
				if code == svm.Success && ok {
					stack = append(stack, rframe{node: &n.Subs[i], meta: sub})
				}
			}
		case NodeAmountRouting:
			upper, ok := amountAtLeast(message.Body, &n.Amount)
			if !ok {
				continue
			}
			sub := n.Lower()
			if upper {
				sub = n.Upper()
			}
			stack = append(stack, rframe{node: sub, meta: f.meta})
		}
	}
	return false
}

func (m *metaContext) push(c solana.Context, meta accountmeta.SerializableAccountMeta) {
	m.out = append(m.out, meta)
}

// run is required_accounts_for_node(root, metadata, extra_accounts =
// accounts[cursor..]) as an explicit-stack loop.
func (m *metaContext) run(c solana.Context, root *IsmNode, metadata []byte, cursor uint64) uint64 {
	frames := make([]aframe, 0, 8)
	frames = append(frames, aframe{node: root, meta: metadata, cursor: cursor})
	for len(frames) > 0 {
		top := len(frames) - 1
		f := &frames[top]
		n := f.node
		switch n.Kind {
		case NodeTrustedRelayer:
			m.push(c, accountmeta.Readonly(n.Key, true))
		case NodeAggregation:
			if f.next < len(n.Subs) {
				i := f.next
				f.next++
				sub, ok, code := subMetadataAt(f.meta, i)
				if code != svm.Success {
					return code
				}
				if ok {
					f.childStart = len(m.out)
					frames = append(frames, aframe{node: &n.Subs[i], meta: sub, cursor: f.cursor})
				}
				continue
			}
		case NodeAmountRouting:
			if f.next == 0 {
				f.next = 1
				upper, ok := amountAtLeast(m.message.Body, &n.Amount)
				if !ok {
					return ErrInvalidMessageBody
				}
				sub := n.Lower()
				if upper {
					sub = n.Upper()
				}
				frames = append(frames, aframe{node: sub, meta: f.meta, cursor: f.cursor})
				continue
			}
		case NodeRouting, NodeFallbackRouting:
			if f.next == 0 {
				f.next = 1
				domainISM, code := m.routing(c, f)
				if code != svm.Success {
					return code
				}
				if domainISM != nil {
					frames = append(frames, aframe{node: domainISM, meta: f.meta, cursor: f.cursor})
					continue
				}
			}
		case NodeRateLimited:
			authority, code := processAuthority(c, &n.Key, &m.programID)
			if code != svm.Success {
				return code
			}
			m.push(c, accountmeta.Readonly(authority, true))
		}
		frames = frames[:top]
		if top > 0 {
			p := &frames[top-1]
			if p.node.Kind == NodeAggregation {
				// Advance past the accounts this sub-ISM consumes at verify time.
				used := uint64(len(m.out) - p.childStart)
				if rest := m.count - p.cursor; p.cursor > m.count || used > rest {
					p.cursor = m.count
				} else {
					p.cursor += used
				}
			}
		}
	}
	return svm.Success
}

func (m *metaContext) domainMeta(c solana.Context, key svm.Pubkey, writable bool) {
	if writable {
		m.push(c, accountmeta.Writable(key, false))
	} else {
		m.push(c, accountmeta.Readonly(key, false))
	}
}

// loadDomainISM reads the domain PDA at index i for VerifyAccountMetas: nil
// when it is not owned by this program, uninitialized or has no ISM.
func (m *metaContext) loadDomainISM(c solana.Context, i uint64) (*IsmNode, uint64) {
	if !svm.OwnerIs(c, i, m.programID) {
		return nil, svm.Success
	}
	ds := new(DomainStorage)
	ok, code := fetchDomainStorage(solana.Data(c, i), ds)
	if code != svm.Success {
		return nil, svm.InvalidAccountData
	}
	if !ok || !ds.Ism.Some {
		return nil, svm.Success
	}
	return &ds.Ism.Value, svm.Success
}

// routing emits the Routing/FallbackRouting accounts. It returns the domain
// PDA's ISM when its accounts must follow (emitted by the caller's walk).
func (m *metaContext) routing(c solana.Context, f *aframe) (*IsmNode, uint64) {
	n := f.node
	domainKey, code := deriveDomainPDA(c, &m.programID, m.message.Origin)
	if code != svm.Success {
		return nil, code
	}
	present := f.cursor < m.count && svm.KeyIs(c, f.cursor, domainKey)
	if n.Kind == NodeRouting {
		var domainISM *IsmNode
		if present {
			domainISM, code = m.loadDomainISM(c, f.cursor)
			if code != svm.Success {
				return nil, code
			}
		}
		m.domainMeta(c, domainKey, domainISM != nil && containsKind(domainISM, NodeRateLimited))
		return domainISM, svm.Success
	}

	if !present {
		m.push(c, accountmeta.Readonly(domainKey, false))
		return nil, svm.Success
	}
	domainISM, code := m.loadDomainISM(c, f.cursor)
	if code != svm.Success {
		return nil, code
	}
	if domainISM != nil {
		m.domainMeta(c, domainKey, containsKind(domainISM, NodeRateLimited))
		return domainISM, svm.Success
	}

	fallback := &n.Key
	fallbackStorage, _, code := svm.FindProgramAddress(c, ism.VerifyAccountMetasPDASeeds, *fallback)
	if code != svm.Success {
		return nil, code
	}
	first := f.cursor + 1
	if !(first < m.count && svm.KeyIs(c, first, fallbackStorage)) {
		m.push(c, accountmeta.Readonly(domainKey, false))
		m.push(c, accountmeta.Readonly(fallbackStorage, false))
		m.push(c, accountmeta.Readonly(*fallback, false))
		return nil, svm.Success
	}

	ix := ism.Instruction{Kind: ism.KindVerifyAccountMetas, Metadata: f.meta, Message: m.encoded}
	if code := invokeRange(c, fallback, first, m.count, ix.Encode()); code != svm.Success {
		return nil, code
	}
	data, ok := returnData(c)
	if !ok {
		return nil, ErrInvalidFallbackIsmAccount
	}
	inner, ok := accountmeta.DecodeMetasReturnData(data)
	if !ok {
		return nil, svm.BorshIoError
	}
	m.push(c, accountmeta.Readonly(domainKey, false))
	m.push(c, accountmeta.Readonly(fallbackStorage, false))
	sentinel := len(m.out) - 1
	for i := range inner {
		if i == 0 && inner[0].Pubkey == fallbackStorage {
			// The fallback composite ISM lists its own VAM PDA first: merge
			// its flags into the sentinel instead of duplicating it.
			m.out[sentinel].IsWritable = m.out[sentinel].IsWritable || inner[0].IsWritable
			m.out[sentinel].IsSigner = m.out[sentinel].IsSigner || inner[0].IsSigner
			continue
		}
		m.push(c, inner[i])
	}
	m.push(c, accountmeta.Readonly(*fallback, false))
	return nil, svm.Success
}
