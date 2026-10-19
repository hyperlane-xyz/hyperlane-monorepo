// Package recipient is a test-only message recipient. Its
// InterchainSecurityModule instruction returns the ISM key held in account 0
// (data 33 bytes: Option<Pubkey>), or sets nothing when no account is passed.
// Handle requires the process authority's signature (account 0) and writes
// origin u32le, sender and the body into account 1, which it owns.
package recipient

import "gosvm/solana"

const (
	ismDiscriminator    = "\x2d\x12\xf5\x57\xea\x2e\xf6\x0f"
	handleDiscriminator = "\x21\xd2\x05\x42\xc4\xd4\xef\x8e"
)

func Process(c solana.Context) uint64 {
	ix := solana.Instruction(c)
	if string(ix) == ismDiscriminator {
		if solana.Count(c) == 0 {
			return 0
		}
		return solana.SetReturnData(c, solana.Data(c, 0))
	}
	if len(ix) < 48 || string(ix[:8]) != handleDiscriminator {
		return 2
	}
	if solana.Count(c) < 2 || !solana.Signer(c, 0) {
		return 3
	}
	out := solana.Data(c, 1)
	n := uint64(len(ix)) - 8
	if uint64(len(out)) < n {
		return 4
	}
	copy(out, ix[8:])
	return 0
}
