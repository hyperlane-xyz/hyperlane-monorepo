import { providers } from 'ethers';

import {
  type IRegistry,
  MergedRegistry,
  PartialRegistry,
} from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  type ChainName,
  MultiProvider,
  forkChain as forkChainBase,
} from '@hyperlane-xyz/sdk';

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
}

async function forkChain(
  multiProvider: MultiProvider,
  chainName: string,
  port: number,
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

  constructor(config: ForkManagerConfig) {
    this.config = config;
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
        const result = await forkChain(this.config.multiProvider, chain, port);
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
      fork.kill().catch((_err) => {
        // Silently ignore kill errors - fork may already be dead
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
        blocks: { confirmations: 1, reorgPeriod: 0 },
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

    const signer = this.config.multiProvider.getSigner(this.config.chains[0]);
    for (const chain of this.config.chains) {
      forkedMultiProvider.setSigner(chain, signer);
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
