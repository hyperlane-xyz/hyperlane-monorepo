// Package quoteverifier ports rust/sealevel/libraries/quote-verifier: the
// signed offchain quote shared by the fee and IGP programs, its message hash
// and scoped salt, secp256k1 signer verification, and time validation.
package quoteverifier

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	ecdsa "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/ecdsa-signature"
	"gosvm/solana"
)

// DomainTag prefixes the signed message to prevent cross-protocol replay.
const DomainTag = "HyperlaneSvmQuote"

// QuoteVerifyError (ProgramError::Custom(fnv1a("QuoteVerifyError::<name>"))).
const (
	ErrInvalidSignature    uint64 = 3331620663
	ErrUnauthorizedSigner  uint64 = 3705418912
	ErrNoAuthorizedSigners uint64 = 2286425709
)

// QuoteValidationError (ProgramError::Custom(fnv1a("QuoteValidationError::<name>"))).
const (
	ErrStaleQuote               uint64 = 931416553
	ErrQuoteExpired             uint64 = 2912712095
	ErrInvalidExpiry            uint64 = 1187193018
	ErrIssuedAtTooFarInFuture   uint64 = 2242007873
	ErrFullyWildcardedQuote     uint64 = 3996517591
	ErrStaleStandingQuoteUpdate uint64 = 295001952
	ErrTransientPayerMismatch   uint64 = 1502614465
	ErrTransientContextMismatch uint64 = 2783899611
)

// MaxQuoteIssuedAtFutureSkewSecs bounds how far issued_at may lead the clock.
const MaxQuoteIssuedAtFutureSkewSecs int64 = 300

// SvmSignedQuote is the Borsh SvmSignedQuote.
type SvmSignedQuote struct {
	// Context and Data are fee-type-specific bytes.
	Context []byte
	Data    []byte
	// IssuedAt and Expiry are u48 big-endian timestamps. Expiry == IssuedAt
	// is a transient quote, Expiry > IssuedAt a standing one.
	IssuedAt   [6]byte
	Expiry     [6]byte
	ClientSalt [32]byte
	// Signature is r || s || v.
	Signature [65]byte
}

func (q *SvmSignedQuote) EncodeBorsh(w *borsh.Writer) {
	w.ByteVec(q.Context)
	w.ByteVec(q.Data)
	w.Raw(q.IssuedAt[:])
	w.Raw(q.Expiry[:])
	w.Bytes32(q.ClientSalt)
	w.Raw(q.Signature[:])
}

// DecodeBorsh copies Context and Data, so the quote outlives its input.
func (q *SvmSignedQuote) DecodeBorsh(r *borsh.Reader) {
	q.Context = r.ByteVec()
	q.Data = r.ByteVec()
	if b := r.Fixed(6); b != nil {
		copy(q.IssuedAt[:], b)
	}
	if b := r.Fixed(6); b != nil {
		copy(q.Expiry[:], b)
	}
	q.ClientSalt = r.Bytes32()
	if b := r.Fixed(65); b != nil {
		copy(q.Signature[:], b)
	}
}

// IsTransient reports expiry == issued_at.
func (q *SvmSignedQuote) IsTransient() bool { return q.Expiry == q.IssuedAt }

// IssuedAtTimestamp decodes IssuedAt.
func (q *SvmSignedQuote) IssuedAtTimestamp() int64 { return DecodeU48Timestamp(&q.IssuedAt) }

// ExpiryTimestamp decodes Expiry.
func (q *SvmSignedQuote) ExpiryTimestamp() int64 { return DecodeU48Timestamp(&q.Expiry) }

// DecodeU48Timestamp decodes a u48 big-endian timestamp.
func DecodeU48Timestamp(b *[6]byte) int64 {
	var v int64
	for i := 0; i < 6; i++ {
		v = v<<8 | int64(b[i])
	}
	return v
}

// ComputeScopedSalt is keccak256(payer || client_salt), binding the quote to
// its payer. A non-zero status is a Keccak256 syscall failure.
func (q *SvmSignedQuote) ComputeScopedSalt(c solana.Context, payer *[32]byte) ([32]byte, uint64) {
	var buf [64]byte
	copy(buf[:32], payer[:])
	copy(buf[32:], q.ClientSalt[:])
	var out [32]byte
	code := solana.Keccak256(c, buf[:], 0, 64, out[:], 0)
	return out, code
}

// messageLen is DomainTag || fee account || domain || keccak(context) ||
// keccak(data) || issued_at || expiry || scoped salt.
const messageLen = len(DomainTag) + 32 + 4 + 32 + 32 + 6 + 6 + 32

// BuildMessageHash is the hash the quote signer signed:
// keccak256(DomainTag || fee_account || domain_id (u32 LE) ||
// keccak256(context) || keccak256(data) || issued_at || expiry || scoped_salt).
func (q *SvmSignedQuote) BuildMessageHash(c solana.Context, feeAccount *[32]byte, domainID uint32, scopedSalt *[32]byte) ([32]byte, uint64) {
	var buf [messageLen]byte
	var out [32]byte
	off := copy(buf[:], DomainTag)
	off += copy(buf[off:], feeAccount[:])
	buf[off] = byte(domainID)
	buf[off+1] = byte(domainID >> 8)
	buf[off+2] = byte(domainID >> 16)
	buf[off+3] = byte(domainID >> 24)
	off += 4
	if code := solana.Keccak256(c, q.Context, 0, uint64(len(q.Context)), buf[:], uint64(off)); code != 0 {
		return out, code
	}
	off += 32
	if code := solana.Keccak256(c, q.Data, 0, uint64(len(q.Data)), buf[:], uint64(off)); code != 0 {
		return out, code
	}
	off += 32
	off += copy(buf[off:], q.IssuedAt[:])
	off += copy(buf[off:], q.Expiry[:])
	copy(buf[off:], scopedSalt[:])
	code := solana.Keccak256(c, buf[:], 0, uint64(len(buf)), out[:], 0)
	return out, code
}

// VerifySigner is SvmSignedQuote::verify_signer: recover the signer of the
// quote for (fee account, domain, payer) and require it to be in authorized
// (Rust's BTreeSet<H160>; any order works here). Errors, in Rust's order:
// ErrNoAuthorizedSigners for an empty set, ErrInvalidSignature for a
// malformed or unrecoverable signature, ErrUnauthorizedSigner otherwise.
func (q *SvmSignedQuote) VerifySigner(c solana.Context, feeAccount *[32]byte, domainID uint32, payer *[32]byte, authorized [][20]byte) ([20]byte, uint64) {
	var signer [20]byte
	if len(authorized) == 0 {
		return signer, ErrNoAuthorizedSigners
	}
	salt, code := q.ComputeScopedSalt(c, payer)
	if code != 0 {
		return signer, code
	}
	hash, code := q.BuildMessageHash(c, feeAccount, domainID, &salt)
	if code != 0 {
		return signer, code
	}
	var sig ecdsa.EcdsaSignature
	if sig.Parse(q.Signature[:]) != ecdsa.OK {
		return signer, ErrInvalidSignature
	}
	signer, code = sig.RecoverEthereumAddress(c, hash[:])
	if code != 0 {
		return [20]byte{}, ErrInvalidSignature
	}
	for i := range authorized {
		if authorized[i] == signer {
			return signer, 0
		}
	}
	return [20]byte{}, ErrUnauthorizedSigner
}

// ValidateQuote is ValidatableQuote::validate_quote (consume time). It does
// not require now >= issued_at; see the Rust docs.
func ValidateQuote(issuedAt, expiry, minIssuedAt, now int64) uint64 {
	if issuedAt < minIssuedAt {
		return ErrStaleQuote
	}
	if now > expiry {
		return ErrQuoteExpired
	}
	return 0
}

// ValidateQuoteSubmission is ValidatableQuote::validate_quote_submission
// (ingest time). now <= expiry <= 2^48 here, so now + skew cannot overflow
// (Rust's add is overflow-checked).
func ValidateQuoteSubmission(issuedAt, expiry, minIssuedAt, now int64) uint64 {
	if expiry < issuedAt {
		return ErrInvalidExpiry
	}
	if now > expiry {
		return ErrQuoteExpired
	}
	if issuedAt > now+MaxQuoteIssuedAtFutureSkewSecs {
		return ErrIssuedAtTooFarInFuture
	}
	if issuedAt < minIssuedAt {
		return ErrStaleQuote
	}
	return 0
}

// Validate is ValidateQuote on q's timestamps.
func (q *SvmSignedQuote) Validate(minIssuedAt, now int64) uint64 {
	return ValidateQuote(q.IssuedAtTimestamp(), q.ExpiryTimestamp(), minIssuedAt, now)
}

// ValidateSubmission is ValidateQuoteSubmission on q's timestamps.
func (q *SvmSignedQuote) ValidateSubmission(minIssuedAt, now int64) uint64 {
	return ValidateQuoteSubmission(q.IssuedAtTimestamp(), q.ExpiryTimestamp(), minIssuedAt, now)
}
