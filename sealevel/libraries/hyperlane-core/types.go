// Package hyperlanecore holds the hyperlane-core types the Sealevel programs
// use: H256/H160/U256, HyperlaneMessage, ModuleType and the warp TokenMessage.
// Message IDs and the merkle tree need keccak and live with that syscall.
package hyperlanecore

import "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"

// H256 is a 32-byte hash or address. Borsh encodes it as 32 raw bytes.
type H256 = [32]byte

// H160 is a 20-byte address. Borsh encodes it as 20 raw bytes.
type H160 = [20]byte

// U256 is hyperlane-core's U256 (four little-endian u64 limbs).
type U256 = borsh.U256

// U256FromBigEndian decodes 32 big-endian bytes (Solidity/ABI convention).
func U256FromBigEndian(b []byte) U256 {
	var v U256
	for limb := 0; limb < 4; limb++ {
		x := uint64(0)
		for j := 0; j < 8; j++ {
			x = x<<8 | uint64(b[24-8*limb+j])
		}
		v[limb] = x
	}
	return v
}

// U256ToBigEndian encodes v as 32 big-endian bytes.
func U256ToBigEndian(v U256) [32]byte {
	var b [32]byte
	for limb := 0; limb < 4; limb++ {
		x := v[limb]
		for j := 7; j >= 0; j-- {
			b[24-8*limb+j] = byte(x)
			x >>= 8
		}
	}
	return b
}

// U256FromUint64 widens a u64.
func U256FromUint64(x uint64) U256 { return U256{x, 0, 0, 0} }

// ModuleType is hyperlane-core's ISM ModuleType.
type ModuleType = uint32

const (
	ModuleTypeUnused                     ModuleType = 0
	ModuleTypeRouting                    ModuleType = 1
	ModuleTypeAggregation                ModuleType = 2
	ModuleTypeLegacyMultisig             ModuleType = 3
	ModuleTypeMerkleRootMultisig         ModuleType = 4
	ModuleTypeMessageIDMultisig          ModuleType = 5
	ModuleTypeNull                       ModuleType = 6
	ModuleTypeCcipRead                   ModuleType = 7
	ModuleTypeArbL2ToL1                  ModuleType = 8
	ModuleTypeWeightedMerkleRootMultisig ModuleType = 9
	ModuleTypeWeightedMessageIDMultisig  ModuleType = 10
	ModuleTypeOpL2ToL1                   ModuleType = 11
	ModuleTypePolymer                    ModuleType = 12
	ModuleTypeComposite                  ModuleType = 13
)
