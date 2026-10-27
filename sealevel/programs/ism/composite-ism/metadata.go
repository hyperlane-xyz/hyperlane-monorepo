package compositeism

import (
	"math/bits"

	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
)

// subMetadataAt is metadata::sub_metadata_at: the Aggregation sub-metadata
// for sub-ISM index, with ok=false when none is provided (start == 0).
func subMetadataAt(metadata []byte, index int) ([]byte, bool, uint64) {
	offset := index * 8
	if len(metadata) < offset+8 {
		return nil, false, ErrInvalidMetadata
	}
	start := int(be32(metadata[offset:]))
	end := int(be32(metadata[offset+4:]))
	if start == 0 {
		return nil, false, 0
	}
	if start > end || end > len(metadata) {
		return nil, false, ErrInvalidMetadata
	}
	return metadata[start:end], true, 0
}

func be32(b []byte) uint32 {
	return uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
}

func be64(b []byte) uint64 {
	v := uint64(0)
	for i := 0; i < 8; i++ {
		v = v<<8 | uint64(b[i])
	}
	return v
}

// amountAtLeast is metadata::parse_routing_amount(body) >= threshold. ok is
// false when the body is shorter than 64 bytes.
func amountAtLeast(body []byte, threshold *borsh.U256) (bool, bool) {
	if len(body) < 64 {
		return false, false
	}
	// Compare the big-endian amount at body[32..64] limb by limb, most
	// significant first.
	for limb := 3; limb >= 0; limb-- {
		v := be64(body[32+8*(3-limb):])
		if v != threshold[limb] {
			return v > threshold[limb], true
		}
	}
	return true, true
}

// durationSecs is rate_limit::DURATION_SECS.
const durationSecs = 86_400

// currentLevel is rate_limit::calculate_current_level.
func currentLevel(filledLevel uint64, lastUpdated, now int64, maxCapacity uint64) uint64 {
	elapsed := now - lastUpdated
	if elapsed < 0 {
		elapsed = 0
	}
	if elapsed >= durationSecs {
		return maxCapacity
	}
	hi, lo := bits.Mul64(uint64(elapsed), maxCapacity)
	refill, _ := bits.Div64(hi, lo, durationSecs)
	if filledLevel >= maxCapacity || refill >= maxCapacity-filledLevel {
		return maxCapacity
	}
	return filledLevel + refill
}

// rateLimitedAmount reads the RateLimited amount from a TokenMessage body:
// errBody when the body is under 64 bytes, errHigh when the high 24 bytes of
// the 32-byte amount are not zero.
func rateLimitedAmount(body []byte) (uint64, uint64) {
	if len(body) < 64 {
		return 0, ErrInvalidMessageBody
	}
	for i := 32; i < 56; i++ {
		if body[i] != 0 {
			return 0, ErrRateLimitExceeded
		}
	}
	return be64(body[56:64]), 0
}
