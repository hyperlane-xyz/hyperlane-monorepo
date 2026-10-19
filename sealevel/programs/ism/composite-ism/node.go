package compositeism

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
)

// IsmNode variants (Borsh enum indices of accounts::IsmNode).
const (
	NodeTrustedRelayer uint8 = iota
	NodeMultisigMessageID
	NodeAggregation
	NodeTest
	NodePausable
	NodeAmountRouting
	NodeRateLimited
	NodeRouting
	NodeFallbackRouting
	nodeKinds
)

// kindToStr is IsmNode::kind_to_str.
func kindToStr(kind uint8) string {
	switch kind {
	case NodeTrustedRelayer:
		return "TrustedRelayer"
	case NodeMultisigMessageID:
		return "MultisigMessageId"
	case NodeAggregation:
		return "Aggregation"
	case NodeTest:
		return "Test"
	case NodePausable:
		return "Pausable"
	case NodeAmountRouting:
		return "AmountRouting"
	case NodeRateLimited:
		return "RateLimited"
	case NodeRouting:
		return "Routing"
	}
	return "FallbackRouting"
}

// IsmNode is accounts::IsmNode, one node of the ISM config tree. Fields are
// used by variant:
//
//   - TrustedRelayer {relayer: Key}
//   - MultisigMessageId {Validators, Threshold}
//   - Aggregation {Threshold, sub_isms: Subs}
//   - Test {Accept}
//   - Pausable {Paused}
//   - AmountRouting {threshold: Amount, lower: Subs[0], upper: Subs[1]}
//   - RateLimited {MaxCapacity, Recipient, FilledLevel, LastUpdated, mailbox: Key}
//   - Routing
//   - FallbackRouting {fallback_ism: Key}
//
// Children always live in Subs, so every tree walk is a loop over Subs with
// an explicit stack (goSVM rejects recursion).
type IsmNode struct {
	Kind        uint8
	Threshold   uint8
	Accept      bool
	Paused      bool
	Key         [32]byte
	Validators  [][20]byte
	Subs        []IsmNode
	Amount      borsh.U256
	MaxCapacity uint64
	Recipient   borsh.Option[[32]byte]
	FilledLevel uint64
	LastUpdated int64
}

// Lower is AmountRouting's lower branch.
func (n *IsmNode) Lower() *IsmNode { return &n.Subs[0] }

// Upper is AmountRouting's upper branch.
func (n *IsmNode) Upper() *IsmNode { return &n.Subs[1] }

// writeHead writes the node's variant and own fields; children follow in
// preorder.
func writeHead(w *borsh.Writer, n *IsmNode) {
	w.EnumTag(n.Kind)
	switch n.Kind {
	case NodeTrustedRelayer, NodeFallbackRouting:
		w.Bytes32(n.Key)
	case NodeMultisigMessageID:
		borsh.WriteVec(w, n.Validators, borsh.WriteBytes20)
		w.U8(n.Threshold)
	case NodeAggregation:
		w.U8(n.Threshold)
		w.Len32(len(n.Subs))
	case NodeTest:
		w.Bool(n.Accept)
	case NodePausable:
		w.Bool(n.Paused)
	case NodeAmountRouting:
		w.U256(n.Amount)
	case NodeRateLimited:
		w.U64(n.MaxCapacity)
		w.OptionTag(n.Recipient.Some)
		if n.Recipient.Some {
			w.Bytes32(n.Recipient.Value)
		}
		w.U64(n.FilledLevel)
		w.I64(n.LastUpdated)
		w.Bytes32(n.Key)
	}
}

// headSize is writeHead's length.
func headSize(n *IsmNode) int {
	switch n.Kind {
	case NodeTrustedRelayer, NodeFallbackRouting:
		return 33
	case NodeMultisigMessageID:
		return 1 + 4 + 20*len(n.Validators) + 1
	case NodeAggregation:
		return 6
	case NodeTest, NodePausable:
		return 2
	case NodeAmountRouting:
		return 33
	case NodeRateLimited:
		if n.Recipient.Some {
			return 1 + 8 + 33 + 8 + 8 + 32
		}
		return 1 + 8 + 1 + 8 + 8 + 32
	}
	return 1
}

// EncodeBorsh writes the tree in Borsh preorder.
func (n *IsmNode) EncodeBorsh(w *borsh.Writer) {
	walk := NewWalker(n)
	for node := walk.Next(); node != nil; node = walk.Next() {
		writeHead(w, node)
	}
}

// Size is the tree's Borsh length.
func (n *IsmNode) Size() int {
	size := 0
	walk := NewWalker(n)
	for node := walk.Next(); node != nil; node = walk.Next() {
		size += headSize(node)
	}
	return size
}

// skipHead reads one node head without storing it and returns its child
// count (or -1 on failure). It applies the same checks as readHead.
func skipHead(r *borsh.Reader) int {
	kind := r.EnumTag()
	switch kind {
	case NodeTrustedRelayer, NodeFallbackRouting:
		r.Fixed(32)
	case NodeMultisigMessageID:
		n := r.Len32()
		if r.Ok() && n > r.Remaining()/20 {
			r.Fail()
		}
		r.Fixed(20 * n)
		r.U8()
	case NodeAggregation:
		r.U8()
		n := r.Len32()
		// Every sub-ISM is at least one byte.
		if r.Ok() && n > r.Remaining() {
			r.Fail()
		}
		if r.Ok() {
			return n
		}
	case NodeTest, NodePausable:
		r.Bool()
	case NodeAmountRouting:
		r.Fixed(32)
		if r.Ok() {
			return 2
		}
	case NodeRateLimited:
		r.Fixed(8)
		if r.OptionTag() {
			r.Fixed(32)
		}
		r.Fixed(8 + 8 + 32)
	case NodeRouting:
	default:
		r.Fail()
	}
	if !r.Ok() {
		return -1
	}
	return 0
}

// readHead reads one node head into n. Children are left for the caller.
func readHead(r *borsh.Reader, n *IsmNode) int {
	n.Kind = r.EnumTag()
	switch n.Kind {
	case NodeTrustedRelayer, NodeFallbackRouting:
		n.Key = r.Bytes32()
	case NodeMultisigMessageID:
		n.Validators = borsh.ReadVec(r, borsh.ReadBytes20)
		n.Threshold = r.U8()
	case NodeAggregation:
		n.Threshold = r.U8()
		return r.Len32()
	case NodeTest:
		n.Accept = r.Bool()
	case NodePausable:
		n.Paused = r.Bool()
	case NodeAmountRouting:
		n.Amount = r.U256()
		return 2
	case NodeRateLimited:
		n.MaxCapacity = r.U64()
		if r.OptionTag() {
			n.Recipient = borsh.SomeOf(r.Bytes32())
		}
		n.FilledLevel = r.U64()
		n.LastUpdated = r.I64()
		n.Key = r.Bytes32()
	}
	return 0
}

// DecodeBorsh reads a tree in two passes. The first validates the whole
// encoding and counts the nodes with no allocation, so hostile lengths fail
// like Rust's decoder instead of exhausting the heap. The second allocates
// every non-root node in one exact arena; each parent's children are a
// contiguous block of it, carved when the parent's head is read.
func (n *IsmNode) DecodeBorsh(r *borsh.Reader) {
	scan := *r
	pending, total := 1, 0
	for pending > 0 {
		children := skipHead(&scan)
		if children < 0 {
			r.Fail()
			*n = IsmNode{}
			return
		}
		pending += children - 1
		total++
	}
	arena := make([]IsmNode, total-1)
	used := 0
	walk := walker{stack: make([]cursor, 0, 8)}
	cur := n
	for cur != nil {
		*cur = IsmNode{}
		children := readHead(r, cur)
		if children > 0 {
			cur.Subs = arena[used : used+children : used+children]
			used += children
		} else if cur.Kind == NodeAggregation {
			cur.Subs = []IsmNode{}
		}
		walk.push(cur)
		cur = walk.advance()
	}
	if !r.Ok() {
		*n = IsmNode{}
	}
}

type cursor struct {
	node *IsmNode
	next int
}

// Walker visits a tree in preorder (Borsh order) with an explicit stack whose
// size is the tree's depth.
type Walker struct {
	w     walker
	root  *IsmNode
	start bool
}

type walker struct {
	stack []cursor
}

// NewWalker starts a preorder walk at root.
func NewWalker(root *IsmNode) Walker {
	return Walker{w: walker{stack: make([]cursor, 0, 8)}, root: root}
}

// Next returns the next node in preorder, or nil when done.
func (w *Walker) Next() *IsmNode {
	if !w.start {
		w.start = true
		w.w.push(w.root)
		return w.root
	}
	next := w.w.advance()
	if next != nil {
		w.w.push(next)
	}
	return next
}

func (w *walker) push(n *IsmNode) {
	if len(n.Subs) > 0 {
		w.stack = append(w.stack, cursor{node: n})
	}
}

// advance returns the next unvisited child of the deepest open node.
func (w *walker) advance() *IsmNode {
	for len(w.stack) > 0 {
		top := &w.stack[len(w.stack)-1]
		if top.next < len(top.node.Subs) {
			child := &top.node.Subs[top.next]
			top.next++
			return child
		}
		w.stack = w.stack[:len(w.stack)-1]
	}
	return nil
}

// containsKind reports whether any node of the tree has the given variant.
func containsKind(root *IsmNode, kind uint8) bool {
	walk := NewWalker(root)
	for node := walk.Next(); node != nil; node = walk.Next() {
		if node.Kind == kind {
			return true
		}
	}
	return false
}

// normalize resets RateLimited state to (max_capacity, 0) (normalize_node).
func normalize(root *IsmNode) {
	walk := NewWalker(root)
	for node := walk.Next(); node != nil; node = walk.Next() {
		if node.Kind == NodeRateLimited {
			node.FilledLevel = node.MaxCapacity
			node.LastUpdated = 0
		}
	}
}

// flipPausable sets every Pausable node to paused (flip_pausable).
func flipPausable(root *IsmNode, paused bool) {
	walk := NewWalker(root)
	for node := walk.Next(); node != nil; node = walk.Next() {
		if node.Kind == NodePausable {
			node.Paused = paused
		}
	}
}
