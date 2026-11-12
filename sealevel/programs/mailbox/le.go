package mailbox

// Little-endian scalars at fixed offsets of account and instruction data;
// callers check bounds.

func u32le(b []byte, off uint64) uint32 {
	return uint32(b[off]) | uint32(b[off+1])<<8 | uint32(b[off+2])<<16 | uint32(b[off+3])<<24
}

func u64le(b []byte, off uint64) uint64 {
	v := uint64(0)
	for j := uint64(0); j < 8; j++ {
		v = v | uint64(b[off+j])<<(j*8)
	}
	return v
}

func putU32le(b []byte, off uint64, v uint32) {
	for j := uint64(0); j < 4; j++ {
		b[off+j] = byte(v >> (j * 8))
	}
}

func putU64le(b []byte, off uint64, v uint64) {
	for j := uint64(0); j < 8; j++ {
		b[off+j] = byte(v >> (j * 8))
	}
}

func u32be(b []byte, off uint64) uint32 {
	return uint32(b[off])<<24 | uint32(b[off+1])<<16 | uint32(b[off+2])<<8 | uint32(b[off+3])
}

func equal32(a, b []byte) bool {
	for j := 0; j < 32; j++ {
		if a[j] != b[j] {
			return false
		}
	}
	return true
}

func pubkey(b []byte) [32]byte {
	var k [32]byte
	copy(k[:], b[:32])
	return k
}
