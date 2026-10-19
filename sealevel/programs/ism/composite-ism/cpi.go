package compositeism

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// errCPIAccounts is returned when a fallback-ISM CPI needs more than goSVM's
// 64 account metas (more than the instruction can carry), or the callee
// program is not among the instruction's accounts. A missing program fails
// in the Rust runtime rather than with a program error.
const errCPIAccounts = svm.NotEnoughAccountKeys

// findAccount returns the index of the first account with key k.
func findAccount(c solana.Context, k *svm.Pubkey) (uint64, bool) {
	n := solana.Count(c)
	for i := uint64(0); i < n; i++ {
		if svm.KeyIs(c, i, *k) {
			return i, true
		}
	}
	return 0, false
}

// invokeRange CPIs program with accounts [from, to) as metas, keeping each
// account's signer and writable flags (account_info_to_meta).
func invokeRange(c solana.Context, program *svm.Pubkey, from, to uint64, data []byte) uint64 {
	if to < from || to-from > svm.MaxCPIMetas {
		return errCPIAccounts
	}
	programIndex, ok := findAccount(c, program)
	if !ok {
		return errCPIAccounts
	}
	metas := new(svm.Metas)
	for i := from; i < to; i++ {
		metas.Add(i, solana.Writable(c, i), solana.Signer(c, i))
	}
	return svm.Invoke(c, programIndex, metas, data, nil)
}

// invokeOne CPIs program with the single read-only account i.
func invokeOne(c solana.Context, program *svm.Pubkey, i uint64, data []byte) uint64 {
	programIndex, ok := findAccount(c, program)
	if !ok {
		return errCPIAccounts
	}
	metas := new(svm.Metas)
	metas.Add(i, false, false)
	return svm.Invoke(c, programIndex, metas, data, nil)
}

// returnData is get_return_data(): ok is false when there is none. Like
// Rust, the setter is not checked.
func returnData(c solana.Context) ([]byte, bool) {
	buf := make([]byte, 1024)
	var setter [32]byte
	n := solana.GetReturnData(c, buf, setter[:])
	if n == 0 {
		return nil, false
	}
	if n > 1024 {
		n = 1024
	}
	return buf[:n], true
}
