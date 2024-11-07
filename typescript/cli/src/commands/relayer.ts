import {
  ChainMap,
  HyperlaneCore,
  HyperlaneRelayer,
  RelayerCacheSchema,
} from '@hyperlane-xyz/sdk';

import { CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';
import { tryReadJson, writeJson } from '../utils/files.js';
import { selectRegistryWarpRoute } from '../utils/tokens.js';

import {
  agentTargetsCommandOption,
  overrideRegistryUriCommandOption,
  symbolCommandOption,
} from './options.js';
import { MessageOptionsArgTypes } from './send.js';

const DEFAULT_RELAYER_CACHE = `${overrideRegistryUriCommandOption.default}/relayer-cache.json`;

export const relayerCommand: CommandModuleWithContext<
  MessageOptionsArgTypes & { chains?: string; cache: string; symbol?: string }
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
  },
  handler: async ({ context, cache, chains, symbol }) => {
    const chainAddresses = await context.registry.getAddresses();
    const core = HyperlaneCore.fromAddressesMap(
      chainAddresses,
      context.multiProvider,
    );

    const chainsArray =
      chains?.split(',').map((_) => _.trim()) ?? Object.keys(chainAddresses);

    const whitelist: ChainMap<string[]> = Object.fromEntries(
      chainsArray.map((chain) => [chain, []]),
    );

    // add warp route addresses to whitelist
    if (symbol) {
      const warpRoute = await selectRegistryWarpRoute(context.registry, symbol);
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
