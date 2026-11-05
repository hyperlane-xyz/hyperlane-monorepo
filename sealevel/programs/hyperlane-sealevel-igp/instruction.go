package igp

import (
	accesscontrol "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/access-control"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
	quoteverifier "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/quote-verifier"
)

// instruction::Instruction variant indices.
const (
	IxInit                         uint8 = 0
	IxInitIgp                      uint8 = 1
	IxInitOverheadIgp              uint8 = 2
	IxPayForGas                    uint8 = 3
	IxQuoteGasPayment              uint8 = 4
	IxTransferIgpOwnership         uint8 = 5
	IxTransferOverheadIgpOwnership uint8 = 6
	IxSetIgpBeneficiary            uint8 = 7
	IxSetDestinationGasOverheads   uint8 = 8
	IxSetGasOracleConfigs          uint8 = 9
	IxClaim                        uint8 = 10
	IxSetIgpQuoteConfig            uint8 = 11
	IxSetIgpQuoteSigner            uint8 = 12
	IxSetIgpMinIssuedAt            uint8 = 13
	IxSubmitIgpQuote               uint8 = 14
	IxCloseIgpTransientQuote       uint8 = 15
	IxCloseIgpStandingQuote        uint8 = 16
	IxGetIgpQuoteAccountMetas      uint8 = 17
)

// SetIgpQuoteSignerOperation variant indices.
const (
	SignerAdd    uint8 = 0
	SignerRemove uint8 = 1
)

// GasOverheadConfig is instruction::GasOverheadConfig.
type GasOverheadConfig struct {
	DestinationDomain uint32
	GasOverhead       borsh.Option[uint64]
}

// GasOracleConfig is instruction::GasOracleConfig.
type GasOracleConfig struct {
	Domain    uint32
	GasOracle borsh.Option[GasOracle]
}

// Instruction is a decoded instruction::Instruction. Kind selects the
// variant; only that variant's fields are set.
type Instruction struct {
	Kind uint8

	// InitIgp / InitOverheadIgp.
	Salt  H256
	Owner accesscontrol.Owner
	// InitIgp beneficiary, InitOverheadIgp inner, SetIgpBeneficiary.
	Key Pubkey

	// PayForGas / QuoteGasPayment / GetIgpQuoteAccountMetas.
	MessageID         H256
	DestinationDomain uint32
	GasAmount         uint64
	// GetIgpQuoteAccountMetas.
	Sender     Pubkey
	ScopedSalt borsh.Option[H256]

	// TransferIgpOwnership / TransferOverheadIgpOwnership.
	NewOwner accesscontrol.Owner

	GasOverheads []GasOverheadConfig
	GasOracles   []GasOracleConfig

	// SetIgpQuoteConfig.
	FeeConfig borsh.Option[IgpFeeConfig]
	// SetIgpQuoteSigner.
	SignerOp uint8
	Signer   H160
	// SetIgpMinIssuedAt.
	MinIssuedAt int64

	// SubmitIgpQuote.
	Quote quoteverifier.SvmSignedQuote
}

func readGasOverheadConfig(r *borsh.Reader) GasOverheadConfig {
	var c GasOverheadConfig
	c.DestinationDomain = r.U32()
	c.GasOverhead = borsh.ReadOption(r, borsh.ReadU64)
	return c
}

func readGasOracleConfig(r *borsh.Reader) GasOracleConfig {
	var c GasOracleConfig
	c.Domain = r.U32()
	c.GasOracle = borsh.ReadOption(r, readGasOracle)
	return c
}

func readFeeConfig(r *borsh.Reader) IgpFeeConfig {
	var f IgpFeeConfig
	f.DecodeBorsh(r)
	return f
}

// DecodeInstruction is Instruction::try_from_slice: every byte must be
// consumed. The bool is false on any decode error (BorshIoError through `?`).
func DecodeInstruction(data []byte, ix *Instruction) bool {
	r := borsh.NewReader(data)
	ix.Kind = r.EnumTag()
	switch ix.Kind {
	case IxInit, IxClaim, IxCloseIgpTransientQuote, IxCloseIgpStandingQuote:
	case IxInitIgp, IxInitOverheadIgp:
		ix.Salt = r.Bytes32()
		ix.Owner = readOwner(&r)
		ix.Key = r.Bytes32()
	case IxPayForGas:
		ix.MessageID = r.Bytes32()
		ix.DestinationDomain = r.U32()
		ix.GasAmount = r.U64()
	case IxQuoteGasPayment:
		ix.DestinationDomain = r.U32()
		ix.GasAmount = r.U64()
	case IxTransferIgpOwnership, IxTransferOverheadIgpOwnership:
		ix.NewOwner = readOwner(&r)
	case IxSetIgpBeneficiary:
		ix.Key = r.Bytes32()
	case IxSetDestinationGasOverheads:
		ix.GasOverheads = borsh.ReadVec(&r, readGasOverheadConfig)
	case IxSetGasOracleConfigs:
		ix.GasOracles = borsh.ReadVec(&r, readGasOracleConfig)
	case IxSetIgpQuoteConfig:
		ix.FeeConfig = borsh.ReadOption(&r, readFeeConfig)
	case IxSetIgpQuoteSigner:
		ix.SignerOp = r.EnumTag()
		if ix.SignerOp > SignerRemove {
			r.Fail()
		}
		ix.Signer = r.Bytes20()
	case IxSetIgpMinIssuedAt:
		ix.MinIssuedAt = r.I64()
	case IxSubmitIgpQuote:
		ix.Quote.DecodeBorsh(&r)
	case IxGetIgpQuoteAccountMetas:
		ix.DestinationDomain = r.U32()
		ix.Sender = r.Bytes32()
		ix.ScopedSalt = borsh.ReadOption(&r, borsh.ReadBytes32)
	default:
		return false
	}
	return r.Done()
}
