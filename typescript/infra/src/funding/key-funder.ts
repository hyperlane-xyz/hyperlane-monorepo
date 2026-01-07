import { join } from 'path';
import YAML from 'yaml';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';

import { Contexts } from '../../config/contexts.js';
import rebalancerAddresses from '../../config/rebalancer.json' with { type: 'json' };
import { getEnvAddresses } from '../../config/registry.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import {
  fetchLocalKeyAddresses,
  kathyAddresses,
  relayerAddresses,
} from '../agents/key-utils.js';
import { AgentContextConfig } from '../config/agent/agent.js';
import { DeployEnvironment, EnvironmentConfig } from '../config/environment.js';
import { ContextAndRolesMap, KeyFunderConfig } from '../config/funding.js';
import { FundableRole, Role } from '../roles.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath, isEthereumProtocolChain } from '../utils/utils.js';

export class KeyFunderHelmManager extends HelmManager {
  readonly helmReleaseName: string = 'key-funder';
  readonly helmChartPath: string = join(getInfraPath(), './helm/key-funder/');

  constructor(
    readonly config: KeyFunderConfig<string[]>,
    readonly agentConfig: AgentContextConfig,
    readonly registryCommit: string,
  ) {
    super();
  }

  static forEnvironment(
    environment: DeployEnvironment,
    registryCommit: string,
  ): KeyFunderHelmManager {
    const envConfig = getEnvironmentConfig(environment);
    const keyFunderConfig = getKeyFunderConfig(envConfig);
    const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
    return new KeyFunderHelmManager(
      keyFunderConfig,
      agentConfig,
      registryCommit,
    );
  }

  get namespace() {
    return this.config.namespace;
  }

  async helmValues() {
    const registryUri = `${DEFAULT_GITHUB_REGISTRY}/tree/${this.registryCommit}`;
    const keyfunderConfig = this.generateKeyfunderYaml();

    return {
      cronjob: {
        schedule: this.config.cronSchedule,
      },
      hyperlane: {
        runEnv: this.agentConfig.runEnv,
        chains: this.getEthereumChains(),
        registryUri,
        keyfunderConfig,
        chainsToSkip: this.config.chainsToSkip,
        skipIgpClaim: false,
      },
      image: {
        repository: 'gcr.io/abacus-labs-dev/hyperlane-keyfunder',
        tag: this.config.docker.tag,
      },
    };
  }

  private getEthereumChains(): string[] {
    return this.agentConfig.environmentChainNames.filter((chain) =>
      isEthereumProtocolChain(chain),
    );
  }

  private generateKeyfunderYaml(): string {
    const environment = this.agentConfig.runEnv;
    const chains: Record<string, ChainYamlConfig> = {};
    const envAddresses = getEnvAddresses(environment);

    for (const chain of this.getEthereumChains()) {
      if (this.config.chainsToSkip?.includes(chain)) continue;

      const chainConfig: ChainYamlConfig = {};

      const keys = this.getKeysForChain(chain, environment);
      if (keys.length > 0) {
        chainConfig.keys = keys;
      }

      const igpAddress = envAddresses[chain]?.interchainGasPaymaster;
      const igpThreshold = this.config.igpClaimThresholdPerChain?.[chain];
      if (igpAddress && igpThreshold) {
        chainConfig.igp = {
          address: igpAddress,
          claimThreshold: igpThreshold,
        };
      }

      const sweepThreshold = this.config.lowUrgencyKeyFunderBalances?.[chain];
      if (sweepThreshold && parseFloat(sweepThreshold) > 0) {
        const override = this.config.sweepOverrides?.[chain];
        chainConfig.sweep = {
          enabled: true,
          address:
            override?.sweepAddress ??
            '0x478be6076f31E9666123B9721D0B6631baD944AF',
          threshold: sweepThreshold,
          targetMultiplier: override?.targetMultiplier ?? 1.5,
          triggerMultiplier: override?.triggerMultiplier ?? 2.0,
        };
      }

      if (Object.keys(chainConfig).length > 0) {
        chains[chain] = chainConfig;
      }
    }

    const config = {
      version: '1' as const,
      chains,
      funder: {
        privateKeyEnvVar: 'FUNDER_PRIVATE_KEY',
      },
      metrics: {
        pushGateway: this.config.prometheusPushGateway,
        jobName: `keyfunder-${environment}`,
        labels: {
          environment,
        },
      },
      chainsToSkip: this.config.chainsToSkip,
    };

    return YAML.stringify(config);
  }

  private getKeysForChain(
    chain: string,
    environment: DeployEnvironment,
  ): KeyYamlConfig[] {
    const keys: KeyYamlConfig[] = [];
    const contextsAndRoles = this.config.contextsAndRolesToFund;

    for (const [contextStr, roles] of Object.entries(contextsAndRoles)) {
      const context = contextStr as Contexts;
      if (!roles) continue;

      for (const role of roles) {
        const address = this.getAddressForRole(environment, context, role);
        if (!address) continue;

        const desiredBalance = this.getDesiredBalanceForRole(chain, role);
        if (!desiredBalance || desiredBalance === '0') continue;

        keys.push({
          address,
          role: `${context}-${role}`,
          desiredBalance,
        });
      }
    }

    return keys;
  }

  private getAddressForRole(
    environment: DeployEnvironment,
    context: Contexts,
    role: FundableRole,
  ): string | undefined {
    const envAddresses = this.getRoleAddresses(role);
    return envAddresses?.[environment]?.[context];
  }

  private getRoleAddresses(
    role: FundableRole,
  ): Record<DeployEnvironment, Record<Contexts, string>> | undefined {
    switch (role) {
      case Role.Relayer:
        return relayerAddresses as Record<
          DeployEnvironment,
          Record<Contexts, string>
        >;
      case Role.Kathy:
        return kathyAddresses as Record<
          DeployEnvironment,
          Record<Contexts, string>
        >;
      case Role.Rebalancer:
        return rebalancerAddresses as Record<
          DeployEnvironment,
          Record<Contexts, string>
        >;
      default:
        return undefined;
    }
  }

  private getDesiredBalanceForRole(
    chain: string,
    role: FundableRole,
  ): string | undefined {
    switch (role) {
      case Role.Relayer:
        return this.config.desiredBalancePerChain[chain];
      case Role.Kathy:
        return this.config.desiredKathyBalancePerChain?.[chain];
      case Role.Rebalancer:
        return this.config.desiredRebalancerBalancePerChain?.[chain];
      default:
        return undefined;
    }
  }
}

interface KeyYamlConfig {
  address: string;
  role: string;
  desiredBalance: string;
}

interface ChainYamlConfig {
  keys?: KeyYamlConfig[];
  igp?: {
    address: string;
    claimThreshold: string;
  };
  sweep?: {
    enabled: boolean;
    address: string;
    threshold: string;
    targetMultiplier: number;
    triggerMultiplier: number;
  };
}

export function getKeyFunderConfig(
  coreConfig: EnvironmentConfig,
): KeyFunderConfig<string[]> {
  const keyFunderConfig = coreConfig.keyFunderConfig;
  if (!keyFunderConfig) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have a KeyFunderConfig config`,
    );
  }
  return keyFunderConfig;
}
