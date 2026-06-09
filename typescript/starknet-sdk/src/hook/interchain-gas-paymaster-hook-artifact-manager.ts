import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactComposition,
  type OrchestratedArtifactReader,
  type OrchestratedArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type RawHookArtifactConfigs,
  throwUnsupportedHookType,
} from '@hyperlane-xyz/provider-sdk/hook';

export function createStarknetInterchainGasPaymasterHookReader(): OrchestratedArtifactReader<
  RawHookArtifactConfigs['interchainGasPaymaster'],
  DeployedHookAddress
> {
  return {
    composition: ArtifactComposition.ORCHESTRATED,
    read: async () => {
      return throwUnsupportedHookType(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        'Starknet',
      );
    },
  };
}

export function createStarknetInterchainGasPaymasterHookWriter(): OrchestratedArtifactWriter<
  RawHookArtifactConfigs['interchainGasPaymaster'],
  DeployedHookAddress
> {
  return {
    composition: ArtifactComposition.ORCHESTRATED,
    read: async () => {
      return throwUnsupportedHookType(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        'Starknet',
      );
    },
    create: async () => {
      return throwUnsupportedHookType(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        'Starknet',
      );
    },
    update: async () => {
      return throwUnsupportedHookType(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        'Starknet',
      );
    },
  };
}
