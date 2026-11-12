package fee

// PDA seed lists. Each seed is its own segment, as in pda_seeds.rs.

var (
	seedPrefix    = []byte("hyperlane_fee")
	seedDash      = []byte("-")
	seedFee       = []byte("fee")
	seedRoute     = []byte("route")
	seedCCRoute   = []byte("cc_route")
	seedTransient = []byte("transient")
	seedStanding  = []byte("standing")
)

// u32LE is domain.to_le_bytes().
func u32LE(v uint32) []byte {
	return []byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}
}

// FeeAccountSeeds is fee_account_pda_seeds!(salt).
func FeeAccountSeeds(salt *H256) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedFee, seedDash, salt[:]}
}

// RouteDomainSeeds is route_domain_pda_seeds!(fee_account, domain_le).
func RouteDomainSeeds(feeAccount *Pubkey, domain uint32) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedRoute, seedDash, feeAccount[:], seedDash, u32LE(domain)}
}

// CCRouteSeeds is cc_route_pda_seeds!(fee_account, dest_le, target_router).
func CCRouteSeeds(feeAccount *Pubkey, destination uint32, targetRouter *H256) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedCCRoute, seedDash, feeAccount[:], seedDash, u32LE(destination), seedDash, targetRouter[:]}
}

// TransientQuoteSeeds is transient_quote_pda_seeds!(fee_account, scoped_salt).
func TransientQuoteSeeds(feeAccount *Pubkey, scopedSalt *H256) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedTransient, seedDash, feeAccount[:], seedDash, scopedSalt[:]}
}

// StandingQuoteSeeds is fee_standing_quote_pda_seeds!(fee_account, domain_le,
// target_router); Leaf/Routing pass the zero router.
func StandingQuoteSeeds(feeAccount *Pubkey, domain uint32, targetRouter *H256) [][]byte {
	return [][]byte{seedPrefix, seedDash, seedStanding, seedDash, feeAccount[:], seedDash, u32LE(domain), seedDash, targetRouter[:]}
}
