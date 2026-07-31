import { isNullish } from '@hyperlane-xyz/utils';

import { allocateSequentialPorts } from './helpers.js';
import { ForkManagerRegistry } from './registry.js';
import {
  ChainMap,
  ForkChainInput,
  ForkedChainMetadata,
  IForkManager,
} from './types.js';

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

    await manager.start();

    if (!isNullish(chain.forkConfig)) {
      await manager.applyForkConfig(chain.forkConfig);
    }

    metadata[chain.chainName] = manager.getForkedChainMetadata();
    managers[chain.chainName] = manager;
  }

  return { metadata, managers };
}
