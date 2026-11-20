package subsetcheck

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"gosvm/solana"
)

// portFee touches the shared-library additions from the fee port. It lives
// in its own file so other ports' subsetcheck additions don't conflict.
func portFee(c solana.Context, data []byte) uint64 {
	u := hyperlanecore.U256FromUint64(uint64(len(data)))
	three := hyperlanecore.U256FromUint64(3)
	u, _ = hyperlanecore.U256CheckedAdd(&u, &u)
	u, _ = hyperlanecore.U256CheckedDiv(&u, &three)
	if q, ok := hyperlanecore.U256Uint64(&u); !ok || hyperlanecore.U256Cmp(&u, &u) != 0 || hyperlanecore.U256IsZero(&u) && q != 0 {
		return 1
	}
	return accountutils.CloseAccount(c, 0, 1)
}
