import { ethers, providers } from 'ethers';
import { type Logger, pino } from 'pino';

import {
  type IRegistry,
  MergedRegistry,
  PartialRegistry,
} from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  type ChainName,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { forkChain as forkChainBase } from '@hyperlane-xyz/utils/anvil';

import { ANVIL_TEST_PRIVATE_KEY } from '../fixtures/routes.js';

import { allocatePorts, releasePorts } from './PortAllocator.js';

interface ForkResult {
  endpoint: string;
  provider: providers.JsonRpcProvider;
  kill: (isPanicking?: boolean) => Promise<void>;
  chainName: string;
}

export interface ForkContext {
  forks: Map<string, ForkResult>;
  providers: Map<string, providers.JsonRpcProvider>;
  registry: IRegistry;
  multiProvider: MultiProvider;
  ports: number[];
}

export interface ForkManagerConfig {
  chains: readonly string[];
  registry: IRegistry;
  multiProvider: MultiProvider;
  blockNumbers?: Record<string, number>;
}

async function forkChain(
  multiProvider: MultiProvider,
  chainName: string,
  port: number,
  blockNumber?: number,
): Promise<ForkResult> {
  const chainMetadata = multiProvider.getChainMetadata(chainName);
  const rpcUrl = chainMetadata.rpcUrls[0];
  if (!rpcUrl) {
    throw new Error(`No rpc found for chain ${chainName}`);
  }

  const fork = await forkChainBase({
    rpcUrl: rpcUrl.http,
    chainId: Number(chainMetadata.chainId),
    port,
    blockNumber,
  });

  const kill = async (isPanicking = false): Promise<void> => {
    fork.kill(isPanicking);
  };

  process.once('exit', () => kill(false));

  return { endpoint: fork.endpoint, provider: fork.provider, kill, chainName };
}

function createMergedRegistryWithForks(
  baseRegistry: IRegistry,
  forkResults: ForkResult[],
): MergedRegistry {
  const chainMetadataOverrides: Record<string, Partial<ChainMetadata>> = {};

  for (const fork of forkResults) {
    chainMetadataOverrides[fork.chainName] = {
      blocks: { confirmations: 1 },
      rpcUrls: [{ http: fork.endpoint }],
    };
  }

  return new MergedRegistry({
    registries: [
      baseRegistry,
      new PartialRegistry({ chainMetadata: chainMetadataOverrides }),
    ],
  });
}

export class ForkManager {
  private forkContext?: ForkContext;
  private config: ForkManagerConfig;
  private readonly logger: Logger;

  constructor(config: ForkManagerConfig) {
    this.config = config;
    this.logger = pino({ level: 'debug' }).child({ module: 'ForkManager' });
  }

  async start(): Promise<ForkContext> {
    if (this.forkContext) {
      throw new Error('ForkManager already started');
    }

    const ports = allocatePorts(this.config.chains.length);
    const forks = new Map<string, ForkResult>();
    const forkedProviders = new Map<string, providers.JsonRpcProvider>();

    try {
      for (let i = 0; i < this.config.chains.length; i++) {
        const chain = this.config.chains[i];
        const port = ports[i];
        const blockNumber = this.config.blockNumbers?.[chain];
        const result = await forkChain(
          this.config.multiProvider,
          chain,
          port,
          blockNumber,
        );
        forks.set(chain, result);
        forkedProviders.set(chain, result.provider);
      }

      const mergedRegistry = createMergedRegistryWithForks(
        this.config.registry,
        Array.from(forks.values()),
      );
      const forkedMultiProvider =
        await this.createForkedMultiProvider(forkedProviders);

      this.forkContext = {
        forks,
        providers: forkedProviders,
        registry: mergedRegistry,
        multiProvider: forkedMultiProvider,
        ports,
      };

      return this.forkContext;
    } catch (error) {
      await this.killForks(forks);
      releasePorts(ports);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.forkContext) {
      return;
    }
    await this.killForks(this.forkContext.forks);
    releasePorts(this.forkContext.ports);
    this.forkContext = undefined;
  }

  private async killForks(forks: Map<string, ForkResult>): Promise<void> {
    const killPromises = Array.from(forks.values()).map((fork) =>
      fork.kill().catch((err) => {
        this.logger.debug(
          { chain: fork.chainName, error: err.message },
          'Fork kill failed (may already be dead)',
        );
      }),
    );
    await Promise.all(killPromises);
  }

  private async createForkedMultiProvider(
    forkedProviders: Map<string, providers.JsonRpcProvider>,
  ): Promise<MultiProvider> {
    const chainMetadataOverrides: Record<string, Partial<ChainMetadata>> = {};
    for (const [chain, provider] of forkedProviders) {
      const endpoint = provider.connection.url;
      chainMetadataOverrides[chain] = {
        rpcUrls: [{ http: endpoint }],
        blocks: { confirmations: 0, reorgPeriod: 0 },
      };
    }

    const baseMetadata = this.config.multiProvider.metadata;
    const mergedMetadata: Record<ChainName, ChainMetadata> = {};

    for (const chain of Object.keys(baseMetadata)) {
      if (chainMetadataOverrides[chain]) {
        mergedMetadata[chain] = {
          ...baseMetadata[chain],
          ...chainMetadataOverrides[chain],
        } as ChainMetadata;
      } else {
        mergedMetadata[chain] = baseMetadata[chain];
      }
    }

    const forkedMultiProvider = new MultiProvider(mergedMetadata);
    for (const [chain, provider] of forkedProviders) {
      forkedMultiProvider.setProvider(chain, provider);
    }

    // Create fresh wallet connected to forked providers (don't reuse original signer
    // which has SmartProvider attached with wrong network name)
    const wallet = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY);
    for (const chain of this.config.chains) {
      const chainProvider = forkedProviders.get(chain)!;
      forkedMultiProvider.setSigner(chain, wallet.connect(chainProvider));
    }

    return forkedMultiProvider;
  }

  getContext(): ForkContext {
    if (!this.forkContext) {
      throw new Error('ForkManager not started');
    }
    return this.forkContext;
  }

  getProvider(chain: string): providers.JsonRpcProvider | undefined {
    return this.getContext().providers.get(chain);
  }

  getMultiProvider(): MultiProvider {
    return this.getContext().multiProvider;
  }

  getRegistry(): IRegistry {
    return this.getContext().registry;
  }
}
