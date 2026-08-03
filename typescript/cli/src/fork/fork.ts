import {
  type ForkChainInput,
  ForkManagerRegistry,
  buildForkedChainMetadata,
} from '@hyperlane-xyz/forking-sdk';
import { HttpServer } from '@hyperlane-xyz/http-registry-server';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { MergedRegistry, PartialRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainName,
  type RawForkedChainConfigByChain,
  forkedChainConfigByChainFromRaw,
} from '@hyperlane-xyz/sdk';
import { assert, isEVMLike } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { logRed } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

import { createEvmForkManagerFactory } from './EvmForkManager.js';

export async function runForkCommand({
  context,
  chainsToFork,
  forkConfig,
  kill,
  basePort = 8545,
}: {
  context: CommandContext;
  chainsToFork: Set<ChainName>;
  forkConfig: RawForkedChainConfigByChain;
  kill: boolean;
  basePort?: number;
}): Promise<void> {
  const { registry, multiProvider } = context;

  const forkManagers = new ForkManagerRegistry();
  forkManagers.registerProtocol(
    ProtocolType.Ethereum,
    createEvmForkManagerFactory(multiProvider, kill),
  );

  const targetChains: ChainName[] = [];
  for (const chain of chainsToFork) {
    const protocol = multiProvider.getProtocol(chain);
    if (!isEVMLike(protocol) && !forkManagers.hasProtocol(protocol)) {
      logRed(`Skipping chain ${chain}: protocol ${protocol} cannot be forked`);
      continue;
    }
    if (!forkManagers.hasProtocol(protocol)) {
      logRed(
        `Skipping chain ${chain}: forking not yet supported for protocol ${protocol}`,
      );
      continue;
    }
    targetChains.push(chain);
  }

  const parsedForkConfig = forkedChainConfigByChainFromRaw(
    forkConfig,
    readYamlOrJson,
  );

  const chains: ForkChainInput[] = targetChains.map((chainName) => {
    const rpcUrl = multiProvider.getChainMetadata(chainName).rpcUrls[0];
    assert(rpcUrl, `No rpc found for chain ${chainName}`);
    return {
      chainName,
      protocol: multiProvider.getProtocol(chainName),
      upstreamRpcUrl: rpcUrl.http,
      forkConfig: parsedForkConfig[chainName],
    };
  });

  const { metadata } = await buildForkedChainMetadata({
    chains,
    forkManagers,
    basePort,
  });

  const mergedRegistry = new MergedRegistry({
    registries: [registry, new PartialRegistry({ chainMetadata: metadata })],
  });
  const httpServerPort = basePort - 10;
  assert(
    httpServerPort > 0,
    'HTTP server port too low, consider increasing --port',
  );

  const httpRegistryServer = await HttpServer.create(
    async () => mergedRegistry,
  );
  await httpRegistryServer.start(httpServerPort.toString());
}
