package fee

// PENDING(quote-verifier): placeholders until the shared quote-verifier and
// ecdsa-signature Go libraries land (gosvm/port-va-multisig). Delete this
// file then. Every instruction that needs them fails here.

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

func decodeAndSubmitQuote(c solana.Context, r *borsh.Reader) uint64 {
	return svm.InvalidInstructionData
}

func processCloseTransientQuote(c solana.Context) uint64 { return svm.InvalidInstructionData }

func consumeTransientQuote(c solana.Context, programID *Pubkey, transientIdx, payerIdx uint64, feeKey *Pubkey, strategy *FeeDataStrategy, ix *QuoteFee, isCC, specificActive bool, minIssuedAt, now int64) (uint64, uint64) {
	return 0, svm.InvalidInstructionData
}
