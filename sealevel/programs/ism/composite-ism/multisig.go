package compositeism

import (
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// TODO(multisig libs): replace with libraries/multisig-ism once
// gosvm/port-va-multisig lands.
func verifyMultisig(c solana.Context, n *IsmNode, metadata []byte, message *hyperlanecore.HyperlaneMessage, encoded []byte) uint64 {
	return ErrInvalidMetadata
}

func (s *specContext) legacyMultisigSpec(c solana.Context, fallback *svm.Pubkey, domainKey, fallbackVAM svm.Pubkey) specResult {
	return specResult{code: ErrFallbackIsmCallFailed}
}
