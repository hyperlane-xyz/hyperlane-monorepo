// Package packageversioned ports rust/sealevel/libraries/package-versioned:
// the GetProgramVersion query every Hyperlane SVM program answers before
// decoding its own instructions.
package packageversioned

import "gosvm/solana"

// PackageVersion is PACKAGE_VERSION.
const PackageVersion = "1.0.0"

// GetProgramVersionDiscriminator is the first 8 bytes of
// sha256("hyperlane:get-program-version").
var GetProgramVersionDiscriminator = [8]byte{150, 230, 176, 162, 236, 96, 183, 171}

// IsGetProgramVersion reports whether data is exactly the discriminator.
func IsGetProgramVersion(data []byte) bool {
	if len(data) != len(GetProgramVersionDiscriminator) {
		return false
	}
	for i := range GetProgramVersionDiscriminator {
		if data[i] != GetProgramVersionDiscriminator[i] {
			return false
		}
	}
	return true
}

// ProcessGetProgramVersion sets borsh(SimulationReturnData::new(PackageVersion))
// as return data: u32 LE length, the string, then the 0xff trailer.
func ProcessGetProgramVersion(c solana.Context) uint64 {
	var out [4 + len(PackageVersion) + 1]byte
	out[0] = byte(len(PackageVersion))
	copy(out[4:], PackageVersion)
	out[len(out)-1] = 0xff
	return solana.SetReturnData(c, out[:])
}
