import { assert, isNullish, rootLogger } from '@hyperlane-xyz/utils';

import { allocateSequentialPorts } from './helpers.js';
import { ForkManagerRegistry } from './registry.js';
import {
  ChainMap,
  ChainName,
  ForkChainInput,
  ForkedChainMetadata,
  IForkManager,
} from './types.js';

const logger = rootLogger.child({ module: 'fork-orchestration' });

export const DEFAULT_FORK_BASE_PORT = 8545;

/**
 * VM-agnostic fork orchestration: starts a fork manager per chain, replays any
 * supplied fork config, and collects each manager's forked-chain metadata.
 */
export async function buildForkedChainMetadata(args: {
  chains: ForkChainInput[];
  forkManagers: ForkManagerRegistry;
  basePort?: number;
}): Promise<{
  metadata: ChainMap<ForkedChainMetadata>;
  managers: ChainMap<IForkManager<unknown>>;
}> {
  const { chains, forkManagers, basePort = DEFAULT_FORK_BASE_PORT } = args;

  const seen = new Set<ChainName>();
  const duplicates = chains
    .map((chain) => chain.chainName)
    .filter((chainName) => {
      if (seen.has(chainName)) {
        return true;
      }
      seen.add(chainName);
      return false;
    });
  assert(
    duplicates.length === 0,
    `Duplicate chain names in fork input: ${duplicates.join(', ')}. Each forked chain must be unique; a duplicate would start a second, unreferenced fork node.`,
  );

  const ports = allocateSequentialPorts(basePort, chains.length * 2);

  const metadata: ChainMap<ForkedChainMetadata> = {};
  const managers: ChainMap<IForkManager<unknown>> = {};
  const started: Array<{
    chainName: ChainName;
    manager: IForkManager<unknown>;
  }> = [];

  try {
    for (const [i, chain] of chains.entries()) {
      const factory = forkManagers.getForkManagerFactory(chain.protocol);
      const manager = factory({
        chainName: chain.chainName,
        upstreamRpcUrl: chain.upstreamRpcUrl,
        port: ports[i],
        wsPort: ports[chains.length + i],
      });
      started.push({ chainName: chain.chainName, manager });

      logger.info(`Starting fork node for chain ${chain.chainName}`);
      await manager.start();

      const chainMetadata = manager.getForkedChainMetadata();
      logger.info(
        `Fork node ready for chain ${chain.chainName} at ${chainMetadata.rpcUrls[0].http}`,
      );

      if (!isNullish(chain.forkConfig)) {
        await manager.applyForkConfig(chain.forkConfig);
      }

      metadata[chain.chainName] = chainMetadata;
      managers[chain.chainName] = manager;
    }
  } catch (error: unknown) {
    for (const { chainName, manager } of started) {
      try {
        manager.kill();
      } catch (killError: unknown) {
        logger.warn(
          { err: killError, chainName },
          'Failed to kill fork node during cleanup',
        );
      }
    }

    throw error;
  }

  return { metadata, managers };
}
