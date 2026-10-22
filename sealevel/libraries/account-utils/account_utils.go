// Package accountutils ports rust/sealevel/libraries/account-utils.
//
// AccountData<T> is stored as {initialized: bool, data: T} in Borsh. Types
// implement EncodeBorsh/DecodeBorsh (and Size, for SizedData) and use the
// generic functions here instead of Rust's wrapper struct.
package accountutils

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Encoder is a Borsh-serializable value. Implement it on the pointer type:
// goSVM copies a whole struct for every field read through a value receiver.
type Encoder interface {
	EncodeBorsh(w *borsh.Writer)
}

// Decoder is implemented by *T for a Borsh-deserializable T.
type Decoder[T any] interface {
	*T
	DecodeBorsh(r *borsh.Reader)
}

// Sized is Rust's SizedData for T: the exact serialized size of T, without
// AccountData's initialized byte (see AccountDataSize).
type Sized interface {
	Encoder
	Size() int
}

// AccountError::ExtraneousAccount = fnv1a("AccountError::ExtraneousAccount").
const ErrExtraneousAccount uint64 = 1407181317

// RemainingResizeIncrement is AccountData::store's realloc step.
const reallocIncrement = 1024

// PUBKEY_SIZE etc. from account-utils.
const (
	PubkeySize     = 32
	H256Size       = 32
	H160Size       = 20
	BorshLenPrefix = 4
)

// SPLNoopProgramID is noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV.
var SPLNoopProgramID = svm.Pubkey{11, 188, 15, 192, 187, 71, 202, 47, 116, 196, 17, 46, 148, 171, 19, 207, 163, 198, 52, 229, 220, 23, 234, 203, 3, 205, 26, 35, 205, 126, 120, 124}

// EnsureNoExtraneousAccounts fails if the iterator has accounts left.
func EnsureNoExtraneousAccounts(it *svm.AccountIter) uint64 {
	if it.HasMore() {
		return ErrExtraneousAccount
	}
	return svm.Success
}

// AccountInitState mirrors Rust's AccountInitState.
type AccountInitState uint8

const (
	Uninitialized AccountInitState = iota
	Initialized
	OwnerMismatch
)

// InitState checks account i against an expected owner.
func InitState(c solana.Context, i uint64, expectedOwner svm.Pubkey) AccountInitState {
	if svm.DataIsEmpty(c, i) && svm.OwnerIs(c, i, svm.SystemProgramID) {
		return Uninitialized
	}
	if svm.OwnerIs(c, i, expectedOwner) {
		return Initialized
	}
	return OwnerMismatch
}

// Fetch decodes AccountData<T> from buf. Empty data, or an initialized flag of
// false, yields the zero T with initialized=false. If the Rust T has a
// non-zero Default, the caller must apply it. A bad flag or T fails with
// BorshIoError. Trailing bytes are ignored, like Rust's reader-based fetch.
func Fetch[T any, P Decoder[T]](buf []byte) (T, bool, uint64) {
	var v T
	if len(buf) == 0 {
		return v, false, svm.Success
	}
	r := borsh.NewReader(buf)
	initialized := r.Bool()
	if !r.Ok() {
		return v, false, svm.BorshIoError
	}
	if !initialized {
		return v, false, svm.Success
	}
	P(&v).DecodeBorsh(&r)
	if !r.Ok() {
		var zero T
		return zero, false, svm.BorshIoError
	}
	return v, true, svm.Success
}

// FetchAccount is Fetch on account i's data.
func FetchAccount[T any, P Decoder[T]](c solana.Context, i uint64) (T, bool, uint64) {
	return Fetch[T, P](solana.Data(c, i))
}

// StoreInSlice writes {true, v} into target and zeroes the tail. It reports
// false when target is too small (Rust's WriteZero).
func StoreInSlice[T Encoder](target []byte, v T) bool {
	w := borsh.NewFixedWriter(target)
	w.Bool(true)
	v.EncodeBorsh(&w)
	if w.Overflow() {
		return false
	}
	tail := w.Remaining()
	for i := range tail {
		tail[i] = 0
	}
	return true
}

// Store is AccountData::store. Without allowRealloc a too-small account is
// BorshIoError; with it the account grows by 1,024 bytes until v fits.
func Store[T Encoder](c solana.Context, i uint64, v T, allowRealloc bool) uint64 {
	if !solana.Writable(c, i) || solana.Executable(c, i) {
		return svm.InvalidAccountData
	}
	for {
		data := solana.Data(c, i)
		if StoreInSlice(data, v) {
			return svm.Success
		}
		if !allowRealloc {
			return svm.BorshIoError
		}
		if code := Resize(c, i, uint64(len(data))+reallocIncrement); code != svm.Success {
			return code
		}
	}
}

// Resize is AccountInfo::resize, with goSVM's boundary codes mapped to
// ProgramError.
func Resize(c solana.Context, i uint64, length uint64) uint64 {
	code := solana.ResizeAccount(c, i, length)
	switch code {
	case 0:
		return svm.Success
	case 2010:
		return svm.InvalidRealloc
	case 2011:
		return svm.InvalidAccountData
	case 2012:
		return svm.IllegalOwner
	}
	return code
}

// AccountDataSize is AccountData<T>::size(): the initialized byte plus T.
func AccountDataSize[T Sized](v T) uint64 { return 1 + uint64(v.Size()) }

// StoreWithRentExemptRealloc is AccountData::store_with_rent_exempt_realloc:
// top up rent from payer for max(AccountDataSize(v), current length), grow,
// then store.
func StoreWithRentExemptRealloc[T Sized](c solana.Context, i uint64, v T, payer, systemProgram uint64) uint64 {
	required := AccountDataSize(v)
	dataLen := uint64(len(solana.Data(c, i)))
	requiredLen := required
	if dataLen > requiredLen {
		requiredLen = dataLen
	}
	rent, code := svm.MinimumBalance(c, requiredLen)
	if code != svm.Success {
		return code
	}
	lamports := solana.Lamports(c, i)
	if lamports < rent {
		if code := svm.SystemTransfer(c, systemProgram, payer, i, rent-lamports, nil); code != 0 {
			return code
		}
	}
	if dataLen < requiredLen {
		if code := Resize(c, i, requiredLen); code != svm.Success {
			return code
		}
	}
	return Store(c, i, v, false)
}

// CreatePDAAccount is create_pda_account: create (or, if already funded,
// top up, allocate and assign) a PDA of `space` bytes owned by `owner`.
// seeds must include the bump.
func CreatePDAAccount(c solana.Context, payer uint64, space uint64, owner svm.Pubkey, systemProgram, newAccount uint64, seeds *svm.Seeds) uint64 {
	rent, code := svm.MinimumBalance(c, space)
	if code != svm.Success {
		return code
	}
	if rent < 1 {
		rent = 1
	}
	current := solana.Lamports(c, newAccount)
	if current > 0 {
		if rent > current {
			if code := svm.SystemTransfer(c, systemProgram, payer, newAccount, rent-current, nil); code != 0 {
				return code
			}
		}
		if code := svm.SystemAllocate(c, systemProgram, newAccount, space, seeds); code != 0 {
			return code
		}
		return svm.SystemAssign(c, systemProgram, newAccount, owner, seeds)
	}
	return svm.SystemCreateAccount(c, systemProgram, payer, newAccount, rent, space, owner, seeds)
}

// VerifyRentExempt is verify_rent_exempt.
func VerifyRentExempt(c solana.Context, i uint64) uint64 {
	rent, code := svm.MinimumBalance(c, uint64(len(solana.Data(c, i))))
	if code != svm.Success {
		return code
	}
	if solana.Lamports(c, i) < rent {
		return svm.AccountNotRentExempt
	}
	return svm.Success
}

// VerifyAccountUninitialized is verify_account_uninitialized.
func VerifyAccountUninitialized(c solana.Context, i uint64) uint64 {
	if svm.DataIsEmpty(c, i) && svm.OwnerIs(c, i, svm.SystemProgramID) {
		return svm.Success
	}
	return svm.AccountAlreadyInitialized
}

// CloseAccount is AccountInfoExt::close_account: move all of account i's
// lamports to recipient, truncate its data and assign it to the System
// program. Rust's checks come first, with Rust's codes: i not writable or
// i == recipient is InvalidAccountData; a lamport overflow is
// ArithmeticOverflow.
//
// goSVM also requires i to be owned by this program (2012) and recipient to
// be writable and not executable (2011). Rust lets the instruction run and
// the runtime then rejects it (ExternalAccountLamportSpend /
// ReadonlyLamportChange), so those cases fail with a different code.
func CloseAccount(c solana.Context, i, recipient uint64) uint64 {
	if !solana.Writable(c, i) {
		return svm.InvalidAccountData
	}
	if svm.SameKey(c, i, recipient) {
		return svm.InvalidAccountData
	}
	code := solana.CloseAccount(c, i, recipient)
	switch code {
	case 0:
		return svm.Success
	case 2014:
		return svm.ArithmeticOverflow
	}
	return code
}
