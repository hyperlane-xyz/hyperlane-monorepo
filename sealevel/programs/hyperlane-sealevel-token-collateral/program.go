// Package tokencollateral ports
// rust/sealevel/programs/hyperlane-sealevel-token-collateral: a warp route
// that escrows SPL Token or Token-2022 collateral (see libraries/
// hyperlane-sealevel-token/collateral for the plugin).
package tokencollateral

import (
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token/collateral"
	"gosvm/solana"
)

// Process is the program entrypoint.
func Process(c solana.Context) uint64 { return tokenlib.Process[collateral.CollateralPlugin](c) }
