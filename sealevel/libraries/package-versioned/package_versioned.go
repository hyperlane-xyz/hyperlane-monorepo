// Package packageversioned ports rust/sealevel/libraries/package-versioned:
// the universal GetProgramVersion instruction every Hyperlane SVM program
// answers before its own dispatch.
package packageversioned

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	accountmeta "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/serializable-account-meta"
	"gosvm/solana"
)

// PackageVersion is PACKAGE_VERSION, shared by every Hyperlane SVM program.
const PackageVersion = "1.0.0"

// GetProgramVersionDiscriminator is the first 8 bytes of
// sha256("hyperlane:get-program-version").
var GetProgramVersionDiscriminator = [8]byte{150, 230, 176, 162, 236, 96, 183, 171}

// IsGetProgramVersion reports whether data is exactly the discriminator.
func IsGetProgramVersion(data []byte) bool {
	if len(data) != len(GetProgramVersionDiscriminator) {
		return false
	}
	for i := 0; i < len(data); i++ {
		if data[i] != GetProgramVersionDiscriminator[i] {
			return false
		}
	}
	return true
}

// VersionReturnData is borsh(SimulationReturnData::new(PACKAGE_VERSION)).
func VersionReturnData() []byte {
	w := borsh.NewWriter(4 + len(PackageVersion) + 1)
	w.String(PackageVersion)
	accountmeta.EndSimulationReturnData(&w)
	return w.Bytes()
}

// ProcessGetProgramVersion sets the version as return data.
func ProcessGetProgramVersion(c solana.Context) uint64 {
	return solana.SetReturnData(c, VersionReturnData())
}
