import { Logger } from 'pino';

import { WormholeVaaHookIsm__factory } from '@hyperlane-xyz/core';
import {
  Address,
  bytes32ToAddress,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { constants } from 'ethers';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import {
  DerivedWormholeHookIsmConfig,
  WormholeRemoteRouterConfig,
} from './types.js';
import {
  WormholeVaaConsistencyLevelSchema,
  consistencyLevelConfigFromOnchain,
} from './consistency.js';

/**
 * Reads a deployed Wormhole hook/ISM router back into its configuration.
 */
export class EvmWormholeHookIsmReader {
  protected readonly logger: Logger = rootLogger.child({
    module: 'EvmWormholeHookIsmReader',
  });

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
  ) {}

  public async deriveWormholeConfig(
    address: Address,
  ): Promise<DerivedWormholeHookIsmConfig> {
    const provider = this.multiProvider.getProvider(this.chain);
    const router = WormholeVaaHookIsm__factory.connect(address, provider);

    const [
      mailbox,
      core,
      wormholeChainId,
      consistencyLevel,
      customConsistencyLevelContract,
      customBaseConsistencyLevel,
      additionalBlocks,
      owner,
      urls,
      domains,
    ] = await Promise.all([
      router.mailbox(),
      router.wormholeCoreBridge(),
      router.wormholeChainId(),
      router.consistencyLevel(),
      router.customConsistencyLevelContract(),
      router.customBaseConsistencyLevel(),
      router.additionalBlocks(),
      router.owner(),
      router.urls(),
      router.domains(),
    ]);

    const remoteRouters = await this.deriveRemoteRouters(
      domains,
      async (domain) => {
        const [routerAddress, config] = await Promise.all([
          router.routers(domain),
          router.remoteRouterConfigs(domain),
        ]);
        return {
          router: bytes32ToAddress(routerAddress),
          wormholeChainId: config.remoteWormholeChainId,
          expectedConsistencyLevel: WormholeVaaConsistencyLevelSchema.parse(
            config.expectedLevel.consistencyLevel,
          ),
          expectedCustomBaseConsistencyLevel:
            config.expectedLevel.customBaseConsistencyLevel,
          expectedAdditionalBlocks: config.expectedLevel.additionalBlocks,
        };
      },
    );

    return {
      address,
      owner,
      mailbox,
      core,
      wormholeChainId,
      consistencyLevel: consistencyLevelConfigFromOnchain(
        consistencyLevel,
        eqAddress(customConsistencyLevelContract, constants.AddressZero)
          ? undefined
          : {
              address: customConsistencyLevelContract,
              baseConsistencyLevel: customBaseConsistencyLevel,
              additionalBlocks,
            },
      ),
      urls,
      remoteRouters,
    };
  }

  private async deriveRemoteRouters(
    domains: ReadonlyArray<number>,
    read: (domain: number) => Promise<WormholeRemoteRouterConfig>,
  ): Promise<Record<string, WormholeRemoteRouterConfig>> {
    const entries = await Promise.all(
      domains.map(async (domain) => {
        const chainName =
          this.multiProvider.tryGetChainName(domain) ?? domain.toString();
        return [chainName, await read(domain)] as const;
      }),
    );

    return Object.fromEntries(entries);
  }
}
