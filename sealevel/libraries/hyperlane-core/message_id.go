package hyperlanecore

import "gosvm/solana"

// MessageID writes HyperlaneMessage::id, keccak256 of the packed message
// encoded[off:off+length], into id[0:32] with the runtime's Keccak syscall.
func MessageID(c solana.Context, encoded []byte, off, length uint64, id []byte) uint64 {
	return solana.Keccak256(c, encoded, off, length, id, 0)
}
