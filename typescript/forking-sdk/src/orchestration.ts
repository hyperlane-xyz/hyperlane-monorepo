import { isNullish, rootLogger } from '@hyperlane-xyz/utils';

import { allocateSequentialPorts } from './helpers.js';
import { ForkManagerRegistry } from './registry.js';
import {
  ChainMap,
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

  const ports = allocateSequentialPorts(basePort, chains.length);

  const metadata: ChainMap<ForkedChainMetadata> = {};
  const managers: ChainMap<IForkManager<unknown>> = {};

  for (const [i, chain] of chains.entries()) {
    const factory = forkManagers.getForkManagerFactory(chain.protocol);
    const manager = factory({
      chainName: chain.chainName,
      upstreamRpcUrl: chain.upstreamRpcUrl,
      port: ports[i],
    });

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

  return { metadata, managers };
}
