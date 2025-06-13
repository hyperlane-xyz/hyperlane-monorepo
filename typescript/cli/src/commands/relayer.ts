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

// Define supported protocols and their adapter names
const SUPPORTED_RELAYER_PROTOCOLS = [
  ProtocolType.Ethereum,
  ProtocolType.Starknet,
] as const;
type SupportedRelayerProtocol = (typeof SUPPORTED_RELAYER_PROTOCOLS)[number];

const ADAPTER_NAMES: Record<SupportedRelayerProtocol, string> = {
  [ProtocolType.Ethereum]: 'Hyperlane',
  [ProtocolType.Starknet]: 'Starknet',
};

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
  handler: async ({ context, chains, symbol, warp }) => {
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
    const chainsByProtocol: Partial<Record<ProtocolType, string[]>> = {};

    const cores: {
      [ProtocolType.Ethereum]?: HyperlaneCore;
      [ProtocolType.Starknet]?: StarknetCore;
    } = {};

    chainsArray.forEach((chain) => {
      const protocol: ProtocolType = context.multiProvider.getProtocol(chain);
      protocols.add(protocol);
      if (!chainsByProtocol[protocol]) {
        chainsByProtocol[protocol] = [];
      }
      chainsByProtocol[protocol]?.push(chain);
    });

    // Initialize cores based on protocols
    const initializeCore = (protocol: SupportedRelayerProtocol) => {
      if (!protocols.has(protocol) || !chainsByProtocol[protocol]) return;

      const protocolAddresses: ChainMap<any> = {};
      chainsByProtocol[protocol]!.forEach(
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

    const messageBus = new MessageBus(context.multiProvider);

    log('Initialized Message Bus for cross-protocol communication');

    const initializeAdapter = (
      protocolType: SupportedRelayerProtocol,
    ): string | false => {
      const adapterName = ADAPTER_NAMES[protocolType];

      // Ensure chains are configured for this protocol and protocol is active
      if (!chainsByProtocol[protocolType] || !protocols.has(protocolType)) {
        return false;
      }

      const core = cores[protocolType];
      if (!core) return false;

      const protocolWhitelist: ChainMap<Address[]> = {};
      chainsByProtocol[protocolType]!.forEach((chain) => {
        if (whitelist[chain]) {
          protocolWhitelist[chain] = whitelist[chain];
        }
      });

      const adapter: EvmAdapter | StarknetAdapter =
        protocolType === ProtocolType.Starknet
          ? new StarknetAdapter(core as StarknetCore, protocolWhitelist)
          : new EvmAdapter(core as HyperlaneCore, protocolWhitelist);

      messageBus.registerHandler(adapter);
      adapter.listenForMessages(messageBus);

      log(`${adapterName} adapter registered with Message Bus`);
      return adapterName;
    };

    const initializedAdapterNames: string[] = [];
    for (const protocol of SUPPORTED_RELAYER_PROTOCOLS) {
      if (protocols.has(protocol)) {
        // Check if the chain list includes this protocol
        initializeCore(protocol);
        const adapterNameResult = initializeAdapter(protocol);
        if (adapterNameResult) {
          initializedAdapterNames.push(adapterNameResult);
        }
      }
    }

    if (initializedAdapterNames.length > 0) {
      log(`Initialized ${initializedAdapterNames.join(' and ')} adapter(s).`);
    } else {
      log('No relayer adapters were initialized for the configured chains.');
    }

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
