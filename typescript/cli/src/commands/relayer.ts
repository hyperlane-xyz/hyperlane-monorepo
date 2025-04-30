import {
  ChainMap,
  EvmAdapter,
  HyperlaneCore,
  MessageBus,
  StarknetAdapter,
  StarknetCore,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

import {
  DEFAULT_LOCAL_REGISTRY,
  agentTargetsCommandOption,
  symbolCommandOption,
  warpCoreConfigCommandOption,
} from './options.js';
import { MessageOptionsArgTypes } from './send.js';

const DEFAULT_RELAYER_CACHE = `${DEFAULT_LOCAL_REGISTRY}/relayer-cache.json`;

export const relayerCommand: CommandModuleWithContext<
  MessageOptionsArgTypes & {
    chains?: string;
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
    const chainsArray =
      chains?.split(',').map((_) => _.trim()) ?? Object.keys(chainAddresses);

    const whitelist: ChainMap<Address[]> = Object.fromEntries(
      chainsArray.map((chain) => [chain, []]),
    );

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

    const protocols = new Set<ProtocolType>();
    const chainsByProtocol: Record<ProtocolType, string[]> = {
      [ProtocolType.Ethereum]: [],
      [ProtocolType.Starknet]: [],
      [ProtocolType.Cosmos]: [],
      [ProtocolType.Sealevel]: [],
      [ProtocolType.CosmosNative]: [],
    };

    const cores: {
      [ProtocolType.Ethereum]?: HyperlaneCore;
      [ProtocolType.Starknet]?: StarknetCore;
    } = {};

    chainsArray.forEach((chain) => {
      const protocol = context.multiProvider.getProtocol(chain);
      protocols.add(protocol);
      chainsByProtocol[protocol]?.push(chain);
    });

    // Initialize cores based on protocols
    const initializeCore = (
      protocol: ProtocolType.Ethereum | ProtocolType.Starknet,
    ) => {
      if (!protocols.has(protocol)) return;

      const protocolAddresses: ChainMap<any> = {};
      chainsByProtocol[protocol].forEach(
        (chain) =>
          chainAddresses[chain] &&
          (protocolAddresses[chain] = chainAddresses[chain]),
      );

      // Skip if no addresses found
      if (!Object.keys(protocolAddresses).length) return;

      if (protocol === ProtocolType.Ethereum) {
        cores[protocol] = HyperlaneCore.fromAddressesMap(
          protocolAddresses,
          context.multiProvider,
        );
      } else if (protocol === ProtocolType.Starknet) {
        cores[protocol] = new StarknetCore(
          protocolAddresses,
          context.multiProvider!,
          context.multiProtocolSigner!,
          context.multiProtocolProvider!,
        );
      }
    };

    initializeCore(ProtocolType.Ethereum);
    initializeCore(ProtocolType.Starknet);

    const messageBus = new MessageBus(context.multiProvider);

    log('Initialized Message Bus for cross-protocol communication');

    const initializeAdapter = (
      protocolType: ProtocolType.Ethereum | ProtocolType.Starknet,
      adapterName: string,
    ) => {
      const core = cores[protocolType];
      if (!core) return false;

      const protocolWhitelist: ChainMap<Address[]> = {};
      chainsByProtocol[protocolType].forEach((chain) => {
        if (whitelist[chain]) {
          protocolWhitelist[chain] = whitelist[chain];
        }
      });

      const adapter =
        protocolType === ProtocolType.Starknet
          ? new StarknetAdapter(core as StarknetCore, protocolWhitelist)
          : new EvmAdapter(core as HyperlaneCore, protocolWhitelist);

      messageBus.registerHandler(adapter);
      adapter.listenForMessages(messageBus);

      log(`${adapterName} adapter registered with Message Bus`);
      return true;
    };

    initializeAdapter(ProtocolType.Starknet, 'Starknet');
    initializeAdapter(ProtocolType.Ethereum, 'Hyperlane');

    log('Starknet relayer initialized successfully.');

    // Start the message bus
    messageBus.start();
    log('Message Bus started for cross-protocol communication');

    process.once('SIGINT', () => {
      log('Stopping relayers and message bus...');

      // Stop the message bus
      messageBus.stop();
      log('Message Bus stopped');

      process.exit(0);
    });
  },
};
