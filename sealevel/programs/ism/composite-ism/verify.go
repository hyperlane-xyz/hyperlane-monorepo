package compositeism

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	ism "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/interchain-security-module-interface"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// verifyContext is the state verify_node threads through its recursion.
type verifyContext struct {
	programID svm.Pubkey
	it        svm.AccountIter
	message   *hyperlanecore.HyperlaneMessage
	encoded   []byte
	// rootMutated is did_mutate for the storage PDA's tree.
	rootMutated bool
}

// vframe is one active verify_node call.
type vframe struct {
	node *IsmNode
	meta []byte
	// next is the next sub-ISM (Aggregation) or the stage (0 = not
	// started) for AmountRouting, Routing and FallbackRouting.
	next     int
	verified int
	// owner is the index of the Routing frame whose domain tree holds this
	// node, or -1 for the storage PDA's tree.
	owner int
	// Routing/FallbackRouting: the loaded domain PDA and its did_mutate.
	domainAcct uint64
	domain     *DomainStorage
	mutated    bool
}

// verify is processor::verify.
//
// Accounts:
// 0. `[]` The storage PDA (writable when the tree mutates RateLimited state).
// 1..N. The accounts returned by VerifyAccountMetas.
func verify(c solana.Context, metadata, encoded []byte, message *hyperlanecore.HyperlaneMessage) uint64 {
	v := new(verifyContext)
	v.programID = svm.ProgramID(c)
	v.it = svm.NewAccountIter(c)
	v.message = message
	v.encoded = encoded
	storageAcct, code := v.it.Next()
	if code != svm.Success {
		return code
	}
	storage, code := loadStorage(c, storageAcct, &v.programID)
	if code != svm.Success {
		return code
	}
	if !storage.Root.Some {
		return ErrConfigNotSet
	}
	if code := v.run(c, &storage.Root.Value, metadata); code != svm.Success {
		return code
	}
	if v.rootMutated {
		if !solana.Writable(c, storageAcct) {
			return ErrDomainPdaNotWritable
		}
		return accountutils.Store(c, storageAcct, storage, false)
	}
	return svm.Success
}

// run is verify_node(root, metadata) as a loop over an explicit stack of
// calls. A node's checks run when its frame is on top; a finished frame pops
// and counts as verified for its parent. Any error ends the walk, as `?`
// does in Rust.
func (v *verifyContext) run(c solana.Context, root *IsmNode, metadata []byte) uint64 {
	frames := make([]vframe, 0, 8)
	frames = append(frames, vframe{node: root, meta: metadata, owner: -1})
	for len(frames) > 0 {
		top := len(frames) - 1
		f := &frames[top]
		n := f.node
		switch n.Kind {
		case NodeAggregation:
			if f.next < len(n.Subs) {
				i := f.next
				f.next++
				sub, ok, code := subMetadataAt(f.meta, i)
				if code != svm.Success {
					return code
				}
				if ok {
					frames = append(frames, vframe{node: &n.Subs[i], meta: sub, owner: f.owner})
				}
				continue
			}
			if f.verified != int(n.Threshold) {
				return ErrThresholdNotMet
			}
		case NodeAmountRouting:
			if f.next == 0 {
				f.next = 1
				upper, ok := amountAtLeast(v.message.Body, &n.Amount)
				if !ok {
					return ErrInvalidMessageBody
				}
				sub := n.Lower()
				if upper {
					sub = n.Upper()
				}
				frames = append(frames, vframe{node: sub, meta: f.meta, owner: f.owner})
				continue
			}
		case NodeRouting, NodeFallbackRouting:
			if f.next == 0 {
				f.next = 1
				pushed, code := v.startRouting(c, f, top)
				if code != svm.Success {
					return code
				}
				if pushed != nil {
					frames = append(frames, *pushed)
					continue
				}
			} else if f.mutated {
				if !solana.Writable(c, f.domainAcct) {
					return ErrDomainPdaNotWritable
				}
				if code := accountutils.Store(c, f.domainAcct, f.domain, false); code != svm.Success {
					return code
				}
			}
		default:
			if code := v.leaf(c, f, frames); code != svm.Success {
				return code
			}
		}
		frames = frames[:top]
		if top > 0 {
			frames[top-1].verified++
		}
	}
	return svm.Success
}

// startRouting runs the Routing/FallbackRouting arm up to the domain ISM. It
// returns the frame for the domain PDA's tree, or nil when the node is done
// (the FallbackRouting CPI succeeded).
func (v *verifyContext) startRouting(c solana.Context, f *vframe, index int) (*vframe, uint64) {
	acct, code := v.it.Next()
	if code != svm.Success {
		return nil, code
	}
	ok, code := isDomainPDA(c, &v.programID, v.message.Origin, acct)
	if code != svm.Success {
		return nil, code
	}
	if !ok {
		return nil, ErrInvalidDomainPda
	}
	// try_verify_domain_ism.
	ds, code := loadDomainStorage(c, &v.programID, v.message.Origin, acct)
	if code != svm.Success {
		return nil, code
	}
	if ds != nil && ds.Ism.Some {
		if containsKind(&ds.Ism.Value, NodeRateLimited) && !solana.Writable(c, acct) {
			return nil, ErrDomainPdaNotWritable
		}
		f.domainAcct = acct
		f.domain = ds
		return &vframe{node: &ds.Ism.Value, meta: f.meta, owner: index}, svm.Success
	}
	if f.node.Kind == NodeRouting {
		return nil, ErrNoRouteForDomain
	}
	return nil, v.fallbackVerify(c, f)
}

// fallbackVerify CPIs Verify on the fallback ISM with every remaining
// account, skipping the fallback VAM PDA sentinel when the fallback ISM does
// not own it.
func (v *verifyContext) fallbackVerify(c solana.Context, f *vframe) uint64 {
	fallback := &f.node.Key
	start := v.it.Position()
	end := solana.Count(c)
	// FallbackRouting is account-terminal: it takes every remaining account.
	for v.it.HasMore() {
		v.it.Next()
	}
	sentinel, _, code := svm.FindProgramAddress(c, ism.VerifyAccountMetasPDASeeds, *fallback)
	if code != svm.Success {
		return code
	}
	if start < end && svm.KeyIs(c, start, sentinel) && !svm.OwnerIs(c, start, *fallback) {
		start++
	}
	ix := ism.Instruction{Kind: ism.KindVerify, Metadata: f.meta, Message: v.encoded}
	return invokeRange(c, fallback, start, end, ix.Encode())
}

// leaf verifies a node without children.
func (v *verifyContext) leaf(c solana.Context, f *vframe, frames []vframe) uint64 {
	n := f.node
	switch n.Kind {
	case NodeTrustedRelayer:
		acct, code := v.it.Next()
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, acct, n.Key) {
			return ErrInvalidRelayer
		}
		if !solana.Signer(c, acct) {
			return ErrRelayerNotSigner
		}
	case NodeMultisigMessageID:
		return verifyMultisig(c, n, f.meta, v.message, v.encoded)
	case NodeTest:
		if !n.Accept {
			return ErrVerifyRejected
		}
	case NodePausable:
		if n.Paused {
			return ErrVerifyRejected
		}
	case NodeRateLimited:
		if n.Recipient.Some && v.message.Recipient != n.Recipient.Value {
			return ErrRecipientMismatch
		}
		authority, code := processAuthority(c, &n.Key, &v.programID)
		if code != svm.Success {
			return code
		}
		acct, code := v.it.Next()
		if code != svm.Success {
			return code
		}
		if !svm.KeyIs(c, acct, authority) {
			return ErrInvalidProcessAuthority
		}
		if !solana.Signer(c, acct) {
			return ErrProcessAuthorityNotSigner
		}
		amount, code := rateLimitedAmount(v.message.Body)
		if code != svm.Success {
			return code
		}
		now, code := clockNow(c)
		if code != svm.Success {
			return code
		}
		adjusted := currentLevel(n.FilledLevel, n.LastUpdated, now, n.MaxCapacity)
		if amount > adjusted {
			return ErrRateLimitExceeded
		}
		if amount == 0 {
			return svm.Success
		}
		n.FilledLevel = adjusted - amount
		n.LastUpdated = now
		if f.owner < 0 {
			v.rootMutated = true
		} else {
			frames[f.owner].mutated = true
		}
	}
	return svm.Success
}

// processAuthority is accounts::derive_process_authority.
func processAuthority(c solana.Context, mailbox, programID *svm.Pubkey) (svm.Pubkey, uint64) {
	key, _, code := svm.FindProgramAddress(c, [][]byte{ProcessAuthoritySeed, programID[:]}, *mailbox)
	return key, code
}

// clockNow is Clock::get()?.unix_timestamp.
func clockNow(c solana.Context) (int64, uint64) {
	var clock [40]byte
	if solana.Clock(c, clock[:]) != 0 {
		return 0, svm.UnsupportedSysvar
	}
	ts := uint64(0)
	for i := 7; i >= 0; i-- {
		ts = ts<<8 | uint64(clock[32+i])
	}
	return int64(ts), svm.Success
}
