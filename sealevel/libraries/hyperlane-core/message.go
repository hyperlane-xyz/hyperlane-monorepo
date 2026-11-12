package hyperlanecore

// MessagePrefixLen is the fixed header length before the body.
const MessagePrefixLen = 77

// HyperlaneMessage is the packed big-endian Hyperlane message.
type HyperlaneMessage struct {
	Version     uint8
	Nonce       uint32
	Origin      uint32
	Sender      H256
	Destination uint32
	Recipient   H256
	Body        []byte
}

func putBE32(b []byte, v uint32) {
	b[0] = byte(v >> 24)
	b[1] = byte(v >> 16)
	b[2] = byte(v >> 8)
	b[3] = byte(v)
}

func be32(b []byte) uint32 {
	return uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
}

// Encode returns the packed message (Encode::to_vec).
func (m *HyperlaneMessage) Encode() []byte {
	out := make([]byte, MessagePrefixLen+len(m.Body))
	m.EncodeInto(out)
	return out
}

// EncodeInto writes the packed message into out, which must be at least
// MessagePrefixLen+len(Body) bytes.
func (m *HyperlaneMessage) EncodeInto(out []byte) {
	out[0] = m.Version
	putBE32(out[1:5], m.Nonce)
	putBE32(out[5:9], m.Origin)
	copy(out[9:41], m.Sender[:])
	putBE32(out[41:45], m.Destination)
	copy(out[45:77], m.Recipient[:])
	copy(out[77:], m.Body)
}

// DecodeMessage parses a packed message. Fewer than 77 bytes fails, as Rust's
// read_exact does. Body is a view into b.
func DecodeMessage(b []byte) (HyperlaneMessage, bool) {
	var m HyperlaneMessage
	if len(b) < MessagePrefixLen {
		return m, false
	}
	m.Version = b[0]
	m.Nonce = be32(b[1:5])
	m.Origin = be32(b[5:9])
	copy(m.Sender[:], b[9:41])
	m.Destination = be32(b[41:45])
	copy(m.Recipient[:], b[45:77])
	m.Body = b[77:]
	return m, true
}
