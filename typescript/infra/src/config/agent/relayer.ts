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
  MatchingList,
  RelayerConfig as RelayerAgentConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  isValidAddressEvm,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  getChain,
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

// Incomplete basic relayer agent config
export interface BaseRelayerConfig {
  gasPaymentEnforcement: GasPaymentEnforcement[];
  whitelist?: MatchingList;
  blacklist?: MatchingList;
  addressBlacklist?: string;
  transactionGasLimit?: BigNumberish;
  skipTransactionGasLimitFor?: string[];
  metricAppContextsGetter?: () => MetricAppContext[];
}

// Full relayer-specific agent config for a single chain
export type RelayerConfig = Omit<RelayerAgentConfig, keyof AgentConfig>;
// Config intended to be set as configMap values, these are usually really long
// and are intended to derisk hitting max env var length limits.
export type RelayerConfigMapConfig = Pick<
  RelayerConfig,
  'addressBlacklist' | 'gasPaymentEnforcement' | 'metricAppContexts'
>;
// The rest of the config is intended to be set as env vars.
export type RelayerEnvConfig = Omit<
  RelayerConfig,
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
}

// See rust/main/helm/values.yaml for the full list of options and their defaults.
// This is at `.hyperlane.relayerChains` in the values file.
export interface HelmRelayerChainValues {
  name: string;
  signer: KeyConfig;
}

export class RelayerConfigHelper extends AgentConfigHelper<RelayerConfig> {
  readonly #relayerConfig: BaseRelayerConfig;
  readonly logger: Logger<never>;

  constructor(agentConfig: RootAgentConfig) {
    if (!agentConfig.relayer)
      throw Error('Relayer is not defined for this context');
    super(agentConfig, agentConfig.relayer);

    this.#relayerConfig = agentConfig.relayer;
    this.logger = rootLogger.child({ module: 'RelayerConfigHelper' });
  }

  async buildConfig(): Promise<RelayerConfig> {
    const baseConfig = this.#relayerConfig!;

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
      relayerConfig.metricAppContexts = JSON.stringify(
        baseConfig.metricAppContextsGetter(),
      );
    }

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
    const currencies = ['ARB', 'ETC', 'ETH', 'USDC', 'USDT'];

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

    return [...sanctionedEthereumAdresses, ...radiantExploiter];
  }

  // Returns whether the relayer requires AWS credentials
  get requiresAwsCredentials(): boolean {
    // If AWS is present on the agentConfig, we are using AWS keys and need credentials regardless.
    if (!this.aws) {
      console.warn(
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
