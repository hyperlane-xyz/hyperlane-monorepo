import { z } from 'zod';

import {
  type ForkChainInput,
  ForkManagerRegistry,
  buildForkedChainMetadata,
} from '@hyperlane-xyz/forking-sdk';
import { HttpServer } from '@hyperlane-xyz/http-registry-server';
import { type ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { MergedRegistry, PartialRegistry } from '@hyperlane-xyz/registry';
import { type ChainName } from '@hyperlane-xyz/sdk';
import { assert, isEVMLike, isNullish } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { logRed } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

import { type ForkConfigParser, loadForkManager } from './loadForkManager.js';

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
  context: Pick<CommandContext, 'registry' | 'multiProvider'>;
  chainsToFork: Set<ChainName>;
  forkConfig: ForkConfigByChain;
  kill: boolean;
  basePort?: number;
}): Promise<void> {
  const { registry, multiProvider } = context;

  const forkManagers = new ForkManagerRegistry();
  const parsers = new Map<ProtocolType, ForkConfigParser>();

  const requestedProtocols = new Set(
    [...chainsToFork].map((chain) => multiProvider.getProtocol(chain)),
  );
  for (const protocol of requestedProtocols) {
    await loadForkManager(protocol, {
      registry: forkManagers,
      parsers,
      multiProvider,
      fileReader: readYamlOrJson,
    });
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

  const rawByProtocol = new Map<ProtocolType, Record<string, unknown>>();
  for (const chain of targetChains) {
    const slice = forkConfig[chain];
    if (isNullish(slice)) {
      continue;
    }
    const protocol = multiProvider.getProtocol(chain);
    const bucket = rawByProtocol.get(protocol) ?? {};
    bucket[chain] = slice;
    rawByProtocol.set(protocol, bucket);
  }

  const parsedByChain: Record<string, unknown> = {};
  for (const [protocol, rawSubset] of rawByProtocol) {
    const parser = parsers.get(protocol);
    assert(parser, `No fork-config parser registered for protocol ${protocol}`);
    Object.assign(parsedByChain, parser(rawSubset));
  }

  const chains: ForkChainInput[] = targetChains.map((chainName) => {
    const rpcUrl = multiProvider.getChainMetadata(chainName).rpcUrls[0];
    assert(rpcUrl, `No rpc found for chain ${chainName}`);
    return {
      chainName,
      protocol: multiProvider.getProtocol(chainName),
      upstreamRpcUrl: rpcUrl.http,
      forkConfig: parsedByChain[chainName],
    };
  });

  // The registry server binds `basePort - 10`; a non-positive value would let
  // Node pick an ephemeral port and advertise no usable endpoint. Guard the
  // arithmetic here, before any fork manager starts.
  assert(
    basePort - 10 > 0,
    'registry server port (--port minus 10) must be > 0; increase --port',
  );

  const { metadata, managers } = await buildForkedChainMetadata({
    chains,
    forkManagers,
    basePort,
  });

  // fork.ts owns --kill teardown: tear down EVERY fork (including supported
  // chains with no fork-config slice, which never self-kill) before returning.
  // With nothing left to serve, skip the registry server too — it would only
  // keep the CLI process alive indefinitely.
  if (kill) {
    Object.values(managers).forEach((manager) => manager.kill());
    return;
  }

  // A failure setting up or starting the registry server would otherwise orphan
  // every running fork, so tear them all down before rethrowing.
  try {
    const mergedRegistry = new MergedRegistry({
      registries: [registry, new PartialRegistry({ chainMetadata: metadata })],
    });
    const httpRegistryServer = await HttpServer.create(
      async () => mergedRegistry,
    );
    await httpRegistryServer.start((basePort - 10).toString());
  } catch (error: unknown) {
    Object.values(managers).forEach((manager) => manager.kill());
    throw error;
  }
}
