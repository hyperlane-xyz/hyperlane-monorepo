import { BigNumberish } from 'ethers';

import {
  AgentConfig,
  AgentSignerKeyType,
  ChainMap,
  MatchingList,
  chainMetadata,
} from '@hyperlane-xyz/sdk';
import { GasPaymentEnforcement } from '@hyperlane-xyz/sdk';
import { RelayerConfig as RelayerAgentConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { AgentAwsUser } from '../../agents/aws';
import { Role } from '../../roles';
import { HelmStatefulSetValues } from '../infrastructure';

import { AgentConfigHelper, KeyConfig, RootAgentConfig } from './agent';

export { GasPaymentEnforcement as GasPaymentEnforcementConfig } from '@hyperlane-xyz/sdk';

// Incomplete basic relayer agent config
export interface BaseRelayerConfig {
  gasPaymentEnforcement: GasPaymentEnforcement[];
  whitelist?: MatchingList;
  blacklist?: MatchingList;
  transactionGasLimit?: BigNumberish;
  skipTransactionGasLimitFor?: string[];
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
      relayChains: this.contextChainNames[Role.Relayer].join(','),
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

    return relayerConfig;
  }

  // Get the signer configuration for each chain by the chain name.
  async signers(): Promise<ChainMap<KeyConfig>> {
    if (this.aws) {
      const awsUser = new AgentAwsUser(
        this.runEnv,
        this.context,
        Role.Relayer,
        this.aws.region,
      );
      await awsUser.createIfNotExists();
      const awsKey = (await awsUser.createKeyIfNotExists(this)).keyConfig;
      return Object.fromEntries(
        this.contextChainNames[Role.Relayer].map((name) => {
          const chain = chainMetadata[name];
          // Sealevel chains always use hex keys
          if (chain?.protocol == ProtocolType.Sealevel) {
            return [name, { type: AgentSignerKeyType.Hex }];
          } else {
            return [name, awsKey];
          }
        }),
      );
    } else {
      return Object.fromEntries(
        this.contextChainNames[Role.Relayer].map((name) => [
          name,
          { type: AgentSignerKeyType.Hex },
        ]),
      );
    }
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
        originDomain: chainMetadata[source].chainId,
        senderAddress: routers[source].router,
        destinationDomain: chainMetadata[destination].chainId,
        recipientAddress: routers[destination].router,
      });
    }
  }

  return matchingList;
}
