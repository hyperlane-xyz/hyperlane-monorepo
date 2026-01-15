import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedHookAddress,
  IgpHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';

import { AnyAleoNetworkClient } from '../clients/base.js';

import { getIgpHookConfig } from './hook-query.js';

export class AleoIgpHookReader
  implements ArtifactReader<IgpHookConfig, DeployedHookAddress>
{
  constructor(protected readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<IgpHookConfig, DeployedHookAddress>> {
    const hookConfig = await getIgpHookConfig(this.aleoClient, address);

    // Map Aleo config to provider-sdk format
    const overhead: Record<string, number> = {};
    const oracleConfig: Record<
      string,
      {
        gasPrice: string;
        tokenExchangeRate: string;
      }
    > = {};

    for (const [domainId, gasConfig] of Object.entries(
      hookConfig.destinationGasConfigs,
    )) {
      overhead[domainId] = parseInt(gasConfig.gasOverhead);
      oracleConfig[domainId] = {
        gasPrice: gasConfig.gasOracle.gasPrice,
        tokenExchangeRate: gasConfig.gasOracle.tokenExchangeRate,
      };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: hookConfig.owner,
        beneficiary: hookConfig.owner,
        oracleKey: hookConfig.owner,
        overhead,
        oracleConfig,
      },
      deployed: {
        address: hookConfig.address,
      },
    };
  }
}
