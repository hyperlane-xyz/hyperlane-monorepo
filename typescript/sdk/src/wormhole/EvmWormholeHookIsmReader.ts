import { Logger } from 'pino';

import {
  WormholeExecutorHookIsm__factory,
  WormholeVaaHookIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  bytes32ToAddress,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { constants } from 'ethers';

import { ModuleType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import {
  DerivedWormholeHookIsmConfig,
  WormholeRemoteRouterConfig,
  WormholeVariant,
} from './types.js';
import {
  WormholeConsistencyLevelSchema,
  consistencyLevelConfigFromOnchain,
} from './consistency.js';

/**
 * Reads a deployed Wormhole hook/ISM router back into its configuration.
 *
 * Both variants report `hookType() == WORMHOLE`, so the concrete subtype is
 * resolved from `moduleType()`: the Executor variant verifies with empty
 * metadata (`NULL`), the direct-VAA variant through CCIP-read.
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
    const variant = await this.deriveVariant(address);
    return variant === WormholeVariant.Executor
      ? this.deriveExecutorConfig(address)
      : this.deriveDirectVaaConfig(address);
  }

  public async deriveVariant(address: Address): Promise<WormholeVariant> {
    const provider = this.multiProvider.getProvider(this.chain);
    // `moduleType` is the only on-chain discriminator between the variants.
    const moduleType = await WormholeVaaHookIsm__factory.connect(
      address,
      provider,
    ).moduleType();

    if (moduleType === ModuleType.NULL) return WormholeVariant.Executor;
    if (moduleType === ModuleType.CCIP_READ) return WormholeVariant.DirectVaa;

    throw new Error(
      `Address ${address} on ${this.chain} reports module type ${moduleType}, which is not a Wormhole hook/ISM`,
    );
  }

  private async deriveExecutorConfig(
    address: Address,
  ): Promise<DerivedWormholeHookIsmConfig> {
    const provider = this.multiProvider.getProvider(this.chain);
    const router = WormholeExecutorHookIsm__factory.connect(address, provider);

    const [
      mailbox,
      core,
      wormholeChainId,
      consistencyLevel,
      customConsistencyLevel,
      baseConsistencyLevel,
      additionalBlocks,
      owner,
      quoterRouter,
      domains,
    ] = await Promise.all([
      router.mailbox(),
      router.wormhole(),
      router.wormholeChainId(),
      router.consistencyLevel(),
      router.customConsistencyLevel(),
      router.baseConsistencyLevel(),
      router.additionalBlocks(),
      router.owner(),
      router.executorQuoterRouter(),
      router.domains(),
    ]);

    const remoteRouters = await this.deriveRemoteRouters(
      domains,
      async (domain) => {
        const [routerAddress, config, executorConfig] = await Promise.all([
          router.routers(domain),
          router.remoteRouterConfigs(domain),
          router.executorConfigs(domain),
        ]);
        return {
          router: bytes32ToAddress(routerAddress),
          wormholeChainId: config.wormholeChainId,
          expectedConsistencyLevel: WormholeConsistencyLevelSchema.parse(
            config.expectedConsistencyLevel,
          ),
          quoter: executorConfig.quoter,
          callbackGasLimit: executorConfig.callbackGasLimit.toBigInt(),
        };
      },
    );

    return {
      address,
      type: WormholeVariant.Executor,
      owner,
      mailbox,
      core,
      wormholeChainId,
      consistencyLevel: consistencyLevelConfigFromOnchain(
        consistencyLevel,
        eqAddress(customConsistencyLevel, constants.AddressZero)
          ? undefined
          : {
              address: customConsistencyLevel,
              baseConsistencyLevel,
              additionalBlocks,
            },
      ),
      executorQuoterRouter: quoterRouter,
      remoteRouters,
    };
  }

  private async deriveDirectVaaConfig(
    address: Address,
  ): Promise<DerivedWormholeHookIsmConfig> {
    const provider = this.multiProvider.getProvider(this.chain);
    const router = WormholeVaaHookIsm__factory.connect(address, provider);

    const [
      mailbox,
      core,
      wormholeChainId,
      consistencyLevel,
      customConsistencyLevel,
      baseConsistencyLevel,
      additionalBlocks,
      owner,
      urls,
      domains,
    ] = await Promise.all([
      router.mailbox(),
      router.wormhole(),
      router.wormholeChainId(),
      router.consistencyLevel(),
      router.customConsistencyLevel(),
      router.baseConsistencyLevel(),
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
          wormholeChainId: config.wormholeChainId,
          expectedConsistencyLevel: WormholeConsistencyLevelSchema.parse(
            config.expectedConsistencyLevel,
          ),
        };
      },
    );

    return {
      address,
      type: WormholeVariant.DirectVaa,
      owner,
      mailbox,
      core,
      wormholeChainId,
      consistencyLevel: consistencyLevelConfigFromOnchain(
        consistencyLevel,
        eqAddress(customConsistencyLevel, constants.AddressZero)
          ? undefined
          : {
              address: customConsistencyLevel,
              baseConsistencyLevel,
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
