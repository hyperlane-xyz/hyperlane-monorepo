import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedWarpAddress,
  RawSyntheticWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { RadixBase } from '../utils/base.js';

import { getWarpTokenConfig, getWarpTokenRemoteRouters } from './warp-query.js';

export class RadixSyntheticTokenReader
  implements ArtifactReader<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    protected readonly gateway: GatewayApiClient,
    protected readonly base: RadixBase,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
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

    const config: RawSyntheticWarpArtifactConfig = {
      type: AltVM.TokenType.synthetic,
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
