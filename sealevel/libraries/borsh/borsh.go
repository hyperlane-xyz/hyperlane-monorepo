// Package borsh is a Borsh codec for goSVM programs, byte-compatible with the
// Rust borsh 1.x crate used by rust/sealevel.
//
// It has no reflection and no recursion, so it compiles under goSVM's subset.
// Types encode themselves by calling Writer/Reader methods in field order, the
// same order borsh-derive uses. Errors are sticky: after the first failure
// every read returns a zero value and Ok reports false, so a decoder can read
// all fields and check once at the end.
package borsh

import "unicode/utf8"

// U128 is a little-endian 128-bit unsigned integer (Rust u128).
type U128 struct {
	Lo, Hi uint64
}

// U256 is hyperlane-core's U256: four little-endian u64 limbs, least
// significant first. Borsh encodes it as 32 little-endian bytes. This is also
// the limb layout of holiman/uint256.Int.
type U256 [4]uint64

// Option is a Rust Option<T>.
type Option[T any] struct {
	Some  bool
	Value T
}

// SomeOf returns a present Option.
func SomeOf[T any](v T) Option[T] { return Option[T]{Some: true, Value: v} }

// Pair is one entry of a Rust map, in encoding order.
type Pair[K any, V any] struct {
	Key   K
	Value V
}

// Writer encodes Borsh. A growing writer appends to its own buffer; a fixed
// writer writes into a caller-supplied slice (for example account data) and
// records an overflow instead of growing, like Rust's WriteZero.
type Writer struct {
	buf      []byte
	n        int
	fixed    bool
	overflow bool
}

// NewWriter returns a growing writer with the given capacity hint.
func NewWriter(capacity int) Writer {
	return Writer{buf: make([]byte, 0, capacity)}
}

// NewFixedWriter returns a writer that writes into dst without allocating.
func NewFixedWriter(dst []byte) Writer {
	return Writer{buf: dst, fixed: true}
}

// Bytes returns the encoded bytes (a prefix of dst for a fixed writer).
func (w *Writer) Bytes() []byte {
	if w.fixed {
		return w.buf[:w.n]
	}
	return w.buf
}

// Len returns the number of bytes written (or that would have been written,
// up to the first overflow, for a fixed writer).
func (w *Writer) Len() int {
	if w.fixed {
		return w.n
	}
	return len(w.buf)
}

// Overflow reports whether a fixed writer ran out of space.
func (w *Writer) Overflow() bool { return w.overflow }

// Remaining returns the unwritten tail of a fixed writer's slice.
func (w *Writer) Remaining() []byte {
	if !w.fixed {
		return nil
	}
	return w.buf[w.n:]
}

func (w *Writer) put(b byte) {
	if !w.fixed {
		w.buf = append(w.buf, b)
		return
	}
	if w.overflow || w.n >= len(w.buf) {
		w.overflow = true
		return
	}
	w.buf[w.n] = b
	w.n++
}

// Raw writes bytes with no length prefix (fixed arrays, [u8; N]).
func (w *Writer) Raw(b []byte) {
	if !w.fixed {
		w.buf = append(w.buf, b...)
		return
	}
	if w.overflow || len(b) > len(w.buf)-w.n {
		w.overflow = true
		return
	}
	copy(w.buf[w.n:], b)
	w.n += len(b)
}

func (w *Writer) U8(v uint8) { w.put(v) }

func (w *Writer) Bool(v bool) {
	if v {
		w.put(1)
	} else {
		w.put(0)
	}
}

func (w *Writer) U16(v uint16) {
	w.put(byte(v))
	w.put(byte(v >> 8))
}

func (w *Writer) U32(v uint32) {
	for i := uint32(0); i < 4; i++ {
		w.put(byte(v >> (8 * i)))
	}
}

func (w *Writer) U64(v uint64) {
	for i := uint64(0); i < 8; i++ {
		w.put(byte(v >> (8 * i)))
	}
}

func (w *Writer) I8(v int8)   { w.U8(uint8(v)) }
func (w *Writer) I16(v int16) { w.U16(uint16(v)) }
func (w *Writer) I32(v int32) { w.U32(uint32(v)) }
func (w *Writer) I64(v int64) { w.U64(uint64(v)) }

func (w *Writer) U128(v U128) {
	w.U64(v.Lo)
	w.U64(v.Hi)
}

func (w *Writer) U256(v U256) {
	for i := 0; i < 4; i++ {
		w.U64(v[i])
	}
}

// Bytes32 writes a Pubkey or H256.
func (w *Writer) Bytes32(v [32]byte) { w.Raw(v[:]) }

// Bytes20 writes an H160.
func (w *Writer) Bytes20(v [20]byte) { w.Raw(v[:]) }

// Len32 writes a Vec/String/map length prefix.
func (w *Writer) Len32(n int) { w.U32(uint32(n)) }

// ByteVec writes a Vec<u8>.
func (w *Writer) ByteVec(b []byte) {
	w.Len32(len(b))
	w.Raw(b)
}

// String writes a Rust String.
func (w *Writer) String(s string) {
	w.Len32(len(s))
	for i := 0; i < len(s); i++ {
		w.put(s[i])
	}
}

// OptionTag writes an Option discriminant; the caller writes the value.
func (w *Writer) OptionTag(some bool) { w.Bool(some) }

// EnumTag writes an enum variant index.
func (w *Writer) EnumTag(variant uint8) { w.put(variant) }

// Reader decodes Borsh from a byte slice.
type Reader struct {
	data []byte
	off  int
	bad  bool
}

// NewReader returns a reader over data.
func NewReader(data []byte) Reader { return Reader{data: data} }

// Ok reports whether every read so far succeeded.
func (r *Reader) Ok() bool { return !r.bad }

// Done reports success with every byte consumed (Rust try_from_slice).
func (r *Reader) Done() bool { return !r.bad && r.off == len(r.data) }

// Fail marks the reader as failed, for example on an unknown enum variant.
func (r *Reader) Fail() { r.bad = true }

// Offset returns the number of bytes consumed.
func (r *Reader) Offset() int { return r.off }

// Remaining returns the number of unread bytes.
func (r *Reader) Remaining() int {
	if r.bad {
		return 0
	}
	return len(r.data) - r.off
}

// Rest returns the unread bytes without consuming them.
func (r *Reader) Rest() []byte {
	if r.bad {
		return nil
	}
	return r.data[r.off:]
}

// Fixed returns the next n bytes as a view into the input.
func (r *Reader) Fixed(n int) []byte {
	if r.bad || n < 0 || n > len(r.data)-r.off {
		r.bad = true
		return nil
	}
	v := r.data[r.off : r.off+n]
	r.off += n
	return v
}

func (r *Reader) U8() uint8 {
	if r.bad || r.off >= len(r.data) {
		r.bad = true
		return 0
	}
	v := r.data[r.off]
	r.off++
	return v
}

// Bool reads a bool; any byte other than 0 or 1 fails, as in borsh 1.x.
func (r *Reader) Bool() bool {
	v := r.U8()
	if v > 1 {
		r.bad = true
		return false
	}
	return v == 1
}

func (r *Reader) U16() uint16 {
	b := r.Fixed(2)
	if b == nil {
		return 0
	}
	return uint16(b[0]) | uint16(b[1])<<8
}

func (r *Reader) U32() uint32 {
	b := r.Fixed(4)
	if b == nil {
		return 0
	}
	v := uint32(0)
	for i := 0; i < 4; i++ {
		v |= uint32(b[i]) << (8 * uint32(i))
	}
	return v
}

func (r *Reader) U64() uint64 {
	b := r.Fixed(8)
	if b == nil {
		return 0
	}
	v := uint64(0)
	for i := 0; i < 8; i++ {
		v |= uint64(b[i]) << (8 * uint64(i))
	}
	return v
}

func (r *Reader) I8() int8   { return int8(r.U8()) }
func (r *Reader) I16() int16 { return int16(r.U16()) }
func (r *Reader) I32() int32 { return int32(r.U32()) }
func (r *Reader) I64() int64 { return int64(r.U64()) }

func (r *Reader) U128() U128 {
	lo := r.U64()
	hi := r.U64()
	return U128{Lo: lo, Hi: hi}
}

func (r *Reader) U256() U256 {
	var v U256
	for i := 0; i < 4; i++ {
		v[i] = r.U64()
	}
	return v
}

// Bytes32 reads a Pubkey or H256.
func (r *Reader) Bytes32() [32]byte {
	var v [32]byte
	b := r.Fixed(32)
	if b != nil {
		copy(v[:], b)
	}
	return v
}

// Bytes20 reads an H160.
func (r *Reader) Bytes20() [20]byte {
	var v [20]byte
	b := r.Fixed(20)
	if b != nil {
		copy(v[:], b)
	}
	return v
}

// Len32 reads a Vec/String/map length prefix.
func (r *Reader) Len32() int { return int(r.U32()) }

// ByteVecView reads a Vec<u8> as a view into the input (no copy). Copy it
// before the underlying account data can change.
func (r *Reader) ByteVecView() []byte {
	n := r.Len32()
	if r.bad {
		return nil
	}
	return r.Fixed(n)
}

// ByteVec reads a Vec<u8> into a new slice.
func (r *Reader) ByteVec() []byte {
	v := r.ByteVecView()
	if v == nil {
		if r.bad {
			return nil
		}
		return []byte{}
	}
	out := make([]byte, len(v))
	copy(out, v)
	return out
}

// String reads a Rust String; invalid UTF-8 fails, as in borsh.
func (r *Reader) String() string {
	v := r.ByteVecView()
	if r.bad {
		return ""
	}
	if !utf8.Valid(v) {
		r.bad = true
		return ""
	}
	return string(v)
}

// OptionTag reads an Option discriminant; any byte other than 0 or 1 fails.
func (r *Reader) OptionTag() bool {
	v := r.U8()
	if v > 1 {
		r.bad = true
		return false
	}
	return v == 1
}

// EnumTag reads an enum variant index. The caller fails the reader on an
// unknown variant.
func (r *Reader) EnumTag() uint8 { return r.U8() }

// WriteVec writes a Vec<T>.
func WriteVec[T any](w *Writer, items []T, write func(*Writer, T)) {
	w.Len32(len(items))
	for i := range items {
		write(w, items[i])
	}
}

// ReadVec reads a Vec<T>. Capacity is bounded by the unread input, so a
// hostile length cannot exhaust the heap before the data runs out.
func ReadVec[T any](r *Reader, read func(*Reader) T) []T {
	n := r.Len32()
	if r.bad {
		return nil
	}
	c := n
	if c > r.Remaining() {
		c = r.Remaining()
	}
	out := make([]T, 0, c)
	for i := 0; i < n; i++ {
		v := read(r)
		if r.bad {
			return nil
		}
		out = append(out, v)
	}
	return out
}

// WriteOption writes an Option<T>.
func WriteOption[T any](w *Writer, o Option[T], write func(*Writer, T)) {
	w.OptionTag(o.Some)
	if o.Some {
		write(w, o.Value)
	}
}

// ReadOption reads an Option<T>.
func ReadOption[T any](r *Reader, read func(*Reader) T) Option[T] {
	var o Option[T]
	if r.OptionTag() {
		o.Value = read(r)
		o.Some = r.Ok()
	}
	return o
}

// WriteMap writes a HashMap/BTreeMap. Rust sorts entries by key, so pairs
// must already be sorted and unique (see SortPairs).
func WriteMap[K any, V any](w *Writer, pairs []Pair[K, V], key func(*Writer, K), value func(*Writer, V)) {
	w.Len32(len(pairs))
	for i := range pairs {
		key(w, pairs[i].Key)
		value(w, pairs[i].Value)
	}
}

// ReadMap reads a HashMap/BTreeMap. Like borsh without de_strict_order, the
// input need not be sorted and a repeated key keeps its last value. The
// result is sorted by key.
func ReadMap[K any, V any](r *Reader, key func(*Reader) K, value func(*Reader) V, less func(K, K) bool) []Pair[K, V] {
	pairs := ReadVec(r, func(r *Reader) Pair[K, V] {
		k := key(r)
		v := value(r)
		return Pair[K, V]{Key: k, Value: v}
	})
	if pairs == nil {
		return pairs
	}
	return SortPairs(pairs, less)
}

// SortPairs sorts pairs by key in place, keeping the last value of a repeated
// key, and returns the deduplicated prefix.
func SortPairs[K any, V any](pairs []Pair[K, V], less func(K, K) bool) []Pair[K, V] {
	n := 0
	for i := 0; i < len(pairs); i++ {
		p := pairs[i]
		// Insertion point in pairs[:n].
		j := n
		for j > 0 && less(p.Key, pairs[j-1].Key) {
			j--
		}
		if j > 0 && !less(pairs[j-1].Key, p.Key) {
			pairs[j-1].Value = p.Value
			continue
		}
		for k := n; k > j; k-- {
			pairs[k] = pairs[k-1]
		}
		pairs[j] = p
		n++
	}
	return pairs[:n]
}

// WriteSet writes a BTreeSet/HashSet; items must be sorted and unique.
func WriteSet[T any](w *Writer, items []T, write func(*Writer, T)) {
	WriteVec(w, items, write)
}

// ReadSet reads a BTreeSet/HashSet, sorting and deduplicating like Rust.
func ReadSet[T any](r *Reader, read func(*Reader) T, less func(T, T) bool) []T {
	items := ReadVec(r, read)
	if items == nil {
		return items
	}
	return SortUnique(items, less)
}

// SortUnique sorts items in place and removes duplicates.
func SortUnique[T any](items []T, less func(T, T) bool) []T {
	n := 0
	for i := 0; i < len(items); i++ {
		v := items[i]
		j := n
		for j > 0 && less(v, items[j-1]) {
			j--
		}
		if j > 0 && !less(items[j-1], v) {
			continue
		}
		for k := n; k > j; k-- {
			items[k] = items[k-1]
		}
		items[j] = v
		n++
	}
	return items[:n]
}

// Less32 orders Pubkeys/H256 like Rust's derived Ord (lexicographic bytes).
func Less32(a, b [32]byte) bool {
	for i := 0; i < 32; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// Less20 orders H160 values lexicographically.
func Less20(a, b [20]byte) bool {
	for i := 0; i < 20; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// LessU32 orders u32 keys (domain IDs).
func LessU32(a, b uint32) bool { return a < b }

// Element codecs, for use as the function arguments above.

func WriteU8(w *Writer, v uint8)         { w.U8(v) }
func WriteU32(w *Writer, v uint32)       { w.U32(v) }
func WriteU64(w *Writer, v uint64)       { w.U64(v) }
func WriteBytes32(w *Writer, v [32]byte) { w.Bytes32(v) }
func WriteBytes20(w *Writer, v [20]byte) { w.Bytes20(v) }
func WriteByteVec(w *Writer, v []byte)   { w.ByteVec(v) }
func WriteString(w *Writer, v string)    { w.String(v) }
func ReadU8(r *Reader) uint8             { return r.U8() }
func ReadU32(r *Reader) uint32           { return r.U32() }
func ReadU64(r *Reader) uint64           { return r.U64() }
func ReadBytes32(r *Reader) [32]byte     { return r.Bytes32() }
func ReadBytes20(r *Reader) [20]byte     { return r.Bytes20() }
func ReadByteVec(r *Reader) []byte       { return r.ByteVec() }
func ReadString(r *Reader) string        { return r.String() }
