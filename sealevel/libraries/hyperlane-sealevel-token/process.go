package tokenlib

import (
	cc "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/hyperlane-sealevel-connection-client"
	recipient "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/message-recipient-interface"
	packageversioned "github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/package-versioned"
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
	"gosvm/solana"
)

// Process is the token programs' process_instruction, shared by the native,
// synthetic and collateral programs (their Rust processors are identical up
// to the plugin): GetProgramVersion, then the message recipient interface,
// then the token instructions.
func Process[T any, P Plugin[T]](c solana.Context) uint64 {
	data := solana.Instruction(c)
	if packageversioned.IsGetProgramVersion(data) {
		return packageversioned.ProcessGetProgramVersion(c)
	}
	if rix, code := recipient.Decode(data); code == svm.Success {
		switch rix.Kind {
		case recipient.KindInterchainSecurityModule:
			return InterchainSecurityModule[T, P](c)
		case recipient.KindInterchainSecurityModuleAccountMetas:
			return InterchainSecurityModuleAccountMetas(c)
		case recipient.KindHandle:
			return TransferFromRemote[T, P](c, &rix.Handle)
		case recipient.KindHandleAccountMetas:
			return TransferFromRemoteAccountMetas[T, P](c, &rix.Handle)
		}
	}

	ix := new(Instruction)
	if code := DecodeInstruction(data, ix); code != svm.Success {
		return code
	}
	// Like Rust, log any handler error (msg!("{}", err)) before returning it.
	return svm.LogError(c, processToken[T, P](c, ix))
}

func processToken[T any, P Plugin[T]](c solana.Context, ix *Instruction) uint64 {
	switch ix.Kind {
	case KindInit:
		return Initialize[T, P](c, &ix.Init)
	case KindTransferRemote:
		return TransferRemoteWithMemo[T, P](c, &ix.Transfer, nil)
	case KindTransferRemoteWithMemo:
		return TransferRemoteWithMemo[T, P](c, &ix.Transfer, ix.Memo)
	case KindEnrollRemoteRouter:
		configs := make([]cc.RemoteRouterConfig, 1)
		configs[0] = ix.RouterConfig
		return EnrollRemoteRouters[T, P](c, configs)
	case KindEnrollRemoteRouters:
		return EnrollRemoteRouters[T, P](c, ix.RouterConfigs)
	case KindSetDestinationGasConfigs:
		return SetDestinationGasConfigs[T, P](c, ix.GasConfigs)
	case KindTransferOwnership:
		return TransferOwnership[T, P](c, ix.Pubkey)
	case KindSetInterchainSecurityModule:
		return SetInterchainSecurityModule[T, P](c, ix.Pubkey)
	case KindSetInterchainGasPaymaster:
		return SetInterchainGasPaymaster[T, P](c, &ix.IGP)
	case KindSetFeeConfig:
		return SetFeeConfig[T, P](c, &ix.FeeConfig)
	}
	return svm.InvalidInstructionData
}
