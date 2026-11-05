// Package ecdsasignature ports rust/sealevel/libraries/ecdsa-signature: a
// 65-byte secp256k1 signature (r || s || v) and recovery of the Ethereum
// address that signed a hash, plus hyperlane-core's EIP-191
// eth_signed_message_hash.
package ecdsasignature

import "gosvm/solana"

// Error is EcdsaSignatureError. Callers map it to their own program error
// (quote-verifier: InvalidSignature, multisig metadata: InvalidMetadata, ...).
type Error uint8

const (
	OK                   Error = 0
	ErrInvalidLength     Error = 1
	ErrInvalidRecoveryID Error = 2
	ErrHighS             Error = 3
)

// SignatureLength is the serialized r || s || v length.
const SignatureLength = 65

// secp256k1HalfOrder is n/2, big-endian. s must be <= n/2 (low-S).
var secp256k1HalfOrder = [32]byte{
	0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
	0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0,
}

// EcdsaSignature is a 64-byte r || s with a recovery ID of 0 or 1.
type EcdsaSignature struct {
	SerializedRS [64]byte
	RecoveryID   uint8
}

// FromBytes is EcdsaSignature::from_bytes: exactly 65 bytes, v in
// {0, 1, 27, 28} (27/28 normalized to 0/1), and s <= n/2.
func FromBytes(b []byte) (EcdsaSignature, Error) {
	var s EcdsaSignature
	if code := s.Parse(b); code != OK {
		return EcdsaSignature{}, code
	}
	return s, OK
}

// Parse is FromBytes into s. On error s is left partially written.
func (s *EcdsaSignature) Parse(b []byte) Error {
	if len(b) != SignatureLength {
		return ErrInvalidLength
	}
	copy(s.SerializedRS[:], b[:64])
	v := b[64]
	if v == 27 || v == 28 {
		v -= 27
	}
	if v > 1 {
		return ErrInvalidRecoveryID
	}
	// Lexicographic big-endian compare, like Rust's slice `>`.
	for i := 0; i < 32; i++ {
		x := b[32+i]
		h := secp256k1HalfOrder[i]
		if x < h {
			break
		}
		if x > h {
			return ErrHighS
		}
	}
	s.RecoveryID = v
	return OK
}

// AsFixedBytes is EcdsaSignature::as_fixed_bytes.
func (s *EcdsaSignature) AsFixedBytes() [65]byte {
	var b [65]byte
	copy(b[:64], s.SerializedRS[:])
	b[64] = s.RecoveryID
	return b
}

// RecoverEthereumAddress is secp256k1_recover_ethereum_address: the address
// keccak256(pubkey)[12:] of the key that signed hash. A non-zero status is
// the Secp256k1Recover failure (Rust's Secp256k1RecoverError), which every
// caller maps to its own error.
func (s *EcdsaSignature) RecoverEthereumAddress(c solana.Context, hash []byte) ([20]byte, uint64) {
	var address [20]byte
	var key [64]byte
	if code := solana.Secp256k1Recover(c, hash, uint64(s.RecoveryID), s.SerializedRS[:], key[:]); code != 0 {
		return address, code
	}
	var h [32]byte
	if code := solana.Keccak256(c, key[:], 0, 64, h[:], 0); code != 0 {
		return address, code
	}
	copy(address[:], h[12:])
	return address, 0
}

// ethSignedPrefix is EIP-191's prefix for a 32-byte message.
const ethSignedPrefix = "\x19Ethereum Signed Message:\n32"

// EthSignedMessageHash is Signable::eth_signed_message_hash for a signing
// hash: keccak256("\x19Ethereum Signed Message:\n32" || hash).
func EthSignedMessageHash(c solana.Context, hash *[32]byte) ([32]byte, uint64) {
	var buf [len(ethSignedPrefix) + 32]byte
	copy(buf[:], ethSignedPrefix)
	copy(buf[len(ethSignedPrefix):], hash[:])
	var out [32]byte
	code := solana.Keccak256(c, buf[:], 0, uint64(len(buf)), out[:], 0)
	return out, code
}
