// Package connectionclient ports
// rust/sealevel/libraries/hyperlane-sealevel-connection-client: the router
// and gas-router configs, their sorted maps, the IGP config type, the mailbox
// process authority check, and the mailbox OutboxDispatch / IGP PayForGas
// instruction encodings a router dispatches with.
package connectionclient

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// RemoteRouterConfig is router::RemoteRouterConfig. A None router unenrolls.
type RemoteRouterConfig struct {
	Domain uint32
	Router borsh.Option[hyperlanecore.H256]
}

func (r *RemoteRouterConfig) EncodeBorsh(w *borsh.Writer) {
	w.U32(r.Domain)
	w.OptionTag(r.Router.Some)
	if r.Router.Some {
		w.Bytes32(r.Router.Value)
	}
}

func (r *RemoteRouterConfig) DecodeBorsh(rd *borsh.Reader) {
	r.Domain = rd.U32()
	r.Router = borsh.ReadOption(rd, borsh.ReadBytes32)
}

// ReadRemoteRouterConfig is a ReadVec element decoder.
func ReadRemoteRouterConfig(r *borsh.Reader) RemoteRouterConfig {
	var v RemoteRouterConfig
	v.DecodeBorsh(r)
	return v
}

// WriteRemoteRouterConfig is a WriteVec element encoder.
func WriteRemoteRouterConfig(w *borsh.Writer, v RemoteRouterConfig) { v.EncodeBorsh(w) }

// GasRouterConfig is gas_router::GasRouterConfig. A None gas removes it.
type GasRouterConfig struct {
	Domain uint32
	Gas    borsh.Option[uint64]
}

func (g *GasRouterConfig) EncodeBorsh(w *borsh.Writer) {
	w.U32(g.Domain)
	w.OptionTag(g.Gas.Some)
	if g.Gas.Some {
		w.U64(g.Gas.Value)
	}
}

func (g *GasRouterConfig) DecodeBorsh(r *borsh.Reader) {
	g.Domain = r.U32()
	g.Gas = borsh.ReadOption(r, borsh.ReadU64)
}

// ReadGasRouterConfig is a ReadVec element decoder.
func ReadGasRouterConfig(r *borsh.Reader) GasRouterConfig {
	var v GasRouterConfig
	v.DecodeBorsh(r)
	return v
}

// WriteGasRouterConfig is a WriteVec element encoder.
func WriteGasRouterConfig(w *borsh.Writer, v GasRouterConfig) { v.EncodeBorsh(w) }

// InterchainGasPaymasterType variants (hyperlane-sealevel-igp accounts).
const (
	IGPTypeIgp         uint8 = 0
	IGPTypeOverheadIgp uint8 = 1
)

// InterchainGasPaymasterType is igp::accounts::InterchainGasPaymasterType:
// Igp(Pubkey) or OverheadIgp(Pubkey).
type InterchainGasPaymasterType struct {
	Kind uint8
	Key  svm.Pubkey
}

func (t *InterchainGasPaymasterType) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(t.Kind)
	w.Bytes32(t.Key)
}

func (t *InterchainGasPaymasterType) DecodeBorsh(r *borsh.Reader) {
	t.Kind = r.EnumTag()
	if t.Kind > IGPTypeOverheadIgp {
		r.Fail()
	}
	t.Key = r.Bytes32()
}

// IGPConfig is the (IGP program, IGP account) tuple of
// Option<(Pubkey, InterchainGasPaymasterType)>.
type IGPConfig struct {
	Program svm.Pubkey
	Type    InterchainGasPaymasterType
}

func (g *IGPConfig) EncodeBorsh(w *borsh.Writer) {
	w.Bytes32(g.Program)
	g.Type.EncodeBorsh(w)
}

func (g *IGPConfig) DecodeBorsh(r *borsh.Reader) {
	g.Program = r.Bytes32()
	g.Type.DecodeBorsh(r)
}

// WriteOptionalIGP writes Option<(Pubkey, InterchainGasPaymasterType)>.
func WriteOptionalIGP(w *borsh.Writer, o *borsh.Option[IGPConfig]) {
	w.OptionTag(o.Some)
	if o.Some {
		o.Value.EncodeBorsh(w)
	}
}

// ReadOptionalIGP reads Option<(Pubkey, InterchainGasPaymasterType)>.
func ReadOptionalIGP(r *borsh.Reader) borsh.Option[IGPConfig] {
	var o borsh.Option[IGPConfig]
	if r.OptionTag() {
		o.Value.DecodeBorsh(r)
		o.Some = r.Ok()
	}
	return o
}

// WriteOptionalPubkey writes Option<Pubkey>.
func WriteOptionalPubkey(w *borsh.Writer, o borsh.Option[svm.Pubkey]) {
	w.OptionTag(o.Some)
	if o.Some {
		w.Bytes32(o.Value)
	}
}

// ReadOptionalPubkey reads Option<Pubkey>.
func ReadOptionalPubkey(r *borsh.Reader) borsh.Option[svm.Pubkey] {
	return borsh.ReadOption(r, borsh.ReadBytes32)
}

// Routers is HashMap<u32, H256> as key-sorted pairs.
type Routers = []borsh.Pair[uint32, hyperlanecore.H256]

// DestinationGas is HashMap<u32, u64> as key-sorted pairs.
type DestinationGas = []borsh.Pair[uint32, uint64]

// Router is HyperlaneRouter::router.
func Router(routers Routers, domain uint32) (hyperlanecore.H256, bool) {
	for i := range routers {
		if routers[i].Key == domain {
			return routers[i].Value, true
		}
	}
	return hyperlanecore.H256{}, false
}

// IsRemoteRouter is HyperlaneRouter::is_remote_router.
func IsRemoteRouter(routers Routers, domain uint32, maybeRouter *hyperlanecore.H256) bool {
	for i := range routers {
		if routers[i].Key == domain {
			r := &routers[i].Value
			for j := 0; j < 32; j++ {
				if r[j] != maybeRouter[j] {
					return false
				}
			}
			return true
		}
	}
	return false
}

// OnlyRemoteRouter is HyperlaneRouter::only_remote_router.
func OnlyRemoteRouter(routers Routers, domain uint32, maybeRouter *hyperlanecore.H256) uint64 {
	if !IsRemoteRouter(routers, domain, maybeRouter) {
		return svm.InvalidInstructionData
	}
	return svm.Success
}

// EnrollRemoteRouter inserts or removes one router, keeping the pairs sorted.
//
// Rust also logs "Set domain {} remote router to {:?}"; add that once goSVM
// has sol_log.
func EnrollRemoteRouter(routers Routers, config *RemoteRouterConfig) Routers {
	return setPair(routers, config.Domain, config.Router.Some, config.Router.Value)
}

// EnrollRemoteRouters applies configs in order.
func EnrollRemoteRouters(routers Routers, configs []RemoteRouterConfig) Routers {
	for i := range configs {
		routers = EnrollRemoteRouter(routers, &configs[i])
	}
	return routers
}

// DestinationGasFor is HyperlaneGasRouter::destination_gas.
func DestinationGasFor(gas DestinationGas, domain uint32) (uint64, bool) {
	for i := range gas {
		if gas[i].Key == domain {
			return gas[i].Value, true
		}
	}
	return 0, false
}

// SetDestinationGas inserts or removes one gas amount, keeping pairs sorted.
//
// Rust also logs "Set destination {} gas to: {:?}".
func SetDestinationGas(gas DestinationGas, config *GasRouterConfig) DestinationGas {
	return setPair(gas, config.Domain, config.Gas.Some, config.Gas.Value)
}

// SetDestinationGasConfigs applies configs in order.
func SetDestinationGasConfigs(gas DestinationGas, configs []GasRouterConfig) DestinationGas {
	for i := range configs {
		gas = SetDestinationGas(gas, &configs[i])
	}
	return gas
}

func setPair[V any](pairs []borsh.Pair[uint32, V], key uint32, present bool, value V) []borsh.Pair[uint32, V] {
	i := 0
	for i < len(pairs) && pairs[i].Key < key {
		i++
	}
	found := i < len(pairs) && pairs[i].Key == key
	if !present {
		if !found {
			return pairs
		}
		copy(pairs[i:], pairs[i+1:])
		return pairs[:len(pairs)-1]
	}
	if found {
		pairs[i].Value = value
		return pairs
	}
	var zero borsh.Pair[uint32, V]
	pairs = append(pairs, zero)
	copy(pairs[i+1:], pairs[i:len(pairs)-1])
	pairs[i] = borsh.Pair[uint32, V]{Key: key, Value: value}
	return pairs
}

// WriteRouters writes HashMap<u32, H256> (sorted, like borsh).
func WriteRouters(w *borsh.Writer, routers Routers) {
	borsh.WriteMap(w, routers, borsh.WriteU32, borsh.WriteBytes32)
}

// ReadRouters reads HashMap<u32, H256>.
func ReadRouters(r *borsh.Reader) Routers {
	return borsh.ReadMap(r, borsh.ReadU32, borsh.ReadBytes32, borsh.LessU32)
}

// WriteDestinationGas writes HashMap<u32, u64>.
func WriteDestinationGas(w *borsh.Writer, gas DestinationGas) {
	borsh.WriteMap(w, gas, borsh.WriteU32, borsh.WriteU64)
}

// ReadDestinationGas reads HashMap<u32, u64>.
func ReadDestinationGas(r *borsh.Reader) DestinationGas {
	return borsh.ReadMap(r, borsh.ReadU32, borsh.ReadU64, borsh.LessU32)
}

// EnsureMailboxProcessAuthoritySigner is
// HyperlaneConnectionClientRecipient::ensure_mailbox_process_authority_signer:
// key first (InvalidArgument), then signer (MissingRequiredSignature).
func EnsureMailboxProcessAuthoritySigner(c solana.Context, authority *svm.Pubkey, i uint64) uint64 {
	key := solana.Key(c, i)
	for j := 0; j < 32; j++ {
		if key[j] != authority[j] {
			return svm.InvalidArgument
		}
	}
	if !solana.Signer(c, i) {
		return svm.MissingRequiredSignature
	}
	return svm.Success
}

// EnsureValidRouterMessage is
// HyperlaneRouterMessageRecipient::ensure_valid_router_message.
func EnsureValidRouterMessage(c solana.Context, authority *svm.Pubkey, i uint64, routers Routers, origin uint32, sender *hyperlanecore.H256) uint64 {
	if code := EnsureMailboxProcessAuthoritySigner(c, authority, i); code != svm.Success {
		return code
	}
	return OnlyRemoteRouter(routers, origin, sender)
}

// ISMReturnData is set_interchain_security_module_return_data's payload:
// borsh(Option<Pubkey>), with no simulation trailer.
func ISMReturnData(ism borsh.Option[svm.Pubkey]) []byte {
	w := borsh.NewWriter(33)
	WriteOptionalPubkey(&w, ism)
	return w.Bytes()
}

// Mailbox and IGP instruction enum indices used by routers.
const (
	mailboxOutboxDispatch uint8 = 4
	igpPayForGas          uint8 = 3
)

// OutboxDispatchData is mailbox Instruction::OutboxDispatch(..).into_instruction_data().
func OutboxDispatchData(sender svm.Pubkey, destination uint32, recipient hyperlanecore.H256, body []byte) []byte {
	w := borsh.NewWriter(1 + 32 + 4 + 32 + 4 + len(body))
	w.EnumTag(mailboxOutboxDispatch)
	w.Bytes32(sender)
	w.U32(destination)
	w.Bytes32(recipient)
	w.ByteVec(body)
	return w.Bytes()
}

// PayForGasData is borsh(igp Instruction::PayForGas(..)).
func PayForGasData(messageID hyperlanecore.H256, destination uint32, gasAmount uint64) []byte {
	w := borsh.NewWriter(1 + 32 + 4 + 8)
	w.EnumTag(igpPayForGas)
	w.Bytes32(messageID)
	w.U32(destination)
	w.U64(gasAmount)
	return w.Bytes()
}
