package tokencrosscollateral

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	hyperlanecore "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-core"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	tokenlib "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-token"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Custom errors (error::Error), returned as ProgramError::Custom(n).
const (
	ErrUnauthorizedRouter       uint64 = 1000
	ErrInvalidDispatchAuthority uint64 = 1001
	// ErrSameDomainViaMailbox is fnv1a("Error::SameDomainViaMailbox").
	ErrSameDomainViaMailbox uint64 = 3618916391
)

// PDA seeds: cross_collateral_pda_seeds!() and
// cross_collateral_dispatch_authority_pda_seeds!().
var (
	CrossCollateralPDASeeds                  = [][]byte{[]byte("hyperlane_token"), []byte("-"), []byte("cross_collateral")}
	CrossCollateralDispatchAuthorityPDASeeds = [][]byte{[]byte("hyperlane_cc"), []byte("-"), []byte("dispatch_authority")}
)

// Pre-encoded signer groups for the constant-seed PDAs above.
var (
	ccStatePDA             = tokenlib.NewStaticPDA(CrossCollateralPDASeeds)
	ccDispatchAuthorityPDA = tokenlib.NewStaticPDA(CrossCollateralDispatchAuthorityPDASeeds)
)

// RouterSet is one domain's BTreeSet<H256>, sorted and unique. It is a
// struct because goSVM rejects slice types as generic type arguments.
type RouterSet struct {
	Routers []hyperlanecore.H256
}

// EnrolledRouters is BTreeMap<u32, BTreeSet<H256>> as key-sorted pairs.
type EnrolledRouters = []borsh.Pair[uint32, RouterSet]

// CrossCollateralState is accounts::CrossCollateralState, stored as
// AccountData in the CC state PDA.
type CrossCollateralState struct {
	Bump                  uint8
	DispatchAuthorityBump uint8
	LocalDomain           uint32
	EnrolledRouters       EnrolledRouters
}

func writeRouterSet(w *borsh.Writer, s RouterSet) { borsh.WriteSet(w, s.Routers, borsh.WriteBytes32) }

func readRouterSet(r *borsh.Reader) RouterSet {
	return RouterSet{Routers: borsh.ReadSet(r, borsh.ReadBytes32, borsh.Less32)}
}

func (s *CrossCollateralState) EncodeBorsh(w *borsh.Writer) {
	w.U8(s.Bump)
	w.U8(s.DispatchAuthorityBump)
	w.U32(s.LocalDomain)
	borsh.WriteMap(w, s.EnrolledRouters, borsh.WriteU32, writeRouterSet)
}

func (s *CrossCollateralState) DecodeBorsh(r *borsh.Reader) {
	s.Bump = r.U8()
	s.DispatchAuthorityBump = r.U8()
	s.LocalDomain = r.U32()
	s.EnrolledRouters = borsh.ReadMap(r, borsh.ReadU32, readRouterSet, borsh.LessU32)
}

// Size is CrossCollateralState's SizedData (the exact Borsh length).
func (s *CrossCollateralState) Size() int {
	n := 1 + 1 + 4 + 4
	for i := range s.EnrolledRouters {
		n += 4 + 4 + 32*len(s.EnrolledRouters[i].Value.Routers)
	}
	return n
}

// routersFor returns the index of domain's entry, or -1.
func (s *CrossCollateralState) routersFor(domain uint32) int {
	for i := range s.EnrolledRouters {
		if s.EnrolledRouters[i].Key == domain {
			return i
		}
	}
	return -1
}

// IsEnrolledRouter is is_enrolled_router.
func (s *CrossCollateralState) IsEnrolledRouter(domain uint32, router *hyperlanecore.H256) bool {
	i := s.routersFor(domain)
	if i < 0 {
		return false
	}
	set := s.EnrolledRouters[i].Value.Routers
	for j := range set {
		if set[j] == *router {
			return true
		}
	}
	return false
}

// IsAuthorizedRouter is is_authorized_router: a CC-enrolled router or the
// base remote router for the domain.
func (s *CrossCollateralState) IsAuthorizedRouter(domain uint32, router *hyperlanecore.H256, remoteRouters cc.Routers) bool {
	return s.IsEnrolledRouter(domain, router) || cc.IsRemoteRouter(remoteRouters, domain, router)
}

// AddRouter is enrolled_routers.entry(domain).or_default().insert(router).
func (s *CrossCollateralState) AddRouter(domain uint32, router *hyperlanecore.H256) {
	i := s.routersFor(domain)
	if i < 0 {
		set := make([]hyperlanecore.H256, 1)
		set[0] = *router
		pairs := append(s.EnrolledRouters, borsh.Pair[uint32, RouterSet]{Key: domain, Value: RouterSet{Routers: set}})
		s.EnrolledRouters = borsh.SortPairs(pairs, borsh.LessU32)
		return
	}
	set := append(s.EnrolledRouters[i].Value.Routers, *router)
	s.EnrolledRouters[i].Value.Routers = borsh.SortUnique(set, borsh.Less32)
}

// RemoveRouter removes one router from domain, dropping the domain once its
// set is empty.
func (s *CrossCollateralState) RemoveRouter(domain uint32, router *hyperlanecore.H256) {
	i := s.routersFor(domain)
	if i < 0 {
		return
	}
	set := s.EnrolledRouters[i].Value.Routers
	n := 0
	for j := range set {
		if set[j] != *router {
			set[n] = set[j]
			n++
		}
	}
	s.EnrolledRouters[i].Value.Routers = set[:n]
	if n == 0 {
		s.RemoveDomain(domain)
	}
}

// RemoveDomain is enrolled_routers.remove(&domain).
func (s *CrossCollateralState) RemoveDomain(domain uint32) {
	i := s.routersFor(domain)
	if i < 0 {
		return
	}
	pairs := s.EnrolledRouters
	copy(pairs[i:], pairs[i+1:])
	s.EnrolledRouters = pairs[:len(pairs)-1]
}

// fetchState is CrossCollateralStateAccount::fetch(..).into_inner(): empty
// or uninitialized data is the Default (all-zero) state, a bad payload
// BorshIoError, trailing bytes ignored.
func fetchState(c solana.Context, i uint64, s *CrossCollateralState) uint64 {
	data := solana.Data(c, i)
	if len(data) == 0 {
		return svm.Success
	}
	r := borsh.NewReader(data)
	initialized := r.Bool()
	if !r.Ok() {
		return svm.BorshIoError
	}
	if !initialized {
		return svm.Success
	}
	s.DecodeBorsh(&r)
	if !r.Ok() {
		return svm.BorshIoError
	}
	return svm.Success
}

// VerifyStateAndFetch is CrossCollateralState::verify_account_and_fetch_inner:
// fetch, then require the canonical CC state PDA (InvalidArgument) owned by
// this program (IncorrectProgramId).
func VerifyStateAndFetch(c solana.Context, programID *svm.Pubkey, i uint64, s *CrossCollateralState) uint64 {
	if code := fetchState(c, i, s); code != svm.Success {
		return code
	}
	expected, code := ccStatePDA.Address(c, s.Bump, programID)
	if code != svm.Success {
		return code
	}
	if !tokenlib.KeyEq(c, i, &expected) {
		return svm.InvalidArgument
	}
	if !tokenlib.OwnerEq(c, i, programID) {
		return svm.IncorrectProgramID
	}
	return svm.Success
}

var _ accountutils.Sized = (*CrossCollateralState)(nil)
