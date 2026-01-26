import { BigNumberish } from 'ethers';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  AgentConfig,
  ChainMap,
  GasPaymentEnforcement,
  HyperlaneAddresses,
  HyperlaneAddressesMap,
  HyperlaneFactories,
  IsmCacheConfig,
  MatchingList,
  RelayerConfig as RelayerAgentConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  isValidAddressEvm,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  getChain,
  getChainAddresses,
  getDomainId,
  getWarpAddresses,
} from '../../../config/registry.js';
import { AgentAwsUser } from '../../agents/aws/user.js';
import { Role } from '../../roles.js';
import { HelmStatefulSetValues } from '../infrastructure.js';

import {
  AgentConfigHelper,
  KeyConfig,
  RootAgentConfig,
  defaultChainSignerKeyConfig,
} from './agent.js';

export interface MetricAppContext {
  name: string;
  matchingList: MatchingList;
}

export interface RelayerMixingConfig {
  enabled: boolean;
  salt?: number;
}

export interface RelayerCacheConfig {
  enabled: boolean;
  defaultExpirationSeconds?: number;
}

export interface RelayerBatchConfig {
  bypassBatchSimulation?: boolean;
  defaultBatchSize?: number;
  batchSizeOverrides?: ChainMap<number>;
  maxSubmitQueueLength?: ChainMap<number>;
}

// Incomplete basic relayer agent config
export interface BaseRelayerConfig {
  gasPaymentEnforcement: GasPaymentEnforcement[];
  whitelist?: MatchingList;
  blacklist?: MatchingList;
  addressBlacklist?: string;
  transactionGasLimit?: BigNumberish;
  skipTransactionGasLimitFor?: string[];
  metricAppContextsGetter?: () => MetricAppContext[];
  ismCacheConfigs?: Array<IsmCacheConfig>;
  dbBootstrap?: boolean;
  mixing?: RelayerMixingConfig;
  environmentVariableEndpointEnabled?: boolean;
  cache?: RelayerCacheConfig;
  batch?: RelayerBatchConfig;
  txIdIndexingEnabled?: boolean;
  igpIndexingEnabled?: boolean;
}

// Full relayer-specific agent config for a single chain
export type RelayerConfig = Omit<RelayerAgentConfig, keyof AgentConfig>;
// Config intended to be set as configMap values, these are usually really long
// and are intended to derisk hitting max env var length limits.
export type RelayerConfigMapConfig = Pick<
  RelayerConfig,
  'addressBlacklist' | 'gasPaymentEnforcement' | 'ismCacheConfigs'
>;
// Config that will be embedded into relayer docker image because
// of its large size.
export type RelayerAppContextConfig = Pick<RelayerConfig, 'metricAppContexts'>;
// The rest of the config is intended to be set as env vars.
export type RelayerEnvConfig = Omit<
  Omit<RelayerConfig, keyof RelayerAppContextConfig>,
  keyof RelayerConfigMapConfig
>;

// See rust/main/helm/values.yaml for the full list of options and their defaults.
// This is at `.hyperlane.relayer` in the values file.
export interface HelmRelayerValues extends HelmStatefulSetValues {
  aws: boolean;
  // Config intended to be set as env vars
  envConfig?: RelayerEnvConfig;
  // Config intended to be set as configMap values
  configMapConfig?: RelayerConfigMapConfig;
  // Config for setting up the database
  dbBootstrap?: RelayerDbBootstrapConfig;
  // Config for setting up the mixing service
  mixing?: RelayerMixingConfig;
  // Config for the environment variable endpoint
  environmentVariableEndpointEnabled?: boolean;
  // Config for the cache
  cacheDefaultExpirationSeconds?: number;
}

export interface RelayerDbBootstrapConfig {
  enabled: boolean;
  bucket: string;
  object_targz: string;
}

// See rust/main/helm/values.yaml for the full list of options and their defaults.
// This is at `.hyperlane.relayerChains` in the values file.
export interface HelmRelayerChainValues {
  name: string;
  signer: KeyConfig;
}

export class RelayerConfigHelper extends AgentConfigHelper<RelayerConfig> {
  readonly relayerConfig: BaseRelayerConfig;
  readonly logger: Logger<never>;

  constructor(agentConfig: RootAgentConfig) {
    if (!agentConfig.relayer)
      throw Error('Relayer is not defined for this context');
    super(agentConfig, agentConfig.relayer);

    this.relayerConfig = agentConfig.relayer;
    this.logger = rootLogger.child({ module: 'RelayerConfigHelper' });
  }

  async buildConfig(): Promise<RelayerConfig> {
    const baseConfig = this.relayerConfig!;

    const relayerConfig: RelayerConfig = {
      relayChains: this.relayChains.join(','),
      gasPaymentEnforcement: JSON.stringify(baseConfig.gasPaymentEnforcement),
    };

    if (baseConfig.whitelist) {
      relayerConfig.whitelist = JSON.stringify(baseConfig.whitelist);
    }
    if (baseConfig.blacklist) {
      relayerConfig.blacklist = JSON.stringify(baseConfig.blacklist);
    }

    relayerConfig.addressBlacklist = (await this.getSanctionedAddresses()).join(
      ',',
    );

    if (baseConfig.transactionGasLimit) {
      relayerConfig.transactionGasLimit =
        baseConfig.transactionGasLimit.toString();
    }
    if (baseConfig.skipTransactionGasLimitFor) {
      relayerConfig.skipTransactionGasLimitFor =
        baseConfig.skipTransactionGasLimitFor.join(',');
    }
    if (baseConfig.metricAppContextsGetter) {
      relayerConfig.metricAppContexts = baseConfig.metricAppContextsGetter();
    }
    if (baseConfig.ismCacheConfigs) {
      relayerConfig.ismCacheConfigs = baseConfig.ismCacheConfigs;
    }
    relayerConfig.allowContractCallCaching = baseConfig.cache?.enabled ?? false;
    relayerConfig.txIdIndexingEnabled = baseConfig.txIdIndexingEnabled ?? true;
    relayerConfig.igpIndexingEnabled = baseConfig.igpIndexingEnabled ?? true;

    return relayerConfig;
  }

  // Get the signer configuration for each chain by the chain name.
  async signers(): Promise<ChainMap<KeyConfig>> {
    const chainSigners: ChainMap<KeyConfig> = {};

    if (this.aws) {
      const awsUser = new AgentAwsUser(
        this.runEnv,
        this.context,
        Role.Relayer,
        this.aws.region,
      );
      await awsUser.createIfNotExists();
      const awsKey = (await awsUser.createKeyIfNotExists(this)).keyConfig;

      // AWS keys only work for Ethereum chains
      for (const chainName of this.relayChains) {
        if (getChain(chainName).protocol === ProtocolType.Ethereum) {
          chainSigners[chainName] = awsKey;
        }
      }
    }

    // For any chains that were not configured with AWS keys, fill in the defaults
    for (const chainName of this.relayChains) {
      if (chainSigners[chainName] !== undefined) {
        continue;
      }
      chainSigners[chainName] = defaultChainSignerKeyConfig(chainName);
    }

    return chainSigners;
  }

  async getSanctionedAddresses() {
    // All Ethereum-style addresses from https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses/tree/lists
    const currencies = ['ARB', 'BSC', 'ETC', 'ETH', 'USDC', 'USDT'];

    const schema = z.array(z.string());

    const allSanctionedAddresses = await Promise.all(
      currencies.map(async (currency) => {
        const rawUrl = `https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_${currency}.json`;
        this.logger.debug(
          {
            currency,
            rawUrl,
          },
          'Fetching sanctioned addresses',
        );
        const json = await fetch(rawUrl);
        const sanctionedAddresses = schema.parse(await json.json());
        return sanctionedAddresses;
      }),
    );

    const sanctionedEthereumAdresses = allSanctionedAddresses
      .flat()
      .filter((address) => {
        if (!isValidAddressEvm(address)) {
          this.logger.debug(
            { address },
            'Invalid sanctioned address, throwing out',
          );
          return false;
        }
        return true;
      });

    const radiantExploiter = [
      '0xA0e768A68ba1BFffb9F4366dfC8D9195EE7217d1',
      '0x0629b1048298AE9deff0F4100A31967Fb3f98962',
      '0x97a05beCc2e7891D07F382457Cd5d57FD242e4e8',
    ];

    const flowAddresses = [
      '0x9D9247F5C3F3B78F7EE2C480B9CDaB91393Bf4D6',
      '0x2e7C4b71397f10c93dC0C2ba6f8f179A47F994e1',
      '0x00000000000000000000000235aE95896583818d',
    ];

    const uniqueAddresses = new Set(
      [
        ...sanctionedEthereumAdresses,
        ...radiantExploiter,
        ...flowAddresses,
      ].map((address) => address.toLowerCase()),
    );

    return Array.from(uniqueAddresses);
  }

  // Returns whether the relayer requires AWS credentials
  get requiresAwsCredentials(): boolean {
    // If AWS is present on the agentConfig, we are using AWS keys and need credentials regardless.
    if (!this.aws) {
      this.logger.warn(
        `Relayer does not have AWS credentials. Be sure this is a non-k8s-based environment!`,
      );
      return false;
    }

    return true;
  }

  get role(): Role {
    return Role.Relayer;
  }

  get relayChains(): Array<string> {
    return this.contextChainNames[Role.Relayer];
  }
}

// Gets the matching list for the given warp route using addresses from the registry.
export function warpRouteMatchingList(warpRouteId: string): MatchingList {
  return matchingList(getWarpAddresses(warpRouteId));
}

export function routerMatchingList(
  routers: ChainMap<{ router: Address }>,
): MatchingList {
  return matchingList(routers);
}

// Create a matching list for the given senders to any destination or recipient
export function senderMatchingList(
  senders: ChainMap<{ sender: Address }>,
): MatchingList {
  return Object.entries(senders).map(([chain, { sender }]) => ({
    originDomain: getDomainId(chain),
    senderAddress: addressToBytes32(sender),
    destinationDomain: '*',
    recipientAddress: '*',
  }));
}

// A matching list to match messages sent to or from the given address
// between any chains.
export function consistentSenderRecipientMatchingList(
  address: Address,
): MatchingList {
  return [
    {
      originDomain: '*',
      senderAddress: addressToBytes32(address),
      destinationDomain: '*',
      recipientAddress: '*',
    },
    {
      originDomain: '*',
      senderAddress: '*',
      destinationDomain: '*',
      recipientAddress: addressToBytes32(address),
    },
  ];
}

export function chainMapMatchingList(
  chainMap: ChainMap<Address>,
): MatchingList {
  // Convert to a router matching list
  const routers = objMap(chainMap, (chain, address) => ({
    router: address,
  }));
  return routerMatchingList(routers);
}

// Create a matching list for the given contract addresses
export function matchingList<F extends HyperlaneFactories>(
  addressesMap: HyperlaneAddressesMap<F>,
): MatchingList {
  const chains = Object.keys(addressesMap);

  // matching list must have at least one element so bypass and check before returning
  const matchingList: MatchingList = [];

  for (const source of chains) {
    for (const destination of chains) {
      if (source === destination) {
        continue;
      }

      const uniqueAddresses = (addresses: HyperlaneAddresses<F>) =>
        Array.from(new Set(Object.values(addresses)).values()).map((s) =>
          addressToBytes32(s),
        );

      matchingList.push({
        originDomain: getDomainId(source),
        senderAddress: uniqueAddresses(addressesMap[source]),
        destinationDomain: getDomainId(destination),
        recipientAddress: uniqueAddresses(addressesMap[destination]),
      });
    }
  }

  return matchingList;
}

/**
 * ICA Message Types from InterchainAccountMessage.sol
 */
export enum IcaMessageType {
  /** Execute calls on remote ICA */
  CALLS = 0,
  /** Commit to future calls */
  COMMITMENT = 1,
  /** Reveal ISM and commitment (different format, no owner/salt) */
  REVEAL = 2,
}

/**
 * Options for matching ICA message body fields.
 * All fields are optional - omit fields you don't want to match on.
 *
 * Reference: solidity/contracts/middleware/libs/InterchainAccountMessage.sol
 */
export interface IcaBodyMatchOptions {
  /**
   * MessageType (byte 0).
   * Use IcaMessageType enum for type safety.
   */
  messageType?: IcaMessageType;
  /** ICA owner address (bytes 1-33). Not present in REVEAL messages. */
  owner?: Address;
  /** ICA ISM address (bytes 33-65 for CALLS/COMMITMENT, bytes 1-33 for REVEAL) */
  ism?: Address;
  /** User salt (bytes 65-97). Not present in REVEAL messages. */
  salt?: string;
}

/**
 * Create a matching list for Interchain Account (ICA) messages with flexible body field matching.
 *
 * This function creates a matching list that:
 * 1. Matches messages where the body fields equal the specified values for the origin chain
 * 2. Filters by ICA router addresses as sender/recipient (fetched from registry)
 * 3. Only matches on fields that are provided (all fields are optional)
 */
export function icaMatchingList(
  icaMatchers: ChainMap<IcaBodyMatchOptions>,
): MatchingList {
  const chainAddresses = getChainAddresses();
  const matchingList: MatchingList = [];

  // Get all chains that have matchers defined
  const chains = Object.keys(icaMatchers);

  for (const source of chains) {
    // Get the ICA router address from the registry
    const sourceRouter = chainAddresses[source]?.interchainAccountRouter;
    if (!sourceRouter) {
      throw new Error(
        `No ICA router found for chain ${source} in registry. Cannot create ICA matching list.`,
      );
    }

    const matcher = icaMatchers[source];

    // Validate that REVEAL messages don't specify owner or salt
    if (matcher.messageType === IcaMessageType.REVEAL) {
      if (matcher.owner !== undefined) {
        throw new Error(
          `Chain ${source}: REVEAL messages do not have an owner field. Remove 'owner' from IcaBodyMatchOptions.`,
        );
      }
      if (matcher.salt !== undefined) {
        throw new Error(
          `Chain ${source}: REVEAL messages do not have a salt field. Remove 'salt' from IcaBodyMatchOptions.`,
        );
      }
    }

    // Build regex pattern based on message type and which fields are provided
    let bodyRegex = '^';

    // Byte 0: MessageType (2 hex chars)
    if (matcher.messageType !== undefined) {
      // Convert number to 2-digit hex
      const typeHex = matcher.messageType.toString(16).padStart(2, '0');
      bodyRegex += typeHex;
    } else {
      bodyRegex += '.{2}'; // Any 2 hex chars
    }

    // Different layouts based on message type
    if (matcher.messageType === IcaMessageType.REVEAL) {
      // REVEAL format: [0:1] type, [1:33] ISM, [33:65] commitment
      // Bytes 1-33: ICA ISM (64 hex chars for bytes32)
      if (matcher.ism !== undefined) {
        const ismBytes32 = addressToBytes32(matcher.ism).toLowerCase();
        const ismHex = ismBytes32.replace(/^0x/, '');
        bodyRegex += ismHex;
      } else {
        bodyRegex += '.{64}'; // Any 64 hex chars
      }
      // Note: owner and salt don't exist in REVEAL messages
    } else {
      // CALLS/COMMITMENT format: [0:1] type, [1:33] owner, [33:65] ISM, [65:97] salt, [97:??] data
      // Bytes 1-33: ICA owner (64 hex chars for bytes32)
      if (matcher.owner !== undefined) {
        const ownerBytes32 = addressToBytes32(matcher.owner).toLowerCase();
        const ownerHex = ownerBytes32.replace(/^0x/, '');
        bodyRegex += ownerHex;
      } else {
        bodyRegex += '.{64}'; // Any 64 hex chars
      }

      // Bytes 33-65: ICA ISM (64 hex chars for bytes32)
      if (matcher.ism !== undefined) {
        const ismBytes32 = addressToBytes32(matcher.ism).toLowerCase();
        const ismHex = ismBytes32.replace(/^0x/, '');
        bodyRegex += ismHex;
      } else {
        bodyRegex += '.{64}'; // Any 64 hex chars
      }

      // Bytes 65-97: User Salt (64 hex chars for bytes32)
      if (matcher.salt !== undefined) {
        const saltHex = matcher.salt.toLowerCase().replace(/^0x/, '');
        bodyRegex += saltHex;
      }
      // Note: We don't add .{64} if salt is not provided, as we may want to match
      // messages regardless of what comes after
    }

    for (const destination of chains) {
      if (source === destination) {
        continue;
      }

      // Get the ICA router address from the registry
      const destinationRouter =
        chainAddresses[destination]?.interchainAccountRouter;
      if (!destinationRouter) {
        throw new Error(
          `No ICA router found for chain ${destination} in registry. Cannot create ICA matching list.`,
        );
      }

      matchingList.push({
        originDomain: getDomainId(source),
        senderAddress: addressToBytes32(sourceRouter),
        destinationDomain: getDomainId(destination),
        recipientAddress: addressToBytes32(destinationRouter),
        bodyRegex,
      });
    }
  }

  return matchingList;
}
