// Package multisigism ports rust/sealevel/libraries/multisig-ism: the
// multisig ISM interface instructions, the message-ID metadata format, the
// CheckpointWithMessageId signing hash, and threshold signature verification.
package multisigism

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	ecdsa "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/ecdsa-signature"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Error is MultisigIsmError. Programs map it to their own codes.
type Error uint8

const (
	OK                  Error = 0
	ErrInvalidSignature Error = 1
	ErrThresholdNotMet  Error = 2
	ErrInvalidMetadata  Error = 3
)

// Interface instruction discriminators: the first 8 bytes of
// sha256("hyperlane-multisig-ism:validators-and-threshold[-account-metas]").
var (
	ValidatorsAndThresholdDiscriminator             = [8]byte{82, 96, 5, 220, 241, 173, 13, 50}
	ValidatorsAndThresholdAccountMetasDiscriminator = [8]byte{113, 7, 132, 85, 239, 247, 157, 204}
)

// ValidatorsAndThresholdAccountMetasPDASeeds are the seeds of the PDA passed
// to ValidatorsAndThresholdAccountMetas.
var ValidatorsAndThresholdAccountMetasPDASeeds = [][]byte{
	[]byte("hyperlane_multisig_ism"), []byte("-"), []byte("validators_and_threshold"), []byte("-"), []byte("account_metas"),
}

// DomainDataPDASeeds are domain_data_pda's seeds for a multisig ISM
// message-id program (domain as u32 LE).
func DomainDataPDASeeds(domain uint32) [][]byte {
	d := []byte{byte(domain), byte(domain >> 8), byte(domain >> 16), byte(domain >> 24)}
	return [][]byte{[]byte("multisig_ism_message_id"), []byte("-"), d, []byte("-"), []byte("domain_data")}
}

// InstructionKind is the MultisigIsmInstruction variant.
type InstructionKind uint8

const (
	KindValidatorsAndThreshold InstructionKind = iota
	KindValidatorsAndThresholdAccountMetas
)

// Instruction is MultisigIsmInstruction. Message is the raw remainder after
// the discriminator (no Borsh length prefix), as a view into the input.
type Instruction struct {
	Kind    InstructionKind
	Message []byte
}

// DecodeInstruction is MultisigIsmInstruction::decode: short input or an
// unknown discriminator is InvalidInstructionData.
func DecodeInstruction(buf []byte) (Instruction, uint64) {
	var ix Instruction
	if len(buf) < 8 {
		return ix, svm.InvalidInstructionData
	}
	switch {
	case prefixIs(buf, &ValidatorsAndThresholdDiscriminator):
		ix.Kind = KindValidatorsAndThreshold
	case prefixIs(buf, &ValidatorsAndThresholdAccountMetasDiscriminator):
		ix.Kind = KindValidatorsAndThresholdAccountMetas
	default:
		return ix, svm.InvalidInstructionData
	}
	ix.Message = buf[8:]
	return ix, svm.Success
}

func prefixIs(b []byte, d *[8]byte) bool {
	for i := 0; i < 8; i++ {
		if b[i] != d[i] {
			return false
		}
	}
	return true
}

// Encode is MultisigIsmInstruction::encode.
func (ix *Instruction) Encode() []byte {
	out := make([]byte, 8+len(ix.Message))
	if ix.Kind == KindValidatorsAndThreshold {
		copy(out, ValidatorsAndThresholdDiscriminator[:])
	} else {
		copy(out, ValidatorsAndThresholdAccountMetasDiscriminator[:])
	}
	copy(out[8:], ix.Message)
	return out
}

// ValidatorsAndThreshold is the Borsh {validators: Vec<H160>, threshold: u8}.
type ValidatorsAndThreshold struct {
	Validators [][20]byte
	Threshold  uint8
}

func (v *ValidatorsAndThreshold) EncodeBorsh(w *borsh.Writer) {
	borsh.WriteVec(w, v.Validators, borsh.WriteBytes20)
	w.U8(v.Threshold)
}

func (v *ValidatorsAndThreshold) DecodeBorsh(r *borsh.Reader) {
	v.Validators = borsh.ReadVec(r, borsh.ReadBytes20)
	v.Threshold = r.U8()
}

// Size is the Borsh length.
func (v *ValidatorsAndThreshold) Size() int { return 4 + 20*len(v.Validators) + 1 }

// Metadata offsets (EVM-compatible message-ID multisig metadata).
const (
	merkleRootOffset  = 32
	merkleIndexOffset = 64
	SignaturesOffset  = 68
)

// MessageIDMetadata is MultisigIsmMessageIdMetadata.
type MessageIDMetadata struct {
	OriginMerkleTreeHook [32]byte
	MerkleRoot           [32]byte
	MerkleIndex          uint32
	Signatures           []ecdsa.EcdsaSignature
}

// ParseMessageIDMetadata is TryFrom<Vec<u8>>: at least one signature, a
// whole number of 65-byte signatures, and every signature valid
// (EcdsaSignature::from_bytes, including low-S). Any failure is
// ErrInvalidMetadata.
func ParseMessageIDMetadata(b []byte) (MessageIDMetadata, Error) {
	var m MessageIDMetadata
	if len(b) < SignaturesOffset+ecdsa.SignatureLength {
		return m, ErrInvalidMetadata
	}
	rest := len(b) - SignaturesOffset
	if rest%ecdsa.SignatureLength != 0 {
		return m, ErrInvalidMetadata
	}
	copy(m.OriginMerkleTreeHook[:], b[:merkleRootOffset])
	copy(m.MerkleRoot[:], b[merkleRootOffset:merkleIndexOffset])
	m.MerkleIndex = uint32(b[64])<<24 | uint32(b[65])<<16 | uint32(b[66])<<8 | uint32(b[67])
	n := rest / ecdsa.SignatureLength
	m.Signatures = make([]ecdsa.EcdsaSignature, n)
	for i := 0; i < n; i++ {
		off := SignaturesOffset + i*ecdsa.SignatureLength
		if m.Signatures[i].Parse(b[off:off+ecdsa.SignatureLength]) != ecdsa.OK {
			return MessageIDMetadata{}, ErrInvalidMetadata
		}
	}
	return m, OK
}

// Encode is MultisigIsmMessageIdMetadata's Encode.
func (m *MessageIDMetadata) Encode() []byte {
	out := make([]byte, SignaturesOffset+ecdsa.SignatureLength*len(m.Signatures))
	copy(out, m.OriginMerkleTreeHook[:])
	copy(out[merkleRootOffset:], m.MerkleRoot[:])
	out[64] = byte(m.MerkleIndex >> 24)
	out[65] = byte(m.MerkleIndex >> 16)
	out[66] = byte(m.MerkleIndex >> 8)
	out[67] = byte(m.MerkleIndex)
	for i := range m.Signatures {
		b := m.Signatures[i].AsFixedBytes()
		copy(out[SignaturesOffset+i*ecdsa.SignatureLength:], b[:])
	}
	return out
}

// CheckpointSigningHash is CheckpointWithMessageId::signing_hash:
// keccak(domain_hash(hook, domain) || root || index (u32 BE) || message_id),
// with domain_hash = keccak(domain (u32 BE) || hook || "HYPERLANE").
func CheckpointSigningHash(c solana.Context, hook *[32]byte, domain uint32, root *[32]byte, index uint32, messageID *[32]byte) ([32]byte, uint64) {
	var out [32]byte
	var dh [4 + 32 + 9]byte
	putBE32(dh[:], domain)
	copy(dh[4:], hook[:])
	copy(dh[36:], "HYPERLANE")
	var buf [32 + 32 + 4 + 32]byte
	if code := solana.Keccak256(c, dh[:], 0, uint64(len(dh)), buf[:], 0); code != 0 {
		return out, code
	}
	copy(buf[32:], root[:])
	putBE32(buf[64:], index)
	copy(buf[68:], messageID[:])
	code := solana.Keccak256(c, buf[:], 0, uint64(len(buf)), out[:], 0)
	return out, code
}

func putBE32(b []byte, v uint32) {
	b[0] = byte(v >> 24)
	b[1] = byte(v >> 16)
	b[2] = byte(v >> 8)
	b[3] = byte(v)
}

// Verify is MultisigIsm::verify over signingHash (Signable::signing_hash):
// the first threshold signatures must recover to validators in order.
// Fewer signatures than the threshold is ErrThresholdNotMet before any
// hashing; a signature that does not recover is ErrInvalidSignature. A
// non-zero status is a Keccak256 syscall failure.
func Verify(c solana.Context, signingHash *[32]byte, signatures []ecdsa.EcdsaSignature, validators [][20]byte, threshold uint8) (Error, uint64) {
	if len(signatures) < int(threshold) {
		return ErrThresholdNotMet, 0
	}
	digest, code := ecdsa.EthSignedMessageHash(c, signingHash)
	if code != 0 {
		return OK, code
	}
	count := len(validators)
	v := 0
	for i := 0; i < int(threshold); i++ {
		signer, code := signatures[i].RecoverEthereumAddress(c, digest[:])
		if code != 0 {
			return ErrInvalidSignature, 0
		}
		for v < count && signer != validators[v] {
			v++
		}
		if v >= count {
			return ErrThresholdNotMet, 0
		}
		v++
	}
	return OK, 0
}
