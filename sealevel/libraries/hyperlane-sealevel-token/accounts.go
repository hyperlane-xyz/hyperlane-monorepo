// Package tokenlib ports rust/sealevel/libraries/hyperlane-sealevel-token:
// the HyperlaneToken account, the shared token instructions and the
// TokenRouter processor (transfer_remote, handle, router and gas config, warp
// fees, mailbox dispatch and IGP payment) that the native, synthetic and
// collateral programs run with their own Plugin.
package tokenlib

import (
	accountutils "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/account-utils"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Custom errors (hyperlane-sealevel-token error::Error), returned as
// ProgramError::Custom(n).
const (
	ErrExtraneousAccount       uint64 = 1
	ErrIntegerOverflow         uint64 = 2
	ErrMessageDecodeError      uint64 = 3
	ErrInvalidFeeReturnData    uint64 = 4
	ErrFeeAccountOwnerMismatch uint64 = 5
	ErrFeeBeneficiaryNotFound  uint64 = 6
	ErrIgpNewFlowRequired      uint64 = 7
	ErrInvalidFeeAccountDomain uint64 = 8
)

// TokenPDASeeds are hyperlane_token_pda_seeds!(), the same as the message
// recipient interface's handle account metas PDA seeds.
var TokenPDASeeds = [][]byte{
	[]byte("hyperlane_message_recipient"), []byte("-"), []byte("handle"), []byte("-"), []byte("account_metas"),
}

// FeeConfigDiscriminator is FeeConfig::DISCRIMINATOR.
var FeeConfigDiscriminator = accountutils.Discriminator{'T', 'O', 'K', 'F', 'E', 'E', 'V', '1'}

// FeeConfig is the optional warp fee configuration.
type FeeConfig struct {
	FeeProgram svm.Pubkey
	FeeAccount svm.Pubkey
}

func (f *FeeConfig) EncodeBorsh(w *borsh.Writer) {
	w.Bytes32(f.FeeProgram)
	w.Bytes32(f.FeeAccount)
}

func (f *FeeConfig) DecodeBorsh(r *borsh.Reader) {
	f.FeeProgram = r.Bytes32()
	f.FeeAccount = r.Bytes32()
}

// Size is FeeConfig's SizedData.
func (f *FeeConfig) Size() int { return 64 }

// PluginData is the codec half of a plugin: the plugin_data field's Borsh
// encoding and SizedData.
type PluginData[T any] interface {
	*T
	EncodeBorsh(w *borsh.Writer)
	DecodeBorsh(r *borsh.Reader)
	Size() int
}

// HyperlaneToken is the token PDA's data (stored as AccountData).
type HyperlaneToken[T any, P PluginData[T]] struct {
	Bump                     uint8
	Mailbox                  svm.Pubkey
	MailboxProcessAuthority  svm.Pubkey
	DispatchAuthorityBump    uint8
	Decimals                 uint8
	RemoteDecimals           uint8
	Owner                    borsh.Option[svm.Pubkey]
	InterchainSecurityModule borsh.Option[svm.Pubkey]
	InterchainGasPaymaster   borsh.Option[cc.IGPConfig]
	DestinationGas           cc.DestinationGas
	RemoteRouters            cc.Routers
	PluginData               T
	// FeeConfig is OptionalDiscriminatedData<FeeConfig>: last, and absent
	// from the encoding when None.
	FeeConfig borsh.Option[FeeConfig]
}

func (t *HyperlaneToken[T, P]) EncodeBorsh(w *borsh.Writer) {
	w.U8(t.Bump)
	w.Raw(t.Mailbox[:])
	w.Raw(t.MailboxProcessAuthority[:])
	w.U8(t.DispatchAuthorityBump)
	w.U8(t.Decimals)
	w.U8(t.RemoteDecimals)
	writeOptionalKey(w, &t.Owner)
	writeOptionalKey(w, &t.InterchainSecurityModule)
	igp := &t.InterchainGasPaymaster
	w.OptionTag(igp.Some)
	if igp.Some {
		w.Raw(igp.Value.Program[:])
		w.EnumTag(igp.Value.Type.Kind)
		w.Raw(igp.Value.Type.Key[:])
	}
	cc.WriteDestinationGas(w, t.DestinationGas)
	cc.WriteRouters(w, t.RemoteRouters)
	P(&t.PluginData).EncodeBorsh(w)
	accountutils.WriteOptionalDiscriminated(w, FeeConfigDiscriminator, &t.FeeConfig)
}

func (t *HyperlaneToken[T, P]) DecodeBorsh(r *borsh.Reader) {
	t.Bump = r.U8()
	readKey(r, &t.Mailbox)
	readKey(r, &t.MailboxProcessAuthority)
	t.DispatchAuthorityBump = r.U8()
	t.Decimals = r.U8()
	t.RemoteDecimals = r.U8()
	readOptionalKey(r, &t.Owner)
	readOptionalKey(r, &t.InterchainSecurityModule)
	if r.OptionTag() {
		t.InterchainGasPaymaster.Some = true
		readKey(r, &t.InterchainGasPaymaster.Value.Program)
		t.InterchainGasPaymaster.Value.Type.Kind = r.EnumTag()
		if t.InterchainGasPaymaster.Value.Type.Kind > cc.IGPTypeOverheadIgp {
			r.Fail()
		}
		readKey(r, &t.InterchainGasPaymaster.Value.Type.Key)
	}
	t.DestinationGas = cc.ReadDestinationGas(r)
	t.RemoteRouters = cc.ReadRouters(r)
	P(&t.PluginData).DecodeBorsh(r)
	t.FeeConfig = accountutils.ReadOptionalDiscriminated[FeeConfig](r, FeeConfigDiscriminator)
}

// readKey copies 32 bytes into dst without value copies of the array.
func readKey(r *borsh.Reader, dst *[32]byte) {
	if b := r.Fixed(32); b != nil {
		copy(dst[:], b)
	}
}

func readOptionalKey(r *borsh.Reader, dst *borsh.Option[svm.Pubkey]) {
	if r.OptionTag() {
		dst.Some = true
		readKey(r, &dst.Value)
	}
}

func writeOptionalKey(w *borsh.Writer, o *borsh.Option[svm.Pubkey]) {
	w.OptionTag(o.Some)
	if o.Some {
		w.Raw(o.Value[:])
	}
}

// Size is HyperlaneToken's SizedData. It counts owner, ISM and IGP as present
// whatever their value, like Rust, so accounts keep room to set them.
func (t *HyperlaneToken[T, P]) Size() int {
	return 1 + 32 + 32 + 1 + 1 + 1 +
		(1 + 32) + (1 + 32) + (1 + 32 + 1 + 32) +
		4 + len(t.DestinationGas)*(4+8) +
		4 + len(t.RemoteRouters)*(4+32) +
		P(&t.PluginData).Size() +
		accountutils.OptionalDiscriminatedSize(t.FeeConfig.Some, 64)
}

// FetchToken is HyperlaneTokenAccount::fetch(..).into_inner() into tok:
// empty or uninitialized data leaves the zero (Default) token, a bad payload
// is BorshIoError. Trailing bytes are ignored.
func FetchToken[T any, P PluginData[T]](c solana.Context, i uint64, tok *HyperlaneToken[T, P]) uint64 {
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
	tok.DecodeBorsh(&r)
	if !r.Ok() {
		return svm.BorshIoError
	}
	return svm.Success
}

// VerifyAccountAndFetch is verify_account_and_fetch_inner (and the same
// inline sequence in the processor): fetch, then require the canonical token
// PDA (InvalidArgument) owned by this program (IncorrectProgramId).
func VerifyAccountAndFetch[T any, P PluginData[T]](c solana.Context, programID *svm.Pubkey, i uint64, tok *HyperlaneToken[T, P]) uint64 {
	if code := FetchToken(c, i, tok); code != svm.Success {
		return code
	}
	expected, code := svm.CreateProgramAddress(c, TokenPDASeeds, tok.Bump, *programID)
	if code != svm.Success {
		return code
	}
	if !svm.KeyIs(c, i, expected) {
		return svm.InvalidArgument
	}
	if !svm.OwnerIs(c, i, *programID) {
		return svm.IncorrectProgramID
	}
	return svm.Success
}

// LocalAmountToRemoteAmount is local_amount_to_remote_amount.
func (t *HyperlaneToken[T, P]) LocalAmountToRemoteAmount(amount uint64) (borsh.U256, uint64) {
	out, ok := ConvertDecimals(borsh.U256{amount, 0, 0, 0}, t.Decimals, t.RemoteDecimals)
	if !ok {
		return out, svm.InvalidArgument
	}
	return out, svm.Success
}

// RemoteAmountToLocalAmount is remote_amount_to_local_amount.
func (t *HyperlaneToken[T, P]) RemoteAmountToLocalAmount(amount borsh.U256) (uint64, uint64) {
	out, ok := ConvertDecimals(amount, t.RemoteDecimals, t.Decimals)
	if !ok {
		return 0, svm.InvalidArgument
	}
	if out[1] != 0 || out[2] != 0 || out[3] != 0 {
		return 0, svm.ArithmeticOverflow
	}
	return out[0], svm.Success
}
