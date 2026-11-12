package accountutils

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

// DiscriminatorLength is spl-discriminator's ArrayDiscriminator::LENGTH.
const DiscriminatorLength = 8

// Discriminator is an 8-byte type or instruction discriminator.
type Discriminator = [DiscriminatorLength]byte

// ProgramInstructionDiscriminator prefixes program-specific instructions.
var ProgramInstructionDiscriminator = Discriminator{1, 1, 1, 1, 1, 1, 1, 1}

// WriteDiscriminator writes DiscriminatorPrefixed<T>'s prefix.
func WriteDiscriminator(w *borsh.Writer, d Discriminator) { w.Raw(d[:]) }

// ReadDiscriminator reads DiscriminatorPrefixed<T>'s prefix; a mismatch fails
// the reader (InvalidData in Rust, BorshIoError through AccountData).
func ReadDiscriminator(r *borsh.Reader, d Discriminator) {
	b := r.Fixed(DiscriminatorLength)
	if b == nil {
		return
	}
	for i := 0; i < DiscriminatorLength; i++ {
		if b[i] != d[i] {
			r.Fail()
			return
		}
	}
}

// ReadOptionalDiscriminated is OptionalDiscriminatedData<T>'s decoder: present
// only when the remaining bytes start with d. A short or non-matching tail is
// absent (and consumed); a matching prefix with a bad payload fails.
func ReadOptionalDiscriminated[T any, P Decoder[T]](r *borsh.Reader, d Discriminator) borsh.Option[T] {
	var o borsh.Option[T]
	if !r.Ok() {
		return o
	}
	if r.Remaining() < DiscriminatorLength {
		r.Fixed(r.Remaining())
		return o
	}
	b := r.Fixed(DiscriminatorLength)
	for i := 0; i < DiscriminatorLength; i++ {
		if b[i] != d[i] {
			return o
		}
	}
	P(&o.Value).DecodeBorsh(r)
	o.Some = r.Ok()
	return o
}

// WriteOptionalDiscriminated writes nothing for None, else [d][value].
func WriteOptionalDiscriminated[T any, P interface {
	*T
	Encoder
}](w *borsh.Writer, d Discriminator, o *borsh.Option[T]) {
	if o.Some {
		w.Raw(d[:])
		P(&o.Value).EncodeBorsh(w)
	}
}

// OptionalDiscriminatedSize is OptionalDiscriminatedData's SizedData.
func OptionalDiscriminatedSize(present bool, valueSize int) int {
	if !present {
		return 0
	}
	return DiscriminatorLength + valueSize
}

// DiscriminatorEncode is DiscriminatorEncode::encode: [d][borsh(v)].
func DiscriminatorEncode[T Encoder](d Discriminator, v T) []byte {
	w := borsh.NewWriter(64)
	w.Raw(d[:])
	v.EncodeBorsh(&w)
	return w.Bytes()
}

// DiscriminatorDecode is DiscriminatorDecode::decode: data shorter than the
// discriminator, a mismatch, or a payload that does not decode exactly is
// InvalidInstructionData.
func DiscriminatorDecode[T any, P Decoder[T]](d Discriminator, data []byte) (T, uint64) {
	var v T
	if len(data) < DiscriminatorLength {
		return v, svm.InvalidInstructionData
	}
	for i := 0; i < DiscriminatorLength; i++ {
		if data[i] != d[i] {
			return v, svm.InvalidInstructionData
		}
	}
	r := borsh.NewReader(data[DiscriminatorLength:])
	P(&v).DecodeBorsh(&r)
	if !r.Done() {
		var zero T
		return zero, svm.InvalidInstructionData
	}
	return v, svm.Success
}
