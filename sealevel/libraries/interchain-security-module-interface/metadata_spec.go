package ism

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
)

// MetadataSpecKind is the MetadataSpec variant index.
type MetadataSpecKind uint8

const (
	SpecNull MetadataSpecKind = iota
	SpecMultisigMessageID
	SpecAggregation
	SpecTrustedRelayer
	SpecCannotVerify
)

// MetadataSpec is the metadata format an ISM requires. Fields are used by
// variant: MultisigMessageID {Validators, Threshold}, Aggregation {Threshold,
// SubSpecs}, TrustedRelayer {Relayer}.
type MetadataSpec struct {
	Kind       MetadataSpecKind
	Validators [][20]byte
	Threshold  uint8
	SubSpecs   []MetadataSpec
	Relayer    [32]byte
}

// MetadataSpecResult is VerifyMetadataSpec's result, returned as
// SimulationReturnData<MetadataSpecResult>.
type MetadataSpecResult struct {
	Spec     borsh.Option[MetadataSpec]
	Accounts [][32]byte
}

func writeSpecHead(w *borsh.Writer, s *MetadataSpec) {
	w.EnumTag(uint8(s.Kind))
	switch s.Kind {
	case SpecMultisigMessageID:
		borsh.WriteVec(w, s.Validators, borsh.WriteBytes20)
		w.U8(s.Threshold)
	case SpecAggregation:
		w.U8(s.Threshold)
		w.Len32(len(s.SubSpecs))
	case SpecTrustedRelayer:
		w.Bytes32(s.Relayer)
	}
}

// EncodeBorsh writes the spec tree in Borsh preorder with an explicit stack
// (goSVM rejects recursion).
func (s *MetadataSpec) EncodeBorsh(w *borsh.Writer) {
	if s.Kind != SpecAggregation || len(s.SubSpecs) == 0 {
		writeSpecHead(w, s)
		return
	}
	stack := []*MetadataSpec{s}
	for len(stack) > 0 {
		top := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		writeSpecHead(w, top)
		if top.Kind == SpecAggregation {
			for i := len(top.SubSpecs) - 1; i >= 0; i-- {
				stack = append(stack, &top.SubSpecs[i])
			}
		}
	}
}

type specNode struct {
	spec     MetadataSpec
	parent   int
	children int
}

type specFrame struct {
	node      int
	remaining int
}

// DecodeBorsh reads a spec tree without recursion: nodes are read in
// preorder with their parent, then assembled from the last node back.
func (s *MetadataSpec) DecodeBorsh(r *borsh.Reader) {
	nodes := []specNode{}
	frames := []specFrame{}
	for r.Ok() {
		parent := -1
		if len(frames) > 0 {
			parent = frames[len(frames)-1].node
			frames[len(frames)-1].remaining--
		}
		var n specNode
		n.parent = parent
		n.spec.Kind = MetadataSpecKind(r.EnumTag())
		switch n.spec.Kind {
		case SpecNull, SpecCannotVerify:
		case SpecMultisigMessageID:
			n.spec.Validators = borsh.ReadVec(r, borsh.ReadBytes20)
			n.spec.Threshold = r.U8()
		case SpecAggregation:
			n.spec.Threshold = r.U8()
			n.children = r.Len32()
			if n.children > r.Remaining() {
				r.Fail()
			}
		case SpecTrustedRelayer:
			n.spec.Relayer = r.Bytes32()
		default:
			r.Fail()
		}
		if !r.Ok() {
			break
		}
		nodes = append(nodes, n)
		if n.children > 0 {
			frames = append(frames, specFrame{node: len(nodes) - 1, remaining: n.children})
		} else if n.spec.Kind == SpecAggregation {
			nodes[len(nodes)-1].spec.SubSpecs = []MetadataSpec{}
		}
		for len(frames) > 0 && frames[len(frames)-1].remaining == 0 {
			frames = frames[:len(frames)-1]
		}
		if len(frames) == 0 {
			break
		}
	}
	if !r.Ok() || len(nodes) == 0 {
		*s = MetadataSpec{}
		return
	}
	fill := make([]int, len(nodes))
	for i := range nodes {
		if nodes[i].children > 0 {
			nodes[i].spec.SubSpecs = make([]MetadataSpec, nodes[i].children)
			fill[i] = nodes[i].children
		}
	}
	for i := len(nodes) - 1; i > 0; i-- {
		p := nodes[i].parent
		fill[p]--
		nodes[p].spec.SubSpecs[fill[p]] = nodes[i].spec
	}
	*s = nodes[0].spec
}

func (m *MetadataSpecResult) EncodeBorsh(w *borsh.Writer) {
	w.OptionTag(m.Spec.Some)
	if m.Spec.Some {
		m.Spec.Value.EncodeBorsh(w)
	}
	borsh.WriteVec(w, m.Accounts, borsh.WriteBytes32)
}

func (m *MetadataSpecResult) DecodeBorsh(r *borsh.Reader) {
	m.Spec.Some = r.OptionTag()
	if m.Spec.Some {
		m.Spec.Value.DecodeBorsh(r)
	}
	m.Accounts = borsh.ReadVec(r, borsh.ReadBytes32)
}

// EncodeMetadataSpecReturnData is borsh(SimulationReturnData::new(result)).
func EncodeMetadataSpecReturnData(result *MetadataSpecResult) []byte {
	w := borsh.NewWriter(16)
	result.EncodeBorsh(&w)
	w.U8(0xff)
	return w.Bytes()
}
