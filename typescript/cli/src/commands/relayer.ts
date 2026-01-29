import { HyperlaneRelayer, RelayerCacheSchema } from '@hyperlane-xyz/relayer';
import { type ChainMap, HyperlaneCore } from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

import { type CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';
import { tryReadJson, writeJson } from '../utils/files.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

import {
  DEFAULT_LOCAL_REGISTRY,
  agentTargetsCommandOption,
  symbolCommandOption,
  warpCoreConfigCommandOption,
} from './options.js';
import { type MessageOptionsArgTypes } from './send.js';

const DEFAULT_RELAYER_CACHE = `${DEFAULT_LOCAL_REGISTRY}/relayer-cache.json`;

export const relayerCommand: CommandModuleWithContext<
  MessageOptionsArgTypes & {
    chains?: string[];
    cache: string;
    symbol?: string;
    warp?: string;
  }
> = {
  command: 'relayer',
  describe: 'Run a Hyperlane message relayer',
  builder: {
    chains: agentTargetsCommandOption,
    cache: {
      describe: 'Path to relayer cache file',
      type: 'string',
      default: DEFAULT_RELAYER_CACHE,
    },
    symbol: symbolCommandOption,
    warp: warpCoreConfigCommandOption,
  },
  handler: async ({ context, cache, chains, symbol, warp }) => {
    const chainAddresses = await context.registry.getAddresses();
    const core = HyperlaneCore.fromAddressesMap(
      chainAddresses,
      context.multiProvider,
    );

    const chainsArray = chains?.length ? chains : Object.keys(chainAddresses);

    const whitelist: ChainMap<Address[]> = Object.fromEntries(
      chainsArray.map((chain) => [chain, []]),
    );

    // add warp route addresses to whitelist
    if (symbol || warp) {
      const warpRoute = await getWarpCoreConfigOrExit({
        context,
        symbol,
        warp,
      });
      warpRoute.tokens.forEach(
        ({ chainName, addressOrDenom }) =>
          (whitelist[chainName] = [addressOrDenom!]),
      );
    }

    const relayer = new HyperlaneRelayer({ core, whitelist });
    // TODO: fix merkle hook stubbing

    const jsonCache = tryReadJson(cache);
    if (jsonCache) {
      try {
        const parsedCache = RelayerCacheSchema.parse(jsonCache);
        relayer.hydrate(parsedCache);
      } catch (error) {
        log(`Error hydrating cache: ${error}`);
      }
    }

    log('Starting relayer ...');
    relayer.start();

    process.once('SIGINT', () => {
      log('Stopping relayer ...');
      relayer.stop();

      writeJson(cache, relayer.cache);
      process.exit(0);
    });
  },
};
