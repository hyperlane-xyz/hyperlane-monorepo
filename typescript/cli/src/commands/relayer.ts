import { TokenRouter__factory } from '@hyperlane-xyz/core';
import { HyperlaneRelayer, RelayerCacheSchema } from '@hyperlane-xyz/relayer';
import {
  type ChainMap,
  EvmHookReader,
  HookType,
  HyperlaneCore,
  collectHybridHookNodes,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, isEVMLike } from '@hyperlane-xyz/utils';

import { type CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';
import { tryReadJson, writeJson } from '../utils/files.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

import {
  DEFAULT_LOCAL_REGISTRY,
  agentTargetsCommandOption,
  warpRouteIdCommandOption,
} from './options.js';
import { type MessageOptionsArgTypes } from './send.js';

const DEFAULT_RELAYER_CACHE = `${DEFAULT_LOCAL_REGISTRY}/relayer-cache.json`;

export const relayerCommand: CommandModuleWithContext<
  MessageOptionsArgTypes & {
    chains?: string[];
    cache: string;
    warpRouteId?: string;
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
    'warp-route-id': warpRouteIdCommandOption,
  },
  handler: async ({ context, cache, chains, warpRouteId }) => {
    const chainAddresses = await context.registry.getAddresses();
    const core = HyperlaneCore.fromAddressesMap(
      chainAddresses,
      context.multiProvider,
    );

    const chainsArray = chains?.length ? chains : Object.keys(chainAddresses);

    const whitelist: ChainMap<Address[]> = Object.fromEntries(
      chainsArray.map((chain) => [chain, []]),
    );

    if (warpRouteId) {
      const warpCoreConfig = await getWarpCoreConfigOrExit({
        context,
        warpRouteId,
      });
      for (const { chainName, addressOrDenom } of warpCoreConfig.tokens) {
        if (addressOrDenom) {
          whitelist[chainName] = [addressOrDenom];
        }
      }

      await Promise.all(
        warpCoreConfig.tokens.map(async ({ chainName, addressOrDenom }) => {
          if (
            !addressOrDenom ||
            !isEVMLike(context.multiProvider.getProtocol(chainName))
          ) {
            return;
          }

          const router = TokenRouter__factory.connect(
            addressOrDenom,
            context.multiProvider.getProvider(chainName),
          );
          const hookConfig = await new EvmHookReader(
            context.multiProvider,
            chainName,
          ).deriveHookConfig(await router.hook());

          for (const node of collectHybridHookNodes(hookConfig)) {
            if (node.type !== HookType.DELAYED_FLOW_ROUTER) continue;
            assert(
              'address' in node && typeof node.address === 'string',
              `Derived delayed-flow hook on ${chainName} is missing its address`,
            );
            whitelist[chainName] = [
              ...(whitelist[chainName] ?? []),
              node.address,
            ];
          }
        }),
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
