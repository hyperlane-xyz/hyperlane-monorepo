package hyperlanecore

// TokenMessage is hyperlane-warp-route's TokenMessage: recipient, 32-byte
// big-endian amount or ID, then metadata to the end.
type TokenMessage struct {
	Recipient  H256
	AmountOrID U256
	Metadata   []byte
}

// Encode returns the packed token message.
func (t *TokenMessage) Encode() []byte {
	out := make([]byte, 64+len(t.Metadata))
	copy(out[0:32], t.Recipient[:])
	amount := U256ToBigEndian(t.AmountOrID)
	copy(out[32:64], amount[:])
	copy(out[64:], t.Metadata)
	return out
}

// DecodeTokenMessage parses a token message; fewer than 64 bytes fails.
// Metadata is a view into b.
func DecodeTokenMessage(b []byte) (TokenMessage, bool) {
	var t TokenMessage
	if len(b) < 64 {
		return t, false
	}
	copy(t.Recipient[:], b[0:32])
	t.AmountOrID = U256FromBigEndian(b[32:64])
	t.Metadata = b[64:]
	return t, true
}
