package igp

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// ErrQuotingPending marks the offchain-quote paths that wait on the Go
// quote-verifier library. TODO(quote-verifier): remove with the port.
const ErrQuotingPending uint64 = 0x9E0D_0000

type quotedPayment struct {
	payment, gasAmount uint64
	transient          uint64
	hasTransient       bool
}

func validSignedQuote(b []byte) bool { return false }

func payForGasQuoted(c solana.Context, it *svm.AccountIter, senderAuthority, payer uint64, programID, igpKey Pubkey, igp *Igp, ix *Instruction) (quotedPayment, uint64) {
	return quotedPayment{}, ErrQuotingPending
}

func quoteGasPaymentQuoted(c solana.Context, it *svm.AccountIter, quotedSender uint64, programID, igpKey Pubkey, igp *Igp, ix *Instruction) (uint64, uint64) {
	return 0, ErrQuotingPending
}

func submitIgpQuote(c solana.Context, ix *Instruction) uint64 { return ErrQuotingPending }

func closeIgpTransientQuote(c solana.Context) uint64 { return ErrQuotingPending }

func closeIgpStandingQuote(c solana.Context) uint64 { return ErrQuotingPending }
