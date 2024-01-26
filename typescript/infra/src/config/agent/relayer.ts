import { BigNumberish } from 'ethers';

import {
  AgentConfig,
  AgentSignerKeyType,
  ChainMap,
  GasPaymentEnforcement,
  MatchingList,
  RelayerConfig as RelayerAgentConfig,
  chainMetadata,
  getDomainId,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, addressToBytes32 } from '@hyperlane-xyz/utils';

import { AgentAwsUser } from '../../agents/aws';
import { Role } from '../../roles';
import { HelmStatefulSetValues } from '../infrastructure';

import {
  AgentConfigHelper,
  KeyConfig,
  RootAgentConfig,
  defaultChainSignerKeyConfig,
} from './agent';

export { GasPaymentEnforcement as GasPaymentEnforcementConfig } from '@hyperlane-xyz/sdk';

export interface MetricAppContext {
  name: string;
  matchingList: MatchingList;
}

// Incomplete basic relayer agent config
export interface BaseRelayerConfig {
  gasPaymentEnforcement: GasPaymentEnforcement[];
  whitelist?: MatchingList;
  blacklist?: MatchingList;
  transactionGasLimit?: BigNumberish;
  skipTransactionGasLimitFor?: string[];
  metricAppContexts?: MetricAppContext[];
}

// Full relayer-specific agent config for a single chain
export type RelayerConfig = Omit<RelayerAgentConfig, keyof AgentConfig>;

// See rust/helm/values.yaml for the full list of options and their defaults.
// This is at `.hyperlane.relayer` in the values file.
export interface HelmRelayerValues extends HelmStatefulSetValues {
  aws: boolean;
  config?: RelayerConfig;
}

// See rust/helm/values.yaml for the full list of options and their defaults.
// This is at `.hyperlane.relayerChains` in the values file.
export interface HelmRelayerChainValues {
  name: string;
  signer: KeyConfig;
}

export class RelayerConfigHelper extends AgentConfigHelper<RelayerConfig> {
  readonly #relayerConfig: BaseRelayerConfig;

  constructor(agentConfig: RootAgentConfig) {
    if (!agentConfig.relayer)
      throw Error('Relayer is not defined for this context');
    super(agentConfig, agentConfig.relayer);
    this.#relayerConfig = agentConfig.relayer;
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
    if (baseConfig.transactionGasLimit) {
      relayerConfig.transactionGasLimit =
        baseConfig.transactionGasLimit.toString();
    }
    if (baseConfig.skipTransactionGasLimitFor) {
      relayerConfig.skipTransactionGasLimitFor =
        baseConfig.skipTransactionGasLimitFor.join(',');
    }
    if (baseConfig.metricAppContexts) {
      relayerConfig.metricAppContexts = JSON.stringify(
        baseConfig.metricAppContexts,
      );
    }

    return relayerConfig;
  }

  // Get the signer configuration for each chain by the chain name.
  async signers(): Promise<ChainMap<KeyConfig>> {
    let chainSigners: ChainMap<KeyConfig> = {};

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
        if (chainMetadata[chainName].protocol === ProtocolType.Ethereum) {
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

// Create a matching list for the given router addresses
export function routerMatchingList(
  routers: ChainMap<{ router: string }>,
): MatchingList {
  const chains = Object.keys(routers);

  // matching list must have at least one element so bypass and check before returning
  const matchingList: MatchingList = [];

  for (const source of chains) {
    for (const destination of chains) {
      if (source === destination) {
        continue;
      }

      matchingList.push({
        originDomain: getDomainId(chainMetadata[source]),
        senderAddress: addressToBytes32(routers[source].router),
        destinationDomain: getDomainId(chainMetadata[destination]),
        recipientAddress: addressToBytes32(routers[destination].router),
      });
    }
  }

  return matchingList;
}
