import { z } from 'zod';

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
  RawForkedChainConfigByChainSchema,
  forkedChainConfigByChainFromRaw,
} from '@hyperlane-xyz/sdk';
import { assert, isEVMLike, isNullish, objMap } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { logRed } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

import { createEvmForkManagerFactory } from './EvmForkManager.js';
import { createSvmForkManagerFactory } from './svm.js';

/** Protocol-neutral per-chain fork-config envelope; slices are parsed per protocol. */
export const ForkConfigByChainSchema = z.record(z.unknown());
export type ForkConfigByChain = z.infer<typeof ForkConfigByChainSchema>;

export async function runForkCommand({
  context,
  chainsToFork,
  forkConfig,
  kill,
  basePort = 8545,
}: {
  context: CommandContext;
  chainsToFork: Set<ChainName>;
  forkConfig: ForkConfigByChain;
  kill: boolean;
  basePort?: number;
}): Promise<void> {
  const { registry, multiProvider } = context;

  const forkManagers = new ForkManagerRegistry();
  forkManagers.registerProtocol(
    ProtocolType.Ethereum,
    createEvmForkManagerFactory(multiProvider, kill),
  );

  const requestedProtocols = new Set(
    [...chainsToFork].map((chain) => multiProvider.getProtocol(chain)),
  );

  const svmFork = requestedProtocols.has(ProtocolType.Sealevel)
    ? await import('@hyperlane-xyz/sealevel-sdk/fork')
    : undefined;
  if (svmFork) {
    forkManagers.registerProtocol(
      ProtocolType.Sealevel,
      createSvmForkManagerFactory(svmFork, kill),
    );
  }

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

  const evmRaw: Record<string, unknown> = {};
  const svmRaw: Record<string, unknown> = {};
  for (const chain of targetChains) {
    const slice = forkConfig[chain];
    if (isNullish(slice)) {
      continue;
    }
    if (multiProvider.getProtocol(chain) === ProtocolType.Sealevel) {
      svmRaw[chain] = slice;
    } else {
      evmRaw[chain] = slice;
    }
  }

  const evmParsed = forkedChainConfigByChainFromRaw(
    RawForkedChainConfigByChainSchema.parse(evmRaw),
    readYamlOrJson,
  );

  let svmParsed: Record<string, unknown> = {};
  if (svmFork) {
    const parseSvm = svmFork.parseSvmForkConfig;
    svmParsed = objMap(svmRaw, (_chain, slice) =>
      parseSvm(slice, readYamlOrJson),
    );
  }

  const chains: ForkChainInput[] = targetChains.map((chainName) => {
    const rpcUrl = multiProvider.getChainMetadata(chainName).rpcUrls[0];
    assert(rpcUrl, `No rpc found for chain ${chainName}`);
    return {
      chainName,
      protocol: multiProvider.getProtocol(chainName),
      upstreamRpcUrl: rpcUrl.http,
      forkConfig: evmParsed[chainName] ?? svmParsed[chainName],
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
