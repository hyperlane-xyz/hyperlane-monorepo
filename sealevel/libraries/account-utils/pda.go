package accountutils

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// VerifyPDAWithBumpHint is verify_pda_with_bump_hint: it reports whether
// account i's key is the canonical PDA for seeds under program, and its bump.
//
// With a hint, one CreateProgramAddress(seeds ++ [hint]) that equals the key
// settles it; otherwise (no hint, a wrong hint or an on-curve result) it falls
// back to FindProgramAddress and compares. The fast path accepts any bump, so
// the hint must come from the data of the account at the key, owned by
// program, and program must only create accounts at canonical bumps. Then the
// answer is the same as without a hint; only the cost differs. A
// FindProgramAddress failure returns its code, as the callers did before.
func VerifyPDAWithBumpHint(c solana.Context, i uint64, seeds [][]byte, hint uint8, hasHint bool, program svm.Pubkey) (uint8, bool, uint64) {
	key := solana.Key(c, i)
	if hasHint {
		if address, code := svm.CreateProgramAddress(c, seeds, hint, program); code == svm.Success && svm.Equal32(key, &address) {
			return hint, true, svm.Success
		}
	}
	address, bump, code := svm.FindProgramAddress(c, seeds, program)
	if code != svm.Success {
		return 0, false, code
	}
	return bump, svm.Equal32(key, &address), svm.Success
}

// StoredBump reads the bump that an initialized, program-owned
// AccountData<DiscriminatorPrefixed<T>> account stores as T's first field:
// [initialized = 1][discriminator d][bump]...
func StoredBump(c solana.Context, i uint64, d Discriminator, program svm.Pubkey) (uint8, bool) {
	if !svm.OwnerIs(c, i, program) {
		return 0, false
	}
	data := solana.Data(c, i)
	if len(data) < 1+DiscriminatorLength+1 || data[0] != 1 {
		return 0, false
	}
	for j := 0; j < DiscriminatorLength; j++ {
		if data[1+j] != d[j] {
			return 0, false
		}
	}
	return data[1+DiscriminatorLength], true
}

// VerifyPDAWithStoredBump is verify_pda_with_stored_bump: VerifyPDAWithBumpHint
// with the hint from account i's own data (see StoredBump).
func VerifyPDAWithStoredBump(c solana.Context, i uint64, d Discriminator, seeds [][]byte, program svm.Pubkey) (uint8, bool, uint64) {
	hint, ok := StoredBump(c, i, d, program)
	return VerifyPDAWithBumpHint(c, i, seeds, hint, ok, program)
}
