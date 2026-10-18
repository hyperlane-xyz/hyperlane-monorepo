package borsh_test

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/internal/testvectors"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
)

func seq32(start byte) [32]byte {
	var b [32]byte
	for i := range b {
		b[i] = start + byte(i)
	}
	return b
}

func seq20(start byte) [20]byte {
	var b [20]byte
	for i := range b {
		b[i] = start + byte(i)
	}
	return b
}

// sample mirrors the generator's enum Sample { Unit, Tuple(u32, bool),
// Struct { a: u8, b: Vec<u8>, c: Option<Pubkey> } }.
type sample struct {
	variant uint8
	n       uint32
	flag    bool
	a       uint8
	b       []byte
	c       borsh.Option[[32]byte]
}

func (s *sample) EncodeBorsh(w *borsh.Writer) {
	w.EnumTag(s.variant)
	switch s.variant {
	case 1:
		w.U32(s.n)
		w.Bool(s.flag)
	case 2:
		w.U8(s.a)
		w.ByteVec(s.b)
		borsh.WriteOption(w, s.c, borsh.WriteBytes32)
	}
}

func (s *sample) DecodeBorsh(r *borsh.Reader) {
	s.variant = r.EnumTag()
	switch s.variant {
	case 0:
	case 1:
		s.n = r.U32()
		s.flag = r.Bool()
	case 2:
		s.a = r.U8()
		s.b = r.ByteVec()
		s.c = borsh.ReadOption(r, borsh.ReadBytes32)
	default:
		r.Fail()
	}
}

type codec struct {
	encode func(w *borsh.Writer)
	decode func(r *borsh.Reader) []byte // returns the re-encoding of what it read
}

func reencode(f func(w *borsh.Writer)) []byte {
	w := borsh.NewWriter(0)
	f(&w)
	return w.Bytes()
}

func cases() map[string]codec {
	u256Max := borsh.U256{^uint64(0), ^uint64(0), ^uint64(0), ^uint64(0)}
	// 2^128 + 1
	u256Mid := borsh.U256{1, 0, 1, 0}
	m := map[string]codec{}
	add := func(name string, enc func(*borsh.Writer), dec func(*borsh.Reader) []byte) {
		m[name] = codec{enc, dec}
	}
	u8 := func(name string, v uint8) {
		add(name, func(w *borsh.Writer) { w.U8(v) }, func(r *borsh.Reader) []byte {
			x := r.U8()
			return reencode(func(w *borsh.Writer) { w.U8(x) })
		})
	}
	u8("u8_0", 0)
	u8("u8_max", 255)
	add("u16", func(w *borsh.Writer) { w.U16(0x1234) }, func(r *borsh.Reader) []byte {
		x := r.U16()
		return reencode(func(w *borsh.Writer) { w.U16(x) })
	})
	add("u32", func(w *borsh.Writer) { w.U32(0xdeadbeef) }, func(r *borsh.Reader) []byte {
		x := r.U32()
		return reencode(func(w *borsh.Writer) { w.U32(x) })
	})
	u64 := func(name string, v uint64) {
		add(name, func(w *borsh.Writer) { w.U64(v) }, func(r *borsh.Reader) []byte {
			x := r.U64()
			return reencode(func(w *borsh.Writer) { w.U64(x) })
		})
	}
	u64("u64_max", ^uint64(0))
	u64("u64_1", 1)
	u128 := func(name string, v borsh.U128) {
		add(name, func(w *borsh.Writer) { w.U128(v) }, func(r *borsh.Reader) []byte {
			x := r.U128()
			return reencode(func(w *borsh.Writer) { w.U128(x) })
		})
	}
	u128("u128", borsh.U128{Lo: 2, Hi: 1})
	u128("u128_max", borsh.U128{Lo: ^uint64(0), Hi: ^uint64(0)})
	add("i8", func(w *borsh.Writer) { w.I8(-1) }, func(r *borsh.Reader) []byte {
		x := r.I8()
		return reencode(func(w *borsh.Writer) { w.I8(x) })
	})
	add("i16", func(w *borsh.Writer) { w.I16(-2) }, func(r *borsh.Reader) []byte {
		x := r.I16()
		return reencode(func(w *borsh.Writer) { w.I16(x) })
	})
	add("i32", func(w *borsh.Writer) { w.I32(-3) }, func(r *borsh.Reader) []byte {
		x := r.I32()
		return reencode(func(w *borsh.Writer) { w.I32(x) })
	})
	add("i64_min", func(w *borsh.Writer) { w.I64(-1 << 63) }, func(r *borsh.Reader) []byte {
		x := r.I64()
		return reencode(func(w *borsh.Writer) { w.I64(x) })
	})
	for name, v := range map[string]bool{"bool_true": true, "bool_false": false} {
		v := v
		add(name, func(w *borsh.Writer) { w.Bool(v) }, func(r *borsh.Reader) []byte {
			x := r.Bool()
			return reencode(func(w *borsh.Writer) { w.Bool(x) })
		})
	}
	u256 := func(name string, v borsh.U256) {
		add(name, func(w *borsh.Writer) { w.U256(v) }, func(r *borsh.Reader) []byte {
			x := r.U256()
			return reencode(func(w *borsh.Writer) { w.U256(x) })
		})
	}
	u256("u256", u256Max)
	u256("u256_mid", u256Mid)
	b32 := func(name string, v [32]byte) {
		add(name, func(w *borsh.Writer) { w.Bytes32(v) }, func(r *borsh.Reader) []byte {
			x := r.Bytes32()
			return reencode(func(w *borsh.Writer) { w.Bytes32(x) })
		})
	}
	b32("h256", seq32(1))
	b32("pubkey", seq32(100))
	add("h160", func(w *borsh.Writer) { w.Bytes20(seq20(1)) }, func(r *borsh.Reader) []byte {
		x := r.Bytes20()
		return reencode(func(w *borsh.Writer) { w.Bytes20(x) })
	})
	bv := func(name string, v []byte) {
		add(name, func(w *borsh.Writer) { w.ByteVec(v) }, func(r *borsh.Reader) []byte {
			x := r.ByteVec()
			return reencode(func(w *borsh.Writer) { w.ByteVec(x) })
		})
	}
	bv("vec_u8_empty", []byte{})
	bv("vec_u8", []byte{1, 2, 3})
	add("vec_u32", func(w *borsh.Writer) { borsh.WriteVec(w, []uint32{1, 2}, borsh.WriteU32) }, func(r *borsh.Reader) []byte {
		x := borsh.ReadVec(r, borsh.ReadU32)
		return reencode(func(w *borsh.Writer) { borsh.WriteVec(w, x, borsh.WriteU32) })
	})
	add("vec_pubkey", func(w *borsh.Writer) { borsh.WriteVec(w, [][32]byte{seq32(1), seq32(2)}, borsh.WriteBytes32) }, func(r *borsh.Reader) []byte {
		x := borsh.ReadVec(r, borsh.ReadBytes32)
		return reencode(func(w *borsh.Writer) { borsh.WriteVec(w, x, borsh.WriteBytes32) })
	})
	str := func(name, v string) {
		add(name, func(w *borsh.Writer) { w.String(v) }, func(r *borsh.Reader) []byte {
			x := r.String()
			return reencode(func(w *borsh.Writer) { w.String(x) })
		})
	}
	str("string_empty", "")
	str("string", "hyperlane")
	str("string_utf8", "é✓")
	opt := func(name string, v borsh.Option[uint64]) {
		add(name, func(w *borsh.Writer) { borsh.WriteOption(w, v, borsh.WriteU64) }, func(r *borsh.Reader) []byte {
			x := borsh.ReadOption(r, borsh.ReadU64)
			return reencode(func(w *borsh.Writer) { borsh.WriteOption(w, x, borsh.WriteU64) })
		})
	}
	opt("option_none", borsh.Option[uint64]{})
	opt("option_some", borsh.SomeOf(uint64(7)))
	add("option_pubkey", func(w *borsh.Writer) { borsh.WriteOption(w, borsh.SomeOf(seq32(9)), borsh.WriteBytes32) }, func(r *borsh.Reader) []byte {
		x := borsh.ReadOption(r, borsh.ReadBytes32)
		return reencode(func(w *borsh.Writer) { borsh.WriteOption(w, x, borsh.WriteBytes32) })
	})
	add("array_u8_4", func(w *borsh.Writer) { w.Raw([]byte{9, 8, 7, 6}) }, func(r *borsh.Reader) []byte {
		x := r.Fixed(4)
		return reencode(func(w *borsh.Writer) { w.Raw(x) })
	})
	add("array_u64_2", func(w *borsh.Writer) { w.U64(1); w.U64(^uint64(0)) }, func(r *borsh.Reader) []byte {
		a, b := r.U64(), r.U64()
		return reencode(func(w *borsh.Writer) { w.U64(a); w.U64(b) })
	})
	add("tuple", func(w *borsh.Writer) { w.U8(5); w.U32(6) }, func(r *borsh.Reader) []byte {
		a, b := r.U8(), r.U32()
		return reencode(func(w *borsh.Writer) { w.U8(a); w.U32(b) })
	})
	enum := func(name string, s sample) {
		add(name, func(w *borsh.Writer) { s.EncodeBorsh(w) }, func(r *borsh.Reader) []byte {
			var x sample
			x.DecodeBorsh(r)
			return reencode(func(w *borsh.Writer) { x.EncodeBorsh(w) })
		})
	}
	enum("enum_unit", sample{variant: 0})
	enum("enum_tuple", sample{variant: 1, n: 77, flag: true})
	enum("enum_struct", sample{variant: 2, a: 1, b: []byte{2, 3}, c: borsh.SomeOf(seq32(4))})
	u32u64 := func(name string, pairs []borsh.Pair[uint32, uint64]) {
		add(name, func(w *borsh.Writer) {
			sorted := borsh.SortPairs(append([]borsh.Pair[uint32, uint64]{}, pairs...), borsh.LessU32)
			borsh.WriteMap(w, sorted, borsh.WriteU32, borsh.WriteU64)
		}, func(r *borsh.Reader) []byte {
			x := borsh.ReadMap(r, borsh.ReadU32, borsh.ReadU64, borsh.LessU32)
			return reencode(func(w *borsh.Writer) { borsh.WriteMap(w, x, borsh.WriteU32, borsh.WriteU64) })
		})
	}
	u32u64("hashmap_u32_u64", []borsh.Pair[uint32, uint64]{{3, 30}, {1, 10}, {2, 20}})
	u32u64("hashmap_unsorted_canonical", []borsh.Pair[uint32, uint64]{{2, 1}, {1, 5}, {2, 9}})
	add("btreemap_h256_u8", func(w *borsh.Writer) {
		pairs := borsh.SortPairs([]borsh.Pair[[32]byte, uint8]{{seq32(5), 1}, {seq32(1), 2}}, borsh.Less32)
		borsh.WriteMap(w, pairs, borsh.WriteBytes32, borsh.WriteU8)
	}, func(r *borsh.Reader) []byte {
		x := borsh.ReadMap(r, borsh.ReadBytes32, borsh.ReadU8, borsh.Less32)
		return reencode(func(w *borsh.Writer) { borsh.WriteMap(w, x, borsh.WriteBytes32, borsh.WriteU8) })
	})
	add("btreeset_h160", func(w *borsh.Writer) {
		items := borsh.SortUnique([][20]byte{seq20(9), seq20(1), seq20(9)}, borsh.Less20)
		borsh.WriteSet(w, items, borsh.WriteBytes20)
	}, func(r *borsh.Reader) []byte {
		x := borsh.ReadSet(r, borsh.ReadBytes20, borsh.Less20)
		return reencode(func(w *borsh.Writer) { borsh.WriteSet(w, x, borsh.WriteBytes20) })
	})
	return m
}

func TestRustVectors(t *testing.T) {
	vectors := testvectors.Rust(t, "borsh")
	cs := cases()
	for name, c := range cs {
		v, ok := vectors[name]
		if !ok {
			t.Errorf("%s: no Rust vector", name)
			continue
		}
		want := v.Bytes(t)
		if got := reencode(c.encode); !bytes.Equal(got, want) {
			t.Errorf("%s: encode = %x, Rust %x", name, got, want)
		}
		r := borsh.NewReader(want)
		got := c.decode(&r)
		if !r.Done() {
			t.Errorf("%s: decode did not consume exactly (ok=%v)", name, r.Ok())
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s: decode/re-encode = %x, Rust %x", name, got, want)
		}
	}
	for name, v := range vectors {
		if _, ok := cs[name]; !ok && v.OK && name != "hashmap_unsorted_input" {
			t.Errorf("Rust vector %s has no Go case", name)
		}
	}
}

// The unsorted, repeated-key map input decodes to the canonical sorted map.
func TestMapNormalization(t *testing.T) {
	vectors := testvectors.Rust(t, "borsh")
	r := borsh.NewReader(vectors["hashmap_unsorted_input"].Bytes(t))
	pairs := borsh.ReadMap(&r, borsh.ReadU32, borsh.ReadU64, borsh.LessU32)
	if !r.Done() {
		t.Fatal("decode failed")
	}
	got := reencode(func(w *borsh.Writer) { borsh.WriteMap(w, pairs, borsh.WriteU32, borsh.WriteU64) })
	if want := vectors["hashmap_unsorted_canonical"].Bytes(t); !bytes.Equal(got, want) {
		t.Fatalf("normalized %x, Rust %x", got, want)
	}
}

func TestRustRejects(t *testing.T) {
	vectors := testvectors.Rust(t, "borsh")
	decoders := map[string]func(r *borsh.Reader){
		"reject_bool_2":       func(r *borsh.Reader) { r.Bool() },
		"reject_option_tag_2": func(r *borsh.Reader) { borsh.ReadOption(r, borsh.ReadU8) },
		"reject_string_utf8":  func(r *borsh.Reader) { _ = r.String() },
		"reject_vec_short":    func(r *borsh.Reader) { r.ByteVec() },
		"reject_u64_short":    func(r *borsh.Reader) { r.U64() },
		"reject_trailing":     func(r *borsh.Reader) { r.U32() },
		"reject_enum_variant": func(r *borsh.Reader) { var s sample; s.DecodeBorsh(r) },
	}
	for name, v := range vectors {
		if v.OK {
			continue
		}
		dec, ok := decoders[name]
		if !ok {
			t.Errorf("%s: no Go decoder", name)
			continue
		}
		r := borsh.NewReader(v.Bytes(t))
		dec(&r)
		if r.Done() {
			t.Errorf("%s: Go accepts %s, Rust rejects", name, v.Hex)
		}
	}
}

func TestFixedWriterOverflow(t *testing.T) {
	buf := make([]byte, 3)
	w := borsh.NewFixedWriter(buf)
	w.U16(0xbeef)
	if w.Overflow() {
		t.Fatal("unexpected overflow")
	}
	w.U16(1)
	if !w.Overflow() || w.Len() != 3 {
		t.Fatalf("overflow=%v len=%d", w.Overflow(), w.Len())
	}
	if hex.EncodeToString(buf) != "efbe01" {
		t.Fatalf("buf %x", buf)
	}
}

// A hostile Vec length must fail on missing data, not allocate it.
func TestReadVecHugeLength(t *testing.T) {
	r := borsh.NewReader([]byte{0xff, 0xff, 0xff, 0xff, 1})
	if v := borsh.ReadVec(&r, borsh.ReadU64); v != nil || r.Ok() {
		t.Fatalf("got %v ok=%v", v, r.Ok())
	}
}
