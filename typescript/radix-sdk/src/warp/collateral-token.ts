import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedWarpAddress,
  RawCollateralWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { RadixBase } from '../utils/base.js';

import { getWarpTokenConfig, getWarpTokenRemoteRouters } from './warp-query.js';

export class RadixCollateralTokenReader
  implements
    ArtifactReader<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    protected readonly gateway: GatewayApiClient,
    protected readonly base: RadixBase,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    // Fetch token info
    const token = await getWarpTokenConfig(this.gateway, this.base, address);
    const remoteRoutersList = await getWarpTokenRemoteRouters(
      this.gateway,
      address,
    );

    // Map remote routers list to Record<number, { address: string }>
    const remoteRouters: Record<number, { address: string }> = {};
    const destinationGas: Record<number, string> = {};

    for (const router of remoteRoutersList) {
      remoteRouters[router.receiverDomainId] = {
        address: router.receiverAddress,
      };
      destinationGas[router.receiverDomainId] = router.gas;
    }

    const config: RawCollateralWarpArtifactConfig = {
      type: AltVM.TokenType.collateral,
      owner: token.owner,
      mailbox: token.mailboxAddress,
      interchainSecurityModule: token.ismAddress
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: token.ismAddress,
            },
          }
        : undefined,
      remoteRouters,
      destinationGas,
      token: token.denom,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address: token.address,
      },
    };
  }
}
