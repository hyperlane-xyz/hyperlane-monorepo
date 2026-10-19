package subsetcheck

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"gosvm/solana"
)

// portFee touches the shared-library additions from the fee port. It lives
// in its own file so other ports' subsetcheck additions don't conflict.
func portFee(c solana.Context, data []byte) uint64 {
	return accountutils.CloseAccount(c, 0, 1)
}
